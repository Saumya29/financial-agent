import { z } from "zod";

import { Prisma, InstructionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildRetrievalContextForPrompt } from "@/lib/retrieval";
import { sendGmailMessage, draftGmailMessage } from "@/lib/tools/gmail";
import { createCalendarEvent, updateCalendarEvent } from "@/lib/tools/calendar";
import {
  createOrUpdateHubspotContact,
} from "@/lib/tools/hubspot";
import { scheduleFollowUpTask } from "@/lib/automation/tasks";
import { createInstruction } from "@/lib/instructions";

type ToolInvocationContext = {
  userId: string;
  timeZone?: string;
};

type ToolParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

type AgentTool<TSchema extends z.ZodTypeAny> = {
  name: string;
  description: string;
  parameters: ToolParameters;
  schema: TSchema;
  handler: (input: z.infer<TSchema>, context: ToolInvocationContext) => Promise<unknown>;
};

const searchKnowledgeSchema = z.object({
  query: z.string().min(1, "query is required"),
  emailLimit: z.number().int().min(1).max(10).optional(),
  calendarLimit: z.number().int().min(1).max(10).optional(),
  contactLimit: z.number().int().min(1).max(10).optional(),
  exactSubjectMatch: z.boolean().optional(),
});

const emailPayloadSchema = z
  .object({
    to: z.array(z.string().email()).min(1, "to must include at least one recipient"),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1, "subject is required"),
    text: z.string().optional(),
    html: z.string().optional(),
    threadId: z.string().optional(),
    references: z.array(z.string()).optional(),
    inReplyTo: z.string().optional(),
  })
  .refine((value) => Boolean(value.text?.trim() || value.html?.trim()), {
    message: "Either text or html content is required",
    path: ["text"],
  });

const calendarDateTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const calendarEventSchema = z.object({
  calendarId: z.string().optional(),
  summary: z.string().min(1, "summary is required"),
  description: z.string().optional(),
  start: calendarDateTimeSchema.refine(
    (value) => Boolean(value.dateTime || value.date),
    "start requires either dateTime or date",
  ),
  end: calendarDateTimeSchema.refine(
    (value) => Boolean(value.dateTime || value.date),
    "end requires either dateTime or date",
  ),
  location: z.string().optional(),
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
        requestId: z.string(),
        conferenceSolutionKey: z
          .object({
            type: z.string(),
          })
          .optional(),
      }),
    })
    .optional(),
  sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
});

const updateCalendarEventSchema = calendarEventSchema.extend({
  eventId: z.string().min(1, "eventId is required"),
});

const hubspotContactSchema = z.object({
  contactId: z.string().optional(),
  properties: z.record(z.any()),
});

const scheduleFollowUpSchema = z.object({
  summary: z.string().min(1, "summary is required"),
  runAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.any()).optional(),
});

const storeInstructionSchema = z.object({
  title: z.string().min(1, "title is required"),
  content: z.string().min(1, "content is required"),
  triggers: z.array(z.string().min(1)).min(1, "provide at least one trigger"),
  metadata: z.record(z.any()).optional(),
});

const listInstructionsSchema = z.object({
  status: z.enum(["active", "paused", "archived"]).optional(),
});

const lookupContactSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().optional(),
  hubspotId: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const agentTools: AgentTool<z.ZodTypeAny>[] = [
  {
    name: "searchKnowledge",
    description: "Retrieve relevant Gmail messages, calendar events, and HubSpot contacts for a query. Use exactSubjectMatch=true when searching for specific email subjects.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of the information to search for, or exact subject text when exactSubjectMatch is true.",
        },
        emailLimit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of email snippets to return (default 5).",
        },
        calendarLimit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of calendar events to return (default 5).",
        },
        contactLimit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of HubSpot contacts to return (default 5).",
        },
        exactSubjectMatch: {
          type: "boolean",
          description: "Set to true to search for emails with exact subject match (case-insensitive substring match).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    schema: searchKnowledgeSchema,
    handler: async (input, context) => {
      const { query, emailLimit, calendarLimit, contactLimit, exactSubjectMatch } = input;

      // Special handling for calendar date queries
      const calendarDateMatch = query.match(/(?:on|for)\s+(?:(?:feb(?:ruary)?|march|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:feb(?:ruary)?|march|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))?(?:\s+\d{4})?|(?:this|next)\s+(?:week|month)|(?:tomorrow|tmrw)/i);

      if (calendarDateMatch || query.toLowerCase().includes("calendar") || query.toLowerCase().includes("meetings") || query.toLowerCase().includes("events")) {
        // Extract date from query or use a broad date range
        let startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        let endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 7); // Default to next 7 days

        // Try to parse specific date from query
        const dayMatch = query.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
        if (dayMatch) {
          const day = parseInt(dayMatch[1], 10);
          startDate.setDate(day);
          endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() + 1);
        }

        const calendarEvents = await prisma.calendarEvent.findMany({
          where: {
            userId: context.userId,
            startTime: {
              gte: startDate,
              lt: endDate,
            },
          },
          orderBy: { startTime: "asc" },
          take: calendarLimit ?? 10,
        });

        const calendarSnippets = calendarEvents.map(event => ({
          eventId: event.eventId,
          summary: event.summary,
          start: event.startTime?.toISOString() ?? null,
          end: event.endTime?.toISOString() ?? null,
          location: event.location,
          description: event.description?.substring(0, 200) ?? null,
        }));

        return {
          query,
          emails: [],
          calendar: calendarSnippets,
          contacts: [],
          metadata: {
            dateRange: {
              start: startDate.toISOString(),
              end: endDate.toISOString(),
            },
            count: calendarSnippets.length,
          },
        };
      }

      // Special handling for searching emails by person name
      const searchPersonMatch = query.match(/(?:search|find)\s+(?:for\s+)?(.+?)\s+in\s+(?:my\s+)?(?:email|mail|inbox)/i);
      const simpleNameMatch = query.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)$/);

      if (searchPersonMatch || simpleNameMatch) {
        const personName = searchPersonMatch
          ? searchPersonMatch[1].trim()
          : simpleNameMatch![1].trim();

        const emailsByPerson = await prisma.emailMessage.findMany({
          where: {
            userId: context.userId,
            OR: [
              { fromAddress: { contains: personName, mode: "insensitive" } },
              { toAddresses: { contains: personName, mode: "insensitive" } },
              { subject: { contains: personName, mode: "insensitive" } },
            ],
          },
          orderBy: { internalDate: "desc" },
          take: emailLimit ?? 10,
        });

        const emailSnippets = emailsByPerson.map(message => ({
          messageId: message.gmailMessageId,
          subject: message.subject,
          snippet: message.bodyText?.substring(0, 200) ?? message.snippet ?? "",
          from: message.fromAddress,
          sentAt: message.internalDate?.toISOString() ?? null,
        }));

        return {
          query,
          emails: emailSnippets,
          calendar: [],
          contacts: [],
          metadata: {
            personSearch: true,
            searchTerm: personName,
            count: emailSnippets.length,
          },
        };
      }

      // Special handling for "today" queries
      if (query.toLowerCase().includes("today") || query.toLowerCase().includes("emails from today")) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todaysEmails = await prisma.emailMessage.findMany({
          where: {
            userId: context.userId,
            internalDate: {
              gte: today,
              lt: tomorrow
            }
          },
          orderBy: { internalDate: "desc" },
          take: emailLimit ?? 10,
        });
        
        const emailSnippets = todaysEmails.map(message => ({
          messageId: message.gmailMessageId,
          subject: message.subject,
          snippet: message.bodyText?.substring(0, 200) ?? message.snippet ?? "",
          from: message.fromAddress,
          sentAt: message.internalDate?.toISOString() ?? null,
        }));
        
        return {
          query,
          emails: emailSnippets,
          calendar: [],
          contacts: [],
          metadata: {
            todayFilter: true,
            date: today.toISOString(),
            count: emailSnippets.length
          }
        };
      }
      
      // If exact subject match is requested, search directly in database
      if (exactSubjectMatch) {
        const emails = await prisma.emailMessage.findMany({
          where: {
            userId: context.userId,
            subject: {
              contains: query,
              mode: "insensitive" as const,
            }
          },
          orderBy: { internalDate: "desc" },
          take: emailLimit ?? 5,
        });
        
        const emailSnippets = emails.map(message => ({
          messageId: message.gmailMessageId,
          subject: message.subject,
          snippet: message.bodyText?.substring(0, 200) ?? message.snippet ?? "",
          from: message.fromAddress,
          sentAt: message.internalDate?.toISOString() ?? null,
        }));
        
        return {
          query,
          emails: emailSnippets,
          calendar: [],
          contacts: [],
        };
      }
      
      const retrieval = await buildRetrievalContextForPrompt(context.userId, query, {
        emailLimit,
        calendarLimit,
        contactLimit,
      });

      return {
        query,
        emails: retrieval.emailSnippets,
        calendar: retrieval.calendarSnippets,
        contacts: retrieval.hubspotContacts,
      };
    },
  },
  {
    name: "sendEmail",
    description: "Send an email via Gmail on behalf of the user.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "List of recipient email addresses.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
        },
        bcc: {
          type: "array",
          items: { type: "string" },
        },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        threadId: { type: "string" },
        references: {
          type: "array",
          items: { type: "string" },
        },
        inReplyTo: { type: "string" },
      },
      required: ["to", "subject"],
      additionalProperties: false,
    },
    schema: emailPayloadSchema,
    handler: async (input, context) => {
      const result = await sendGmailMessage(context.userId, input);
      return {
        messageId: result.id,
        threadId: result.threadId,
      };
    },
  },
  {
    name: "draftEmail",
    description: "Create a Gmail draft for later review.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
        threadId: { type: "string" },
        references: { type: "array", items: { type: "string" } },
        inReplyTo: { type: "string" },
      },
      required: ["to", "subject"],
      additionalProperties: false,
    },
    schema: emailPayloadSchema,
    handler: async (input, context) => {
      const result = await draftGmailMessage(context.userId, input);
      return {
        draftId: result.id,
        messageId: result.message.id,
        threadId: result.message.threadId,
      };
    },
  },
  {
    name: "createCalendarEvent",
    description: "Create a new Google Calendar event.",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        start: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
          required: [],
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
          required: [],
        },
        location: { type: "string" },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              displayName: { type: "string" },
              optional: { type: "boolean" },
              responseStatus: { type: "string" },
            },
            required: ["email"],
          },
        },
        conferenceData: {
          type: "object",
          properties: {
            createRequest: {
              type: "object",
              properties: {
                requestId: { type: "string" },
                conferenceSolutionKey: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                  },
                },
              },
              required: ["requestId"],
            },
          },
        },
        sendUpdates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
        },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
    schema: calendarEventSchema,
    handler: async (input, context) => {
      const result = await createCalendarEvent(context.userId, input);
      return {
        eventId: result.id,
        calendarId: input.calendarId ?? "primary",
        summary: result.summary,
        start: result.start,
        end: result.end,
      };
    },
  },
  {
    name: "updateCalendarEvent",
    description: "Update an existing Google Calendar event.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        calendarId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        start: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
        location: { type: "string" },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              displayName: { type: "string" },
              optional: { type: "boolean" },
              responseStatus: { type: "string" },
            },
            required: ["email"],
          },
        },
        conferenceData: {
          type: "object",
          properties: {
            createRequest: {
              type: "object",
              properties: {
                requestId: { type: "string" },
                conferenceSolutionKey: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                  },
                },
              },
              required: ["requestId"],
            },
          },
        },
        sendUpdates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
        },
      },
      required: ["eventId", "summary", "start", "end"],
      additionalProperties: false,
    },
    schema: updateCalendarEventSchema,
    handler: async (input, context) => {
      const result = await updateCalendarEvent(context.userId, input.eventId, input);
      return {
        eventId: result.id,
        calendarId: input.calendarId ?? "primary",
        summary: result.summary,
        start: result.start,
        end: result.end,
      };
    },
  },
  {
    name: "createOrUpdateHubspotContact",
    description: "Create or update a HubSpot contact record. ALWAYS proceed immediately with available information - NEVER ask the user for more details. REQUIRED: email property. OPTIONAL: firstname, lastname, phone, jobtitle, company. If you have a full name like 'John Doe', split it into firstname: 'John', lastname: 'Doe'. Example: {properties: {email: 'john@example.com', firstname: 'John', lastname: 'Doe'}}. Omit unknown fields entirely.",
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        properties: {
          type: "object",
          description: "HubSpot contact properties. MUST include email. Can include firstname, lastname, phone, jobtitle, company. Example: {email: 'test@example.com', firstname: 'John', lastname: 'Doe'}",
        },
      },
      required: ["properties"],
      additionalProperties: false,
    },
    schema: hubspotContactSchema,
    handler: async (input, context) => {
      const result = await createOrUpdateHubspotContact(context.userId, input);
      return {
        contactId: result.id,
      };
    },
  },
  {
    name: "lookupHubspotContact",
    description: "Look up or list HubSpot contacts. Provide email, name, or HubSpot ID to search for specific contacts, or call without parameters to list recent contacts.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        hubspotId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: [],
      additionalProperties: false,
    },
    schema: lookupContactSchema,
    handler: async (input, context) => {
      const { email, name, hubspotId, limit = 10 } = input;
      const contacts = await prisma.hubspotContact.findMany({
        where: {
          userId: context.userId,
          ...(email ? { email } : {}),
          ...(hubspotId ? { hubspotId } : {}),
          ...(name
            ? {
                OR: [
                  { firstName: { contains: name, mode: "insensitive" } },
                  { lastName: { contains: name, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
      });

      return {
        count: contacts.length,
        contacts,
      };
    },
  },
  {
    name: "scheduleFollowUpTask",
    description: "Create a follow-up task that the agent should revisit later.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        runAt: {
          type: "string",
          description: "ISO 8601 timestamp indicating when to revisit the task.",
        },
        metadata: {
          type: "object",
          description: "Additional context to store with the task.",
        },
      },
      required: ["summary", "runAt"],
      additionalProperties: false,
    },
    schema: scheduleFollowUpSchema,
    handler: async (input, context) => {
      const { summary, runAt, metadata } = input;
      const timeZone = resolveTimeZone(metadata, context.timeZone);
      const scheduling = buildSchedulingMetadata(runAt, timeZone);
      const metadataPayload = mergeMetadata(metadata, scheduling);

      const task = await scheduleFollowUpTask(context.userId, {
        summary,
        runAt: scheduling.scheduled,
        metadata: metadataPayload,
      });

      return {
        taskId: task?.id,
        scheduledFor: scheduling.scheduled.toISOString(),
      };
    },
  },
  {
    name: "storeInstruction",
    description: "Persist an ongoing instruction that should trigger on future events.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        triggers: {
          type: "array",
          items: { type: "string" },
          description: "Event trigger identifiers such as gmail.message_created.",
        },
        metadata: { type: "object" },
      },
      required: ["title", "content", "triggers"],
      additionalProperties: false,
    },
    schema: storeInstructionSchema,
    handler: async (input, context) => {
      const instruction = await createInstruction(context.userId, input);
      return {
        instructionId: instruction.id,
        status: instruction.status,
        triggers: instruction.triggers,
      };
    },
  },
  {
    name: "listInstructions",
    description: "List stored ongoing instructions and their status.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "paused", "archived"],
        },
      },
      required: [],
      additionalProperties: false,
    },
    schema: listInstructionsSchema,
    handler: async (input, context) => {
      const instructions = await prisma.instruction.findMany({
        where: {
          userId: context.userId,
          ...(input.status ? { status: input.status as InstructionStatus } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
      });

      return {
        count: instructions.length,
        instructions: instructions.map((instruction) => ({
          id: instruction.id,
          title: instruction.title,
          status: instruction.status,
          triggers: instruction.triggers,
          createdAt: instruction.createdAt,
          updatedAt: instruction.updatedAt,
        })),
      };
    },
  },
];

