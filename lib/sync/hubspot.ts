import { Prisma, SyncProvider, DocumentSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getHubspotAccessToken } from "@/lib/hubspot/token";
import { generateEmbeddingVector } from "@/lib/embeddings";
import { evaluateInstructionsForEvent } from "@/lib/instructions";

type HubspotSearchResponse<TProperties extends Record<string, unknown>> = {
  results: Array<{
    id: string;
    properties: TProperties;
    createdAt: string;
    updatedAt: string;
    associations?: Record<string, { results: Array<{ id: string }> }>;
  }>;
  paging?: {
    next?: {
      after: string;
    };
  };
};

type HubspotObjectResponse<TProperties extends Record<string, unknown>> = {
  id: string;
  properties: TProperties;
  createdAt: string;
  updatedAt: string;
  associations?: Record<string, { results: Array<{ id: string }> }>;
};

const CONTACT_RESOURCE = "contacts";
const NOTE_RESOURCE = "notes";

type ContactProperties = {
  email?: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
  lifecyclestage?: string;
  hubspot_owner_id?: string;
  hs_lastmodifieddate?: string;
};

type NoteProperties = {
  hs_timestamp?: string;
  hs_note_body?: string;
  hs_body?: string;
  hs_lastmodifieddate?: string;
};

type SyncOptions = {
  limit?: number;
  maxPages?: number;
};

const DEFAULT_LIMIT = 100;
const MAX_PAGES = 5;

const LEGACY_CURSOR_CUTOFF = new Date("2001-01-01T00:00:00.000Z");

