import { Prisma, SyncProvider, DocumentSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CALENDAR_API_BASE_URL } from "@/lib/google/config";
import { getGoogleAccessToken } from "@/lib/google/token";
import { generateEmbeddingVector } from "@/lib/embeddings";
import { evaluateInstructionsForEvent } from "@/lib/instructions";

export type CalendarDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type CalendarEventApi = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  updated?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
  }>;
};

type SyncOptions = {
  calendarId?: string;
  lookbackDays?: number;
  maxResults?: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_RESULTS = 100;
const MAX_CURSOR_AGE_DAYS = 28;

export async function syncCalendarEvents(userId: string, options?: SyncOptions) {
  const calendarId = options?.calendarId ?? "primary";
  const { accessToken } = await getGoogleAccessToken(userId);

  const syncState = await prisma.syncState.findUnique({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.calendar,
        resourceId: calendarId,
      },
    },
  });

  const fallbackStart = new Date(
    Date.now() -
      (options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000
  );

  const lastSyncDate = syncState?.lastSyncAt
    ? safeDate(syncState.lastSyncAt)
    : null;
  const lookupDate =
    lastSyncDate && lastSyncDate > fallbackStart ? lastSyncDate : fallbackStart;
  const timeMin = lookupDate.toISOString();

  const existingCursorDate = syncState?.cursor
    ? safeDate(syncState.cursor)
    : null;

  let cursorToUse = existingCursorDate ?? null;
  let cursorCleared = false;

  if (cursorToUse) {
    const staleCutoff = new Date(
      Date.now() - MAX_CURSOR_AGE_DAYS * 24 * 60 * 60 * 1000
    );
    if (cursorToUse < staleCutoff) {
      console.log(
        "[calendar] discarding stale cursor",
        cursorToUse.toISOString(),
        "cutoff",
        staleCutoff.toISOString()
      );
      cursorToUse = null;
      cursorCleared = true;
    }
  }

  if (cursorCleared && syncState) {
    await prisma.syncState.update({
      where: {
        userId_provider_resourceId: {
          userId,
          provider: SyncProvider.calendar,
          resourceId: calendarId,
        },
      },
      data: {
        cursor: null,
      },
    });
  }

  const url = new URL(`${CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "updated");
  url.searchParams.set("maxResults", String(options?.maxResults ?? DEFAULT_MAX_RESULTS));
  url.searchParams.set("timeMin", timeMin);
  if (cursorToUse) {
    url.searchParams.set("updatedMin", cursorToUse.toISOString());
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to sync calendar events: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as { items?: CalendarEventApi[] };
  const events = payload.items ?? [];

  let created = 0;
  let updated = 0;
  let processed = 0;
  let latestUpdated = cursorToUse?.toISOString();

  for (const event of events) {
    const result = await upsertCalendarEventRecord(userId, calendarId, event);
    processed += 1;
    if (result === "created") {
      created += 1;
      await evaluateInstructionsForEvent(userId, {
        type: "calendar.event_created",
        payload: {
          eventId: event.id,
          calendarId,
          summary: event.summary,
          start: event.start,
          end: event.end,
        },
      });
    } else if (result === "updated") {
      updated += 1;
      await evaluateInstructionsForEvent(userId, {
        type: "calendar.event_updated",
        payload: {
          eventId: event.id,
          calendarId,
          summary: event.summary,
          start: event.start,
          end: event.end,
        },
      });
    }

    if (event.updated) {
      if (!latestUpdated) {
        latestUpdated = event.updated;
      } else if (new Date(event.updated).getTime() > new Date(latestUpdated).getTime()) {
        latestUpdated = event.updated;
      }
    }
  }

  const nextCursor = latestUpdated ?? null;

  await prisma.syncState.upsert({
    where: {
      userId_provider_resourceId: {
        userId,
        provider: SyncProvider.calendar,
        resourceId: calendarId,
      },
    },
    create: {
      userId,
      provider: SyncProvider.calendar,
      resourceId: calendarId,
      lastSyncAt: new Date(),
      cursor: nextCursor,
      metadata: {
        timeMin,
      } satisfies Prisma.JsonValue,
    },
    update: {
      lastSyncAt: new Date(),
      cursor: nextCursor,
      metadata: {
        timeMin,
      } satisfies Prisma.JsonValue,
    },
  });

  return {
    processed,
    created,
    updated,
  };
}

function safeDate(
  value: Date | string | number | null | undefined
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

export async function upsertCalendarEventRecord(userId: string, calendarId: string, event: CalendarEventApi) {
  const existing = await prisma.calendarEvent.findUnique({
    where: {
      userId_calendarId_eventId: {
        userId,
        calendarId,
        eventId: event.id,
      },
    },
  });

  const summary = event.summary ?? "Untitled event";
  const normalized = normaliseCalendarEvent(event);
  const rawPayload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
  const attendeesJson = JSON.parse(JSON.stringify(normalized.attendees)) as Prisma.InputJsonValue;
  const metadata = {
    attendees: normalized.attendees,
    hangoutLink: normalized.hangoutLink,
    recurringEventId: normalized.recurringEventId,
  } satisfies Prisma.InputJsonValue;

  const textForEmbedding = buildCalendarEmbeddingText(summary, normalized.description, normalized.location, normalized.attendees);
  let embedding: number[] | null = null;

  if (textForEmbedding.trim()) {
    try {
      embedding = await generateEmbeddingVector(textForEmbedding);
    } catch (error) {
      console.warn(`Failed to generate embedding for calendar event ${event.id}:`, error);
    }
  }

  await prisma.$transaction(async (tx) => {
    const record = await tx.calendarEvent.upsert({
      where: {
        userId_calendarId_eventId: {
          userId,
          calendarId,
          eventId: event.id,
        },
      },
      create: {
        userId,
        calendarId,
        eventId: event.id,
        status: normalized.status ?? undefined,
        summary,
        description: normalized.description ?? undefined,
        location: normalized.location ?? undefined,
        startTime: normalized.startTime ?? undefined,
        endTime: normalized.endTime ?? undefined,
        startTimeZone: normalized.startTimeZone ?? undefined,
        endTimeZone: normalized.endTimeZone ?? undefined,
        hangoutLink: normalized.hangoutLink ?? undefined,
        attendees: attendeesJson,
        recurringEventId: normalized.recurringEventId ?? undefined,
        rawPayload,
        remoteUpdatedAt: normalized.updated ?? undefined,
      },
      update: {
        status: normalized.status ?? undefined,
        summary,
        description: normalized.description ?? undefined,
        location: normalized.location ?? undefined,
        startTime: normalized.startTime ?? undefined,
        endTime: normalized.endTime ?? undefined,
        startTimeZone: normalized.startTimeZone ?? undefined,
        endTimeZone: normalized.endTimeZone ?? undefined,
        hangoutLink: normalized.hangoutLink ?? undefined,
        attendees: attendeesJson,
        recurringEventId: normalized.recurringEventId ?? undefined,
        rawPayload,
        remoteUpdatedAt: normalized.updated ?? undefined,
      },
    });

    const document = await tx.document.upsert({
      where: {
        userId_sourceType_sourceId: {
          userId,
          sourceType: DocumentSourceType.calendarEvent,
          sourceId: record.id,
        },
      },
      create: {
        userId,
        sourceType: DocumentSourceType.calendarEvent,
        sourceId: record.id,
        title: summary,
        description: normalized.description ?? undefined,
        metadata,
      },
      update: {
        title: summary,
        description: normalized.description ?? undefined,
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
        content: textForEmbedding,
        metadata,
      },
      update: {
        content: textForEmbedding,
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

function normaliseCalendarEvent(event: CalendarEventApi) {
  const start = parseGoogleDateTime(event.start);
  const end = parseGoogleDateTime(event.end);

  return {
    status: event.status,
    description: event.description ?? null,
    location: event.location ?? null,
    startTime: start?.date,
    endTime: end?.date,
    startTimeZone: start?.timeZone ?? null,
    endTimeZone: end?.timeZone ?? null,
    hangoutLink: event.hangoutLink ?? null,
    attendees: event.attendees?.map((attendee) => ({
      email: attendee.email ?? null,
      name: attendee.displayName ?? attendee.email ?? null,
      responseStatus: attendee.responseStatus ?? null,
    })) ?? [],
    recurringEventId: event.recurringEventId ?? null,
    updated: event.updated ? new Date(event.updated) : null,
  };
}

function parseGoogleDateTime(value?: CalendarDateTime) {
  if (!value) {
    return null;
  }

  if (value.dateTime) {
    return {
      date: new Date(value.dateTime),
      timeZone: value.timeZone ?? null,
    };
  }

  if (value.date) {
    return {
      date: new Date(`${value.date}T00:00:00Z`),
      timeZone: value.timeZone ?? null,
    };
  }

  return null;
}

function buildCalendarEmbeddingText(summary: string, description: string | null, location: string | null, attendees: Array<{ email: string | null; name: string | null; responseStatus: string | null }>) {
  const lines = [summary];

  if (description) {
    lines.push(description);
  }

  if (location) {
    lines.push(`Location: ${location}`);
  }

  if (attendees.length) {
    lines.push(
      `Attendees: ${attendees
        .map((attendee) => {
          const identifier = attendee.name ?? attendee.email ?? "Unknown";
          const status = attendee.responseStatus ? ` (${attendee.responseStatus})` : "";
          return `${identifier}${status}`;
        })
        .join(", ")}`,
    );
  }

  return lines.join("\n").trim();
}