export type ToolExecutionResult =
  | { success: true; result: unknown }
  | { success: false; error: string };

export function getAgentToolDefinitions() {
  return agentTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function normaliseScheduledFor(runAt: string, timeZone: string) {
  const parsed = new Date(runAt);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid runAt value supplied: ${runAt}`);
  }

  const now = new Date();
  if (parsed.getTime() > now.getTime()) {
    return { scheduled: parsed, parsed, adjusted: false };
  }

  const todayCandidate = buildCandidateForDate(now, parsed, timeZone);

  if (todayCandidate.getTime() > now.getTime()) {
    return {
      scheduled: todayCandidate,
      parsed,
      adjusted: true,
    };
  }

  const tomorrow = new Date(now.getTime() + DAY_IN_MS);
  const tomorrowCandidate = buildCandidateForDate(tomorrow, parsed, timeZone);

  return {
    scheduled: tomorrowCandidate,
    parsed,
    adjusted: true,
  };
}

function buildSchedulingMetadata(runAt: string, timeZone: string) {
  const { scheduled, parsed, adjusted } = normaliseScheduledFor(runAt, timeZone);
  const payload: Record<string, unknown> = {
    inputRunAt: runAt,
    parsedRunAt: parsed.toISOString(),
    scheduledRunAt: scheduled.toISOString(),
    generatedAt: new Date().toISOString(),
    timeZone,
  };

  if (adjusted) {
    payload.adjustment = {
      type: "shifted_forward",
      reason: "input_in_past",
    };
  }

  return { scheduled, payload };
}

function mergeMetadata(metadata: unknown, scheduling: { scheduled: Date; payload: Record<string, unknown> }) {
  let base: Record<string, unknown> = {};

  if (metadata && typeof metadata === "object") {
    base = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  }

  base.followUpScheduling = scheduling.payload;
  return JSON.parse(JSON.stringify(base)) as Prisma.JsonValue;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function resolveTimeZone(metadata: unknown, contextTimeZone?: string): string {
  if (contextTimeZone && isValidTimeZone(contextTimeZone.trim())) {
    return contextTimeZone.trim();
  }

  const metadataTz = extractTimeZoneFromMetadata(metadata);
  if (metadataTz) {
    return metadataTz;
  }

  return "UTC";
}

function isValidTimeZone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function extractTimeZoneFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const root = metadata as Record<string, unknown>;
  const direct = root.timezone ?? root.timeZone;
  if (typeof direct === "string" && direct.trim() && isValidTimeZone(direct.trim())) {
    return direct.trim();
  }

  const scheduling = root.followUpScheduling;
  if (scheduling && typeof scheduling === "object") {
    const tz = (scheduling as Record<string, unknown>).timeZone;
    if (typeof tz === "string" && tz.trim() && isValidTimeZone(tz.trim())) {
      return tz.trim();
    }
  }

  return undefined;
}

function buildCandidateForDate(baseDate: Date, timeOfDay: Date, timeZone: string) {
  const { year, month, day } = getDatePartsInTimeZone(baseDate, timeZone);
  const { hour, minute, second } = getTimePartsInTimeZone(timeOfDay, timeZone);
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offsetMinutes = getTimeZoneOffset(new Date(baseUtc), timeZone);
  return new Date(baseUtc - offsetMinutes * 60_000);
}

function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      lookup[part.type] = Number(part.value);
    }
  }

  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
  };
}

function getTimeZoneOffset(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = dtf.formatToParts(date);
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = Number(part.value);
    }
  }

  const asUtc = Date.UTC(lookup.year, lookup.month - 1, lookup.day, lookup.hour, lookup.minute, lookup.second);
  return (asUtc - date.getTime()) / 60000;
}

function getTimePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const lookup: Record<string, number> = {
    hour: 0,
    minute: 0,
    second: 0,
  };

  for (const part of parts) {
    if (part.type === "hour" || part.type === "minute" || part.type === "second") {
      lookup[part.type] = Number(part.value);
    }
  }

  return {
    hour: lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
  };
}

export async function executeAgentTool(name: string, rawArguments: string | null | undefined, context: ToolInvocationContext): Promise<ToolExecutionResult> {
  const tool = agentTools.find((item) => item.name === name);

  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  let parsedInput: unknown;

  if (!rawArguments || !rawArguments.trim()) {
    parsedInput = {};
  } else {
    try {
      parsedInput = JSON.parse(rawArguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON arguments";
      return { success: false, error: `Failed to parse arguments: ${message}` };
    }
  }

  let validatedInput: unknown;
  try {
    validatedInput = tool.schema.parse(parsedInput);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.errors.map((issue) => issue.message).join(", ") };
    }
    const message = error instanceof Error ? error.message : "Unknown validation error";
    return { success: false, error: message };
  }

  try {
    const result = await tool.handler(validatedInput, context);
    return { success: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { success: false, error: message };
  }
}