export async function syncHubspotContacts(
  userId: string,
  options?: SyncOptions
) {
  const { accessToken, portalId } = await getHubspotAccessToken(userId);

  if (!portalId) {
    throw new Error("Unable to determine HubSpot portal for this user");
  }

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const maxPages = options?.maxPages ?? MAX_PAGES;

  const syncState = await prisma.syncState.findUnique({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.hubspot,
        resourceId: CONTACT_RESOURCE,
      },
    },
  });

  let existingCursorDate = syncState?.cursor
    ? safeDate(syncState.cursor)
    : null;
  if (existingCursorDate && existingCursorDate < LEGACY_CURSOR_CUTOFF) {
    console.log(
      "[hubspot] contacts discarding legacy cursor",
      existingCursorDate.toISOString()
    );
    existingCursorDate = null;
  }

  const queryCursorValue = existingCursorDate
    ? existingCursorDate.getTime().toString()
    : null;
  let after: string | undefined;
  let page = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let latestModifiedDate = existingCursorDate ?? null;

  do {
    const body: Record<string, unknown> = {
      limit,
      sorts: [
        {
          propertyName: "hs_lastmodifieddate",
          direction: "ASCENDING",
        },
      ],
      properties: [
        "email",
        "firstname",
        "lastname",
        "phone",
        "company",
        "lifecyclestage",
        "hubspot_owner_id",
        "hs_lastmodifieddate",
      ],
    };

    if (after) {
      body.after = after;
    }

    if (queryCursorValue) {
      body.filterGroups = [
        {
          filters: [
            {
              propertyName: "hs_lastmodifieddate",
              operator: "GT",
              value: queryCursorValue,
            },
          ],
        },
      ];
    }

    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Failed to sync HubSpot contacts: ${detail || response.statusText}`
      );
    }

    const payload =
      (await response.json()) as HubspotSearchResponse<ContactProperties>;
    console.log(
      "[hubspot] contacts",
      JSON.stringify(
        {
          status: response.status,
          count: payload.results?.length ?? 0,
          cursor: queryCursorValue,
          page,
          after,
        },
        null,
        2
      )
    );
    if (!payload.results?.length) {
      console.log(
        "[hubspot] contacts payload",
        JSON.stringify(payload, null, 2)
      );
    }

    for (const contact of payload.results) {
      const normalised = normaliseContact(contact, portalId);
      const result = await persistHubspotContact(userId, normalised);
      processed += 1;
      if (result === "created") {
        created += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "hubspot.contact_created",
          payload: {
            contactId: normalised.id,
            email: normalised.email,
            firstName: normalised.firstName,
            lastName: normalised.lastName,
          },
        });
      } else if (result === "updated") {
        updated += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "hubspot.contact_updated",
          payload: {
            contactId: normalised.id,
            email: normalised.email,
            firstName: normalised.firstName,
            lastName: normalised.lastName,
          },
        });
      }

      if (normalised.lastModifiedAt) {
        if (
          !latestModifiedDate ||
          normalised.lastModifiedAt > latestModifiedDate
        ) {
          latestModifiedDate = normalised.lastModifiedAt;
        }
      }
    }

    after = payload.paging?.next?.after;
    page += 1;
  } while (after && page < maxPages);

  const nextCursorDate = latestModifiedDate ?? existingCursorDate ?? null;
  const nextCursor = nextCursorDate?.toISOString() ?? null;

  await prisma.syncState.upsert({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.hubspot,
        resourceId: CONTACT_RESOURCE,
      },
    },
    create: {
      userId,
      provider: SyncProvider.hubspot,
      resourceId: CONTACT_RESOURCE,
      cursor: nextCursor,
      lastSyncAt: new Date(),
    },
    update: {
      cursor: nextCursor,
      lastSyncAt: new Date(),
    },
  });

  return { processed, created, updated };
}

export async function syncHubspotNotes(userId: string, options?: SyncOptions) {
  const { accessToken, portalId } = await getHubspotAccessToken(userId);

  if (!portalId) {
    throw new Error("Unable to determine HubSpot portal for this user");
  }

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const maxPages = options?.maxPages ?? MAX_PAGES;

  const syncState = await prisma.syncState.findUnique({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.hubspot,
        resourceId: NOTE_RESOURCE,
      },
    },
  });

  let existingCursorDate = syncState?.cursor
    ? safeDate(syncState.cursor)
    : null;
  if (existingCursorDate && existingCursorDate < LEGACY_CURSOR_CUTOFF) {
    console.log(
      "[hubspot] notes discarding legacy cursor",
      existingCursorDate.toISOString()
    );
    existingCursorDate = null;
  }

  const queryCursorValue = existingCursorDate
    ? existingCursorDate.getTime().toString()
    : null;
  let after: string | undefined;
  let page = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let latestModifiedDate = existingCursorDate ?? null;

  do {
    const body: Record<string, unknown> = {
      limit,
      sorts: [
        {
          propertyName: "hs_lastmodifieddate",
          direction: "ASCENDING",
        },
      ],
      properties: [
        "hs_timestamp",
        "hs_note_body",
        "hs_body",
        "hs_lastmodifieddate",
      ],
      associations: ["contacts"],
    };

    if (after) {
      body.after = after;
    }

    if (queryCursorValue) {
      body.filterGroups = [
        {
          filters: [
            {
              propertyName: "hs_lastmodifieddate",
              operator: "GT",
              value: queryCursorValue,
            },
          ],
        },
      ];
    }

    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/notes/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Failed to sync HubSpot notes: ${detail || response.statusText}`
      );
    }

    const payload =
      (await response.json()) as HubspotSearchResponse<NoteProperties>;
    console.log(
      "[hubspot] notes",
      JSON.stringify(
        {
          status: response.status,
          count: payload.results?.length ?? 0,
          cursor: queryCursorValue,
          page,
          after,
        },
        null,
        2
      )
    );
    if (!payload.results?.length) {
      console.log("[hubspot] notes payload", JSON.stringify(payload, null, 2));
    }

    for (const note of payload.results) {
      const normalised = normaliseNote(note, portalId);
      const result = await persistHubspotNote(userId, normalised);
      processed += 1;
      if (result === "created") {
        created += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "hubspot.note_created",
          payload: {
            noteId: normalised.id,
            contactIds: normalised.contactIds,
          },
        });
      } else if (result === "updated") {
        updated += 1;
        await evaluateInstructionsForEvent(userId, {
          type: "hubspot.note_updated",
          payload: {
            noteId: normalised.id,
            contactIds: normalised.contactIds,
          },
        });
      }

      if (normalised.lastModifiedAt) {
        if (
          !latestModifiedDate ||
          normalised.lastModifiedAt > latestModifiedDate
        ) {
          latestModifiedDate = normalised.lastModifiedAt;
        }
      }
    }

    after = payload.paging?.next?.after;
    page += 1;
  } while (after && page < maxPages);

  const nextCursorDate = latestModifiedDate ?? existingCursorDate ?? null;
  const nextCursor = nextCursorDate?.toISOString() ?? null;

  await prisma.syncState.upsert({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.hubspot,
        resourceId: NOTE_RESOURCE,
      },
    },
    create: {
      userId,
      provider: SyncProvider.hubspot,
      resourceId: NOTE_RESOURCE,
      cursor: nextCursor,
      lastSyncAt: new Date(),
    },
    update: {
      cursor: nextCursor,
      lastSyncAt: new Date(),
    },
  });

  return { processed, created, updated };
}

export async function ingestHubspotContact(userId: string, contactId: string) {
  const { accessToken, portalId } = await getHubspotAccessToken(userId);

  if (!portalId) {
    throw new Error("Unable to determine HubSpot portal for this user");
  }

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(
      contactId
    )}?properties=email,firstname,lastname,phone,company,lifecyclestage,hubspot_owner_id,hs_lastmodifieddate`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Failed to load HubSpot contact ${contactId}: ${
        detail || response.statusText
      }`
    );
  }

  const payload =
    (await response.json()) as HubspotObjectResponse<ContactProperties>;
  const normalised = normaliseContact(payload, portalId);
  await persistHubspotContact(userId, normalised);
  await evaluateInstructionsForEvent(userId, {
    type: "hubspot.contact_updated",
    payload: {
      contactId: normalised.id,
      email: normalised.email,
      firstName: normalised.firstName,
      lastName: normalised.lastName,
    },
  });
  return normalised;
}

