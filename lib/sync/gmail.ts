import { Prisma, SyncProvider, DocumentSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { GMAIL_API_BASE_URL } from "@/lib/google/config";
import { getGoogleAccessToken } from "@/lib/google/token";
import { generateEmbeddingVector } from "@/lib/embeddings";
import { evaluateInstructionsForEvent } from "@/lib/instructions";

type GmailMessageHeader = {
  name: string;
  value: string;
};

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
  };
  parts?: GmailMessagePart[];
};

type GmailMessagePayload = {
  headers?: GmailMessageHeader[];
  mimeType?: string;
  body?: {
    data?: string;
  };
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailMessagePayload;
};

type GmailListResponse = {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
  nextPageToken?: string;
};

type NormalisedEmail = {
  gmailMessageId: string;
  gmailThreadId: string;
  historyId?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  internalDate?: Date;
  headers: GmailMessageHeader[];
  labelIds: string[];
};

type SyncOptions = {
  labelIds?: string[];
  backfillLookbackDays?: number;
  maxPages?: number;
  pageSize?: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 3;
const RESOURCE_ID = "primary";

export async function syncGmailMailbox(userId: string, options?: SyncOptions) {
  const { accessToken } = await getGoogleAccessToken(userId);
  const syncState = await prisma.syncState.findUnique({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.gmail,
        resourceId: RESOURCE_ID,
      },
    },
  });

  const labelIds = options?.labelIds ?? ["INBOX"]; // sync inbox by default
  const lookbackDays = options?.backfillLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options?.maxPages ?? MAX_PAGES;

  const queryParts = ["in:anywhere"];

  const sinceDate = syncState?.lastSyncAt ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const afterParam = Math.floor(sinceDate.getTime() / 1000);
  queryParts.push(`after:${afterParam}`);

  const query = queryParts.join(" ");

  let pageToken: string | undefined;
  let pageCount = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let latestHistoryId = syncState?.cursor ?? undefined;

  do {
    const listUrl = new URL(`${GMAIL_API_BASE_URL}/users/me/messages`);
    listUrl.searchParams.set("maxResults", String(pageSize));
    listUrl.searchParams.set("q", query);
    if (pageToken) {
      listUrl.searchParams.set("pageToken", pageToken);
    }
    if (labelIds.length) {
      labelIds.forEach((id) => listUrl.searchParams.append("labelIds", id));
    }

    const listResponse = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      throw new Error(`Failed to list Gmail messages: ${errorText || listResponse.statusText}`);
    }

    const payload = (await listResponse.json()) as GmailListResponse;
    const messages = payload.messages ?? [];

    for (const summary of messages) {
      const detail = await fetchGmailMessage(accessToken, summary.id);
      if (!detail) {
        continue;
      }

      const normalised = normaliseGmailMessage(detail);

      if (!normalised) {
        continue;
      }

      let embedding: number[] | null = null;
      if (normalised.bodyText && normalised.bodyText.trim()) {
        try {
          embedding = await generateEmbeddingVector(normalised.bodyText);
        } catch (error) {
          console.warn(`Failed to generate embedding for Gmail message ${normalised.gmailMessageId}:`, error);
        }
      }

      const result = await persistEmailMessage(userId, normalised, embedding);
      processed += 1;
      if (result === "created") {
        created += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "gmail.message_created",
          payload: {
            messageId: normalised.gmailMessageId,
            threadId: normalised.gmailThreadId,
            subject: normalised.subject,
            from: normalised.from,
            internalDate: normalised.internalDate?.toISOString(),
          },
        });
      } else if (result === "updated") {
        updated += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "gmail.message_updated",
          payload: {
            messageId: normalised.gmailMessageId,
            threadId: normalised.gmailThreadId,
            subject: normalised.subject,
            from: normalised.from,
            internalDate: normalised.internalDate?.toISOString(),
          },
        });
      }

      if (normalised.historyId) {
        if (!latestHistoryId) {
          latestHistoryId = normalised.historyId;
        } else if (BigInt(normalised.historyId) > BigInt(latestHistoryId)) {
          latestHistoryId = normalised.historyId;
        }
      }
    }

    pageToken = payload.nextPageToken;
    pageCount += 1;
  } while (pageToken && pageCount < maxPages);

  await prisma.syncState.upsert({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.gmail,
        resourceId: RESOURCE_ID,
      },
    },
    create: {
      userId,
      provider: SyncProvider.gmail,
      resourceId: RESOURCE_ID,
      lastSyncAt: new Date(),
      cursor: latestHistoryId,
      metadata: {
        labelIds,
        query,
      } satisfies Prisma.JsonValue,
    },
    update: {
      lastSyncAt: new Date(),
      cursor: latestHistoryId,
      metadata: {
        labelIds,
        query,
      } satisfies Prisma.JsonValue,
      updatedAt: new Date(),
    },
  });

  return {
    processed,
    created,
    updated,
  };
}

