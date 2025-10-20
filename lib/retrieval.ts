import { Prisma, DocumentSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { generateEmbeddingVector, cosineSimilarity } from "@/lib/embeddings";

const DEFAULT_EMAIL_LIMIT = 5;
const DEFAULT_CALENDAR_LIMIT = 5;
const DEFAULT_CONTACT_LIMIT = 5;

export type EmailSnippet = {
  messageId: string;
  subject: string | null;
  snippet: string;
  from: string | null;
  sentAt: string | null;
  similarity?: number;
};

export type CalendarSnippet = {
  eventId: string;
  summary: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  similarity?: number;
};

export type HubspotContactSnippet = {
  contactId: string;
  fullName: string | null;
  email: string | null;
  company: string | null;
  phone: string | null;
  lifecycleStage: string | null;
  lastModifiedAt: string | null;
  similarity?: number;
};

export type RetrievalContext = {
  emailSnippets: EmailSnippet[];
  calendarSnippets: CalendarSnippet[];
  hubspotContacts: HubspotContactSnippet[];
};

type VectorMatch = {
  documentId: string;
  sourceId: string | null;
  sourceType: DocumentSourceType;
  content: string;
  metadata: Prisma.JsonValue | null;
  similarity: number;
};

type RetrievalOptions = {
  emailLimit?: number;
  calendarLimit?: number;
  contactLimit?: number;
};

export async function buildRetrievalContextForPrompt(userId: string, query: string, options?: RetrievalOptions): Promise<RetrievalContext> {
  const emailLimit = options?.emailLimit ?? DEFAULT_EMAIL_LIMIT;
  const calendarLimit = options?.calendarLimit ?? DEFAULT_CALENDAR_LIMIT;
  const contactLimit = options?.contactLimit ?? DEFAULT_CONTACT_LIMIT;

  const embedding = await safeGenerateEmbedding(query);

  const emailSnippets = embedding
    ? await buildEmailSnippetsFromVectors(userId, embedding, emailLimit)
    : await loadRecentEmailSnippets(userId, emailLimit);

  const calendarSnippets = embedding
    ? await buildCalendarSnippetsFromVectors(userId, embedding, calendarLimit)
    : await loadUpcomingCalendarSnippets(userId, calendarLimit);

  const hubspotContacts = embedding
    ? await buildHubspotContactsFromVectors(userId, embedding, contactLimit)
    : await loadRecentHubspotContacts(userId, contactLimit);

  return {
    emailSnippets,
    calendarSnippets,
    hubspotContacts,
  };
}

async function buildEmailSnippetsFromVectors(userId: string, embedding: number[], limit: number) {
  const matches = await findVectorMatches(userId, embedding, [DocumentSourceType.emailMessage], limit * 3);
  if (!matches.length) {
    return loadRecentEmailSnippets(userId, limit);
  }

  const ids = matches
    .map((match) => match.sourceId)
    .filter((id): id is string => Boolean(id))
    .slice(0, limit * 2);

  const messages = await prisma.emailMessage.findMany({
    where: {
      userId,
      gmailMessageId: {
        in: ids,
      },
    },
  });

  const messageMap = new Map(messages.map((message) => [message.gmailMessageId, message]));

  const snippets: EmailSnippet[] = [];
  for (const match of matches) {
    if (!match.sourceId) {
      continue;
    }
    const record = messageMap.get(match.sourceId);
    if (!record) {
      continue;
    }
    snippets.push({
      messageId: match.sourceId,
      subject: record.subject,
      snippet: buildEmailSnippetText(record, match.content),
      from: record.fromAddress,
      sentAt: record.internalDate?.toISOString() ?? null,
      similarity: match.similarity,
    });
    if (snippets.length >= limit) {
      break;
    }
  }

  if (!snippets.length) {
    return loadRecentEmailSnippets(userId, limit);
  }

  return snippets;
}

async function buildCalendarSnippetsFromVectors(userId: string, embedding: number[], limit: number) {
  const matches = await findVectorMatches(userId, embedding, [DocumentSourceType.calendarEvent], limit * 3);
  if (!matches.length) {
    return loadUpcomingCalendarSnippets(userId, limit);
  }

  const ids = matches
    .map((match) => match.sourceId)
    .filter((id): id is string => Boolean(id))
    .slice(0, limit * 2);

  const events = await prisma.calendarEvent.findMany({
    where: {
      userId,
      id: {
        in: ids,
      },
    },
  });

  const eventMap = new Map(events.map((event) => [event.id, event]));

  const snippets: CalendarSnippet[] = [];
  for (const match of matches) {
    if (!match.sourceId) {
      continue;
    }
    const event = eventMap.get(match.sourceId);
    if (!event) {
      continue;
    }

    snippets.push({
      eventId: event.eventId,
      summary: event.summary,
      startTime: event.startTime?.toISOString() ?? null,
      endTime: event.endTime?.toISOString() ?? null,
      location: event.location ?? null,
      description: event.description ?? null,
      similarity: match.similarity,
    });

    if (snippets.length >= limit) {
      break;
    }
  }

  if (!snippets.length) {
    return loadUpcomingCalendarSnippets(userId, limit);
  }

  return snippets;
}

async function buildHubspotContactsFromVectors(userId: string, embedding: number[], limit: number) {
  const matches = await findVectorMatches(userId, embedding, [DocumentSourceType.hubspotContact], limit * 3);
  if (!matches.length) {
    return loadRecentHubspotContacts(userId, limit);
  }

  const ids = matches
    .map((match) => match.sourceId)
    .filter((id): id is string => Boolean(id))
    .slice(0, limit * 2);

  const contacts = await prisma.hubspotContact.findMany({
    where: {
      userId,
      contactId: {
        in: ids,
      },
    },
  });

  const contactMap = new Map(contacts.map((contact) => [contact.contactId, contact]));

  const snippets: HubspotContactSnippet[] = [];
  for (const match of matches) {
    if (!match.sourceId) {
      continue;
    }
    const contact = contactMap.get(match.sourceId);
    if (!contact) {
      continue;
    }

    snippets.push({
      contactId: contact.contactId,
      fullName: buildContactFullName(contact.firstName, contact.lastName, contact.email),
      email: contact.email ?? null,
      company: contact.company ?? null,
      phone: contact.phone ?? null,
      lifecycleStage: contact.lifecycleStage ?? null,
      lastModifiedAt: (contact.lastModifiedAt ?? contact.updatedAt)?.toISOString() ?? null,
      similarity: match.similarity,
    });

    if (snippets.length >= limit) {
      break;
    }
  }

  if (!snippets.length) {
    return loadRecentHubspotContacts(userId, limit);
  }

  return snippets;
}

async function loadRecentEmailSnippets(userId: string, limit: number) {
  const messages = await prisma.emailMessage.findMany({
    where: { userId },
    orderBy: { internalDate: "desc" },
    take: limit,
  });

  return messages.map<EmailSnippet>((message) => ({
    messageId: message.gmailMessageId,
    subject: message.subject,
    snippet: buildEmailSnippetText(message, message.bodyText ?? message.bodyHtml ?? ""),
    from: message.fromAddress,
    sentAt: message.internalDate?.toISOString() ?? null,
  }));
}

async function loadUpcomingCalendarSnippets(userId: string, limit: number) {
  const now = new Date();
  const events = await prisma.calendarEvent.findMany({
    where: {
      userId,
      OR: [
        { startTime: { gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) } },
        { startTime: null },
      ],
    },
    orderBy: { startTime: "asc" },
    take: limit,
  });

  return events.map<CalendarSnippet>((event) => ({
    eventId: event.eventId,
    summary: event.summary,
    startTime: event.startTime?.toISOString() ?? null,
    endTime: event.endTime?.toISOString() ?? null,
    location: event.location ?? null,
    description: event.description ?? null,
  }));
}

