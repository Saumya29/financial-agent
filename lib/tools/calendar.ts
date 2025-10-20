import { upsertCalendarEventRecord, CalendarEventApi } from "@/lib/sync/calendar";
import { getGoogleAccessToken } from "@/lib/google/token";

type CalendarParticipant = {
  email: string;
  displayName?: string;
  optional?: boolean;
  responseStatus?: string;
};

export type CalendarEventInput = {
  calendarId?: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  location?: string;
  attendees?: CalendarParticipant[];
  conferenceData?: {
    createRequest: {
      requestId: string;
      conferenceSolutionKey?: {
        type: string;
      };
    };
  };
  sendUpdates?: "all" | "externalOnly" | "none";
};

export async function createCalendarEvent(userId: string, input: CalendarEventInput) {
  const calendarId = input.calendarId ?? "primary";
  const { accessToken } = await getGoogleAccessToken(userId);

  const sendUpdates = input.sendUpdates ?? "all";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${encodeURIComponent(sendUpdates)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildEventPayload(input)),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to create calendar event: ${detail || response.statusText}`);
  }

  const event = (await response.json()) as CalendarEventApi;
  await upsertCalendarEventRecord(userId, calendarId, event);
  return event;
}

export async function updateCalendarEvent(userId: string, eventId: string, input: CalendarEventInput) {
  const calendarId = input.calendarId ?? "primary";
  const { accessToken } = await getGoogleAccessToken(userId);

  const sendUpdates = input.sendUpdates ?? "all";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildEventPayload(input)),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to update calendar event: ${detail || response.statusText}`);
  }

  const event = (await response.json()) as CalendarEventApi;
  await upsertCalendarEventRecord(userId, calendarId, event);
  return event;
}

function buildEventPayload(input: CalendarEventInput) {
  const payload: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start: input.start,
    end: input.end,
    location: input.location,
    attendees: input.attendees?.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName,
      optional: attendee.optional,
      responseStatus: attendee.responseStatus,
    })),
  };

  if (input.conferenceData) {
    payload.conferenceData = input.conferenceData;
  }

  return payload;
}