export async function ingestHubspotNote(userId: string, noteId: string) {
  const { accessToken, portalId } = await getHubspotAccessToken(userId);

  if (!portalId) {
    throw new Error("Unable to determine HubSpot portal for this user");
  }

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(
      noteId
    )}?properties=hs_timestamp,hs_note_body,hs_body,hs_lastmodifieddate&associations=contacts`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Failed to load HubSpot note ${noteId}: ${detail || response.statusText}`
    );
  }

  const payload =
    (await response.json()) as HubspotObjectResponse<NoteProperties>;
  const normalised = normaliseNote(payload, portalId);
  await persistHubspotNote(userId, normalised);
  await evaluateInstructionsForEvent(userId, {
    type: "hubspot.note_updated",
    payload: {
      noteId: normalised.id,
      contactIds: normalised.contactIds,
    },
  });
  return normalised;
}

type NormalisedContact = {
  id: string;
  portalId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  company: string | null;
  lifecycleStage: string | null;
  lastModifiedAt: Date | null;
  lastModifiedCursor: string | null;
  properties: Record<string, unknown>;
};

type NormalisedNote = {
  id: string;
  portalId: string;
  body: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  contactIds: string[];
  lastModifiedAt: Date | null;
  lastModifiedCursor: string | null;
  properties: Record<string, unknown>;
};

function normaliseContact(
  result:
    | HubspotSearchResponse<ContactProperties>["results"][number]
    | HubspotObjectResponse<ContactProperties>,
  portalId: string
): NormalisedContact {
  const properties = cleanProperties(result.properties);
  const hsLastModified = properties.hs_lastmodifieddate as string | undefined;
  const resolvedIso = parseHubspotDate(hsLastModified) ?? result.updatedAt;
  const lastModifiedAt = safeDate(resolvedIso);

  return {
    id: result.id,
    portalId,
    email: (properties.email as string | undefined) ?? null,
    firstName: (properties.firstname as string | undefined) ?? null,
    lastName: (properties.lastname as string | undefined) ?? null,
    phone: (properties.phone as string | undefined) ?? null,
    company: (properties.company as string | undefined) ?? null,
    lifecycleStage: (properties.lifecyclestage as string | undefined) ?? null,
    lastModifiedAt,
    lastModifiedCursor: lastModifiedAt?.toISOString() ?? null,
    properties,
  };
}

function normaliseNote(
  result:
    | HubspotSearchResponse<NoteProperties>["results"][number]
    | HubspotObjectResponse<NoteProperties>,
  portalId: string
): NormalisedNote {
  const properties = cleanProperties(result.properties);
  const body =
    (properties.hs_note_body as string | undefined) ??
    (properties.hs_body as string | undefined) ??
    null;
  const createdIso =
    properties.hs_timestamp != null
      ? parseHubspotDate(properties.hs_timestamp as string | number) ??
        result.createdAt
      : result.createdAt;
  const createdAt = safeDate(createdIso);
  const updatedIso = properties.hs_lastmodifieddate
    ? parseHubspotDate(properties.hs_lastmodifieddate as string | number) ??
      result.updatedAt
    : result.updatedAt;
  const updatedAt = safeDate(updatedIso);
  const contactIds =
    result.associations?.contacts?.results?.map(
      (association) => association.id
    ) ?? [];

  return {
    id: result.id,
    portalId,
    body,
    createdAt: createdAt ?? null,
    updatedAt: updatedAt ?? null,
    contactIds,
    lastModifiedAt: updatedAt ?? null,
    lastModifiedCursor: updatedAt?.toISOString() ?? null,
    properties,
  };
}