async function loadRecentHubspotContacts(userId: string, limit: number) {
  const contacts = await prisma.hubspotContact.findMany({
    where: { userId },
    orderBy: [
      { lastModifiedAt: "desc" },
      { updatedAt: "desc" },
    ],
    take: limit,
  });

  return contacts.map<HubspotContactSnippet>((contact) => ({
    contactId: contact.contactId,
    fullName: buildContactFullName(contact.firstName, contact.lastName, contact.email),
    email: contact.email ?? null,
    company: contact.company ?? null,
    phone: contact.phone ?? null,
    lifecycleStage: contact.lifecycleStage ?? null,
    lastModifiedAt: (contact.lastModifiedAt ?? contact.updatedAt)?.toISOString() ?? null,
  }));
}

function buildContactFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  email: string | null | undefined,
) {
  const parts = [firstName, lastName].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length) {
    return parts.join(" ");
  }

  return email ?? "HubSpot contact";
}

async function findVectorMatches(userId: string, embedding: number[], sourceTypes: DocumentSourceType[], sampleSize: number): Promise<VectorMatch[]> {
  const chunks = await prisma.documentChunk.findMany({
    where: {
      userId,
      document: {
        sourceType: {
          in: sourceTypes,
        },
      },
    },
    include: {
      document: true,
      vectors: {
        where: {
          strategy: "openai-text-embedding-3-large",
        },
      },
    },
    take: sampleSize,
  });

  const scored = chunks
    .filter((chunk) => chunk.vectors.length > 0 && Array.isArray(chunk.vectors[0]?.embedding))
    .map((chunk) => ({
      documentId: chunk.documentId,
      sourceId: chunk.document.sourceId,
      sourceType: chunk.document.sourceType,
      content: chunk.content,
      metadata: chunk.metadata,
      similarity: cosineSimilarity(embedding, chunk.vectors[0].embedding as number[]),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored;
}

async function safeGenerateEmbedding(input: string) {
  try {
    return await generateEmbeddingVector(input);
  } catch (error) {
    console.warn("Failed to generate search embedding:", error);
    return null;
  }
}

function buildEmailSnippetText(message: { subject: string | null; bodyText: string | null; bodyHtml: string | null }, fallbackContent: string) {
  if (message.bodyText?.trim()) {
    return message.bodyText.trim().slice(0, 600);
  }

  if (message.bodyHtml?.trim()) {
    return stripHtml(message.bodyHtml).slice(0, 600);
  }

  return fallbackContent.slice(0, 600);
}

function stripHtml(input: string) {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