export async function ingestGmailMessage(userId: string, messageId: string) {
  const { accessToken } = await getGoogleAccessToken(userId);
  const detail = await fetchGmailMessage(accessToken, messageId);

  if (!detail) {
    throw new Error(`Gmail message ${messageId} could not be loaded`);
  }

  const normalised = normaliseGmailMessage(detail);

  if (!normalised) {
    throw new Error(`Gmail message ${messageId} is missing required fields`);
  }

  let embedding: number[] | null = null;
  if (normalised.bodyText && normalised.bodyText.trim()) {
    try {
      embedding = await generateEmbeddingVector(normalised.bodyText);
    } catch (error) {
      console.warn(`Failed to generate embedding for Gmail message ${normalised.gmailMessageId}:`, error);
    }
  }

  await persistEmailMessage(userId, normalised, embedding);

  await evaluateInstructionsForEvent(userId, {
    type: "gmail.message_sent",
    payload: {
      messageId: normalised.gmailMessageId,
      threadId: normalised.gmailThreadId,
      subject: normalised.subject,
      to: normalised.to,
    },
  });

  return {
    messageId: normalised.gmailMessageId,
    threadId: normalised.gmailThreadId,
  };
}

async function fetchGmailMessage(accessToken: string, messageId: string) {
  const url = `${GMAIL_API_BASE_URL}/users/me/messages/${messageId}?format=full`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    console.warn(`Failed to fetch Gmail message ${messageId}: ${text || response.statusText}`);
    return null;
  }

  return (await response.json()) as GmailMessage;
}

function normaliseGmailMessage(message: GmailMessage): NormalisedEmail | null {
  if (!message || !message.id) {
    return null;
  }

  const headers = message.payload?.headers ?? [];
  const subject = getHeader(headers, "Subject");
  const from = getHeader(headers, "From");
  const to = splitAddresses(getHeader(headers, "To"));
  const cc = splitAddresses(getHeader(headers, "Cc"));
  const bcc = splitAddresses(getHeader(headers, "Bcc"));
  const internalDate = message.internalDate ? new Date(Number(message.internalDate)) : undefined;

  const bodies = extractBodies(message.payload);

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    historyId: message.historyId,
    subject: subject ?? undefined,
    snippet: message.snippet ?? undefined,
    bodyText: bodies.text || bodies.htmlText,
    bodyHtml: bodies.html,
    from: from ?? undefined,
    to,
    cc,
    bcc,
    internalDate,
    headers,
    labelIds: message.labelIds ?? [],
  };
}

function extractBodies(payload?: GmailMessagePayload) {
  const result = {
    text: "",
    html: "",
    htmlText: "",
  };

  if (!payload) {
    return result;
  }

  const stack: GmailMessagePart[] = [];
  if (payload) {
    stack.push({ ...payload });
  }

  while (stack.length) {
    const part = stack.pop();
    if (!part) {
      continue;
    }

    if (part.parts && part.parts.length) {
      for (const child of part.parts) {
        stack.push(child);
      }
    }

    if (!part.mimeType || !part.body?.data) {
      continue;
    }

    const decoded = decodeBase64(part.body.data);

    if (part.mimeType === "text/plain") {
      if (decoded) {
        result.text = result.text ? `${result.text}\n${decoded}` : decoded;
      }
    } else if (part.mimeType === "text/html") {
      if (decoded) {
        result.html = result.html ? `${result.html}\n${decoded}` : decoded;
        result.htmlText = result.htmlText ? `${result.htmlText}\n${stripHtml(decoded)}` : stripHtml(decoded);
      }
    }
  }

  if (!result.text && payload.body?.data) {
    const decoded = decodeBase64(payload.body.data);
    result.text = decoded;
  }

  return result;
}