async function persistHubspotContact(
  userId: string,
  contact: NormalisedContact
) {
  const existing = await prisma.hubspotContact.findUnique({
    where: {
      userId_portalId_contactId: {
        userId,
        portalId: contact.portalId,
        contactId: contact.id,
      },
    },
  });

  const sanitizedProperties = contact.properties as Prisma.InputJsonValue;
  const lastModifiedAt = contact.lastModifiedAt ?? null;
  const fullName =
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    contact.email ||
    "HubSpot contact";

  const embeddingTextLines = [fullName];

  if (contact.company) {
    embeddingTextLines.push(`Company: ${contact.company}`);
  }

  if (contact.lifecycleStage) {
    embeddingTextLines.push(`Lifecycle stage: ${contact.lifecycleStage}`);
  }

  if (contact.phone) {
    embeddingTextLines.push(`Phone: ${contact.phone}`);
  }

  if (contact.email) {
    embeddingTextLines.push(`Email: ${contact.email}`);
  }

  const documentContent = embeddingTextLines.join("\n");
  let embedding: number[] | null = null;

  if (documentContent.trim()) {
    try {
      embedding = await generateEmbeddingVector(documentContent);
    } catch (error) {
      console.warn(
        `Failed to generate embedding for HubSpot contact ${contact.id}:`,
        error
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.hubspotContact.upsert({
      where: {
        userId_portalId_contactId: {
          userId,
          portalId: contact.portalId,
          contactId: contact.id,
        },
      },
      create: {
        userId,
        portalId: contact.portalId,
        contactId: contact.id,
        email: contact.email ?? undefined,
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        phone: contact.phone ?? undefined,
        company: contact.company ?? undefined,
        lifecycleStage: contact.lifecycleStage ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,
        properties: sanitizedProperties,
      },
      update: {
        email: contact.email ?? undefined,
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        phone: contact.phone ?? undefined,
        company: contact.company ?? undefined,
        lifecycleStage: contact.lifecycleStage ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,
        properties: sanitizedProperties,
      },
    });

    const document = await tx.document.upsert({
      where: {
        userId_sourceType_sourceId: {
          userId,
          sourceType: DocumentSourceType.hubspotContact,
          sourceId: contact.id,
        },
      },
      create: {
        userId,
        sourceType: DocumentSourceType.hubspotContact,
        sourceId: contact.id,
        title: fullName,
        metadata: sanitizedProperties,
      },
      update: {
        title: fullName,
        metadata: sanitizedProperties,
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
        content: documentContent,
        metadata: sanitizedProperties,
      },
      update: {
        content: documentContent,
        metadata: sanitizedProperties,
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

async function persistHubspotNote(userId: string, note: NormalisedNote) {
  const existing = await prisma.hubspotNote.findUnique({
    where: {
      userId_portalId_noteId: {
        userId,
        portalId: note.portalId,
        noteId: note.id,
      },
    },
  });

  const properties = note.properties as Prisma.InputJsonValue;
  const body = note.body ?? "";
  const summary = body
    ? body.split(/\n+/)[0]?.slice(0, 140) ?? "HubSpot note"
    : "HubSpot note";

  let embedding: number[] | null = null;

  if (body.trim()) {
    try {
      embedding = await generateEmbeddingVector(body);
    } catch (error) {
      console.warn(
        `Failed to generate embedding for HubSpot note ${note.id}:`,
        error
      );
    }
  }

  const metadata = {
    contactIds: note.contactIds,
    properties,
  } satisfies Prisma.InputJsonValue;

  await prisma.$transaction(async (tx) => {
    await tx.hubspotNote.upsert({
      where: {
        userId_portalId_noteId: {
          userId,
          portalId: note.portalId,
          noteId: note.id,
        },
      },
      create: {
        userId,
        portalId: note.portalId,
        noteId: note.id,
        contactId: note.contactIds[0] ?? undefined,
        content: body || undefined,
        createdAtRemote: note.createdAt ?? undefined,
        updatedAtRemote: note.updatedAt ?? undefined,
        properties,
      },
      update: {
        contactId: note.contactIds[0] ?? undefined,
        content: body || undefined,
        createdAtRemote: note.createdAt ?? undefined,
        updatedAtRemote: note.updatedAt ?? undefined,
        properties,
      },
    });

    const document = await tx.document.upsert({
      where: {
        userId_sourceType_sourceId: {
          userId,
          sourceType: DocumentSourceType.hubspotNote,
          sourceId: note.id,
        },
      },
      create: {
        userId,
        sourceType: DocumentSourceType.hubspotNote,
        sourceId: note.id,
        title: summary,
        description: body || undefined,
        metadata,
      },
      update: {
        title: summary,
        description: body || undefined,
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
        content: body,
        metadata,
      },
      update: {
        content: body,
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

function parseHubspotDate(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const raw =
    typeof value === "number" ? value.toString() : String(value).trim();

  if (!raw) {
    return null;
  }

  if (/^-?\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const ms = raw.length <= 10 ? numeric * 1000 : numeric;
      const dateFromNumeric = safeDate(ms);
      if (dateFromNumeric) {
        return dateFromNumeric.toISOString();
      }
    }
  }

  const parsed = safeDate(raw);
  return parsed?.toISOString() ?? null;
}

function safeDate(
  value: string | number | Date | null | undefined
): Date | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanProperties(properties: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify(properties, (_key, value) => {
      if (value === undefined) {
        return null;
      }
      return value;
    })
  ) as Record<string, unknown>;
}
