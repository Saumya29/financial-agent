import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { createCalendarEvent, updateCalendarEvent } from "@/lib/tools/calendar";

const DateSchema = z
  .object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .refine((value) => Boolean(value.dateTime || value.date), {
    message: "Either dateTime or date must be provided",
  });

const EventSchema = z.object({
  calendarId: z.string().optional(),
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  start: DateSchema,
  end: DateSchema,
  attendees: z
    .array(
      z.object({
        email: z.string().email(),
        displayName: z.string().optional(),
        optional: z.boolean().optional(),
        responseStatus: z.string().optional(),
      }),
    )
    .optional(),
  conferenceData: z
    .object({
      createRequest: z.object({
        requestId: z.string().min(1),
        conferenceSolutionKey: z
          .object({
            type: z.string().min(1),
          })
          .optional(),
      }),
    })
    .optional(),
  sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
});

const UpdateSchema = EventSchema.extend({
  eventId: z.string().min(1),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = EventSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const event = await createCalendarEvent(session.user.id, parsed.data);
    return NextResponse.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create event";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = UpdateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { eventId, ...rest } = parsed.data;

  try {
    const event = await updateCalendarEvent(session.user.id, eventId, rest);
    return NextResponse.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update event";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