function stripHtml(input: string) {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function getHeader(headers: GmailMessageHeader[], name: string) {
  const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function splitAddresses(value: string | null | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function decodeBase64(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

async function persistEmailMessage(userId: string, message: NormalisedEmail, embedding: number[] | null) {
  const existing = await prisma.emailMessage.findUnique({
    where: {
      userId_gmailMessageId: {
        userId,
        gmailMessageId: message.gmailMessageId,
      },
    },
  });

  const subject = message.subject ?? message.snippet ?? "Untitled email";
  const metadata = {
    headers: message.headers,
    labelIds: message.labelIds,
    from: message.from ?? null,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
  } satisfies Prisma.JsonValue;

  const bodyForChunk = message.bodyText ?? "";

  await prisma.$transaction(async (tx) => {
    const thread = await tx.emailThread.upsert({
      where: {
        userId_gmailThreadId: {
          userId,
          gmailThreadId: message.gmailThreadId,
        },
      },
      create: {
        userId,
        gmailThreadId: message.gmailThreadId,
        subject: message.subject ?? undefined,
        snippet: message.snippet ?? undefined,
        historyId: message.historyId ?? undefined,
        lastMessageAt: message.internalDate ?? undefined,
        metadata,
      },
      update: {
        subject: message.subject ?? undefined,
        snippet: message.snippet ?? undefined,
        historyId: message.historyId ?? undefined,
        lastMessageAt: message.internalDate ?? undefined,
        metadata,
      },
    });

    await tx.emailMessage.upsert({
      where: {
        userId_gmailMessageId: {
          userId,
          gmailMessageId: message.gmailMessageId,
        },
      },
      create: {
        userId,
        threadId: thread.id,
        gmailMessageId: message.gmailMessageId,
        internalDate: message.internalDate ?? undefined,
        fromAddress: message.from ?? undefined,
        toAddresses: message.to?.join(", ") ?? undefined,
        ccAddresses: message.cc?.join(", ") ?? undefined,
        bccAddresses: message.bcc?.join(", ") ?? undefined,
        subject: message.subject ?? undefined,
        snippet: message.snippet ?? undefined,
        bodyText: message.bodyText ?? undefined,
        bodyHtml: message.bodyHtml ?? undefined,
        metadata,
      },
      update: {
        threadId: thread.id,
        internalDate: message.internalDate ?? undefined,
        fromAddress: message.from ?? undefined,
        toAddresses: message.to?.join(", ") ?? undefined,
        ccAddresses: message.cc?.join(", ") ?? undefined,
        bccAddresses: message.bcc?.join(", ") ?? undefined,
        subject: message.subject ?? undefined,
        snippet: message.snippet ?? undefined,
        bodyText: message.bodyText ?? undefined,
        bodyHtml: message.bodyHtml ?? undefined,
        metadata,
      },
    });

    const document = await tx.document.upsert({
      where: {
        userId_sourceType_sourceId: {
          userId,
          sourceType: DocumentSourceType.emailMessage,
          sourceId: message.gmailMessageId,
        },
      },
      create: {
        userId,
        sourceType: DocumentSourceType.emailMessage,
        sourceId: message.gmailMessageId,
        title: subject,
        description: message.snippet ?? undefined,
        metadata,
      },
      update: {
        title: subject,
        description: message.snippet ?? undefined,
        metadata,
      },
    });

    const chunk = await tx.documentChunk.upsert({
      where: {
        documentId_position: {
          documentId: document.id,
          position: 0,
        },
      },
      create: {
        documentId: document.id,
        userId,
        position: 0,
        content: bodyForChunk,
        metadata,
      },
      update: {
        content: bodyForChunk,
        metadata,
      },
    });

    if (embedding) {
      await tx.vectorEmbedding.upsert({
        where: {
          chunkId_strategy: {
            chunkId: chunk.id,
            strategy: "openai-text-embedding-3-large",
          },
        },
        create: {
          chunkId: chunk.id,
          userId,
          strategy: "openai-text-embedding-3-large",
          embedding,
        },
        update: {
          embedding,
        },
      });
    }
  });

  return existing ? "updated" : "created";
}
