import { NextResponse } from "next/server";
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { executeAgentTool, getAgentToolDefinitions } from "@/lib/agent/tools";
import { normaliseRole, runModelIteration } from "@/lib/agent/model";
import { type ChatCompletionMessage, type ChatToolDefinition } from "@/lib/openai";

const ChatRequestSchema = z.object({
  threadId: z.string().optional(),
  messages: z.array(
    z.object({
      id: z.string().optional(),
      role: z.enum(["user", "assistant", "system", "tool"]),
      content: z.string(),
    }),
  ),
  prompt: z.string().optional(),
  client: z
    .object({
      timeZone: z
        .string()
        .trim()
        .min(1)
        .optional(),
    })
    .optional(),
});

function resolvePreferredTimeZone(clientTimeZone?: string) {
  if (clientTimeZone && isValidTimeZone(clientTimeZone)) {
    return clientTimeZone;
  }

  return "UTC";
}

function buildCurrentTimeInstruction(timeZone: string) {
  const now = new Date();
  const localFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  });
  const localString = localFormatter.format(now);
  return `The current UTC datetime is ${now.toISOString()}. The user's timezone is ${timeZone}. In that timezone the current date and time is ${localString}. Base any relative date or time reasoning (e.g. “today”, “tomorrow”, “next week”) on this timestamp.`;
}

function isValidTimeZone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = `You are an AI copilot that supports financial advisors.
You have tool access to search synced Gmail, Google Calendar, and HubSpot data and to perform actions such as sending email, scheduling meetings, and updating CRM records.
Before answering questions that rely on real data, call the searchKnowledge tool to gather the latest relevant context.

IMPORTANT for searching emails:
- When users ask "any mails from today?" or "emails from today", just use searchKnowledge with query="emails from today" to get recent emails, then filter by date
- For general date queries without specific terms, use a descriptive query like "recent emails" or "today's emails"
- DEFAULT BEHAVIOR: For specific terms, use exactSubjectMatch=true when searching
- When users ask "did anyone check in on me?" or similar:
  1. FIRST search for "checking in" with exactSubjectMatch=true
  2. THEN search for "check in" with exactSubjectMatch=true  
  3. THEN search for "just checking" with exactSubjectMatch=true
  4. Only use semantic search if no results from exact matches
- For ANY specific terms, acronyms, or phrases mentioned by user:
  1. ALWAYS try exactSubjectMatch=true first
  2. Extract the key term and search for it exactly
  3. Do NOT use semantic search unless exact match returns nothing
- Examples of extraction:
  - "did anyone check in?" → search "checking in" or "check in" (exact)
  - "any TDS related?" → search "TDS" (exact)
  - "meeting invites?" → search "meeting" or "invite" (exact)
- NEVER show unrelated emails when specific terms are mentioned

CRITICAL: When users ask about "today" or specific dates:
- Today's date will be provided in the time instruction - use that as reference
- The sentAt field contains ISO 8601 UTC timestamps like "2025-10-20T06:45:26.000Z"
- The date portion "2025-10-20" is the UTC date - DO NOT convert to local timezone for date comparison
- DEBUG: When asked for today's emails, FIRST state what dates you see in sentAt fields
- To check if an email is from today: if sentAt contains "2025-10-20" and today is October 20, 2025, it IS from today
- RULE: Any email with sentAt starting with today's date (e.g., "2025-10-20") MUST be reported as from today
- If you find emails with sentAt="2025-10-20T...", you MUST list them as today's emails
- NEVER say "no emails from today" if any sentAt field contains "2025-10-20"

When the user asks you to take action, use the appropriate tool and then summarise the result for the user.
Capture ongoing automation requests using the storeInstruction tool so they run again when matching events arrive.
When creating follow-up tasks with scheduleFollowUpTask, always supply a runAt timestamp that is in the future relative to "now" and expressed in ISO-8601 with an explicit offset. Prefer the user's local timezone provided in client.timeZone; otherwise use the locale inferred from the conversation. If the user gives a vague time (e.g. "tomorrow morning"), map it to a reasonable future time (such as 09:00 in that timezone). Never pick dates in the past or reuse stale dates; always calculate based on the current date.
When answering “what’s tomorrow?” or similar questions, respond using the current calendar context (today + 1) rather than historic task metadata.
Always provide concise, actionable answers and surface any blockers or missing information.`;


const PRISMA_MIGRATION_ERROR_CODES = new Set(["P2021", "P1012"]);

function isPrismaKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = ChatRequestSchema.safeParse(body);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  const { threadId, messages, prompt, client } = parseResult.data;
  const clientTimeZone = client?.timeZone?.trim() || undefined;
  const timeZone = resolvePreferredTimeZone(clientTimeZone);

  const lastMessage = messages[messages.length - 1];
  const userMessage = prompt ?? lastMessage?.content ?? "";
  const userRole = prompt ? "user" : lastMessage?.role ?? "user";

  if (!userMessage.trim()) {
    return NextResponse.json({ error: "Message content is required" }, { status: 400 });
  }

  if (userRole !== "user") {
    return NextResponse.json({ error: "Last message must be authored by the user" }, { status: 400 });
  }

  const userId = session.user.id;

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (event: string, data: Record<string, unknown>) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(payload));
  };

  void (async () => {
    let resolvedThreadId: string | undefined;
    let lastUserMessageContent = userMessage;

    const sendError = async (message: string) => {
      await sendEvent("error", { message });
    };

    try {
      const existingThread = threadId
        ? await prisma.chatThread.findFirst({
            where: { id: threadId, userId },
          })
        : null;

      if (threadId && !existingThread) {
        await sendError("Thread not found");
        return;
      }

      const resolvedThread =
        existingThread ??
        (await prisma.chatThread.create({
          data: {
            userId,
            title: userMessage.slice(0, 80),
          },
        }));

      resolvedThreadId = resolvedThread.id;

      await sendEvent("thread", { threadId: resolvedThread.id });

      const persistedUserMessage = await prisma.chatMessage.create({
        data: {
          threadId: resolvedThread.id,
          role: "user",
          content: userMessage,
          status: "complete",
        },
      });

      lastUserMessageContent = persistedUserMessage.content;

      const recentMessages = await prisma.chatMessage.findMany({
        where: { threadId: resolvedThread.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      const ordered = recentMessages.reverse();

      const chatMessages: ChatCompletionMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: buildCurrentTimeInstruction(timeZone) },
        ...ordered
          .filter((message) => message.role !== "tool")
          .map<ChatCompletionMessage>((message) => ({
            role: normaliseRole(message.role),
            content: message.content,
          })),
      ];

      const toolDefinitions = getAgentToolDefinitions();

      const maxIterations = 6;
      let finalAssistantContent = "";

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const result = await runModelIteration({
          chatMessages,
          toolDefinitions: toolDefinitions as ChatToolDefinition[],
          onToken: async (text) => {
            await sendEvent("token", { text });
          },
        });

        if (result.type === "tool_calls") {
          chatMessages.push({
            role: "assistant",
            content: result.content ?? "",
            tool_calls: result.toolCalls,
          });

          for (const toolCall of result.toolCalls) {
            const execution = await executeAgentTool(toolCall.function.name, toolCall.function.arguments, {
              userId,
              timeZone,
            });

            chatMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify(execution),
            });

            await sendEvent("tool", {
              id: toolCall.id,
              name: toolCall.function.name,
              success: execution.success,
            });
          }

          continue;
        }

        finalAssistantContent = result.content ?? "";
        break;
      }

      if (!finalAssistantContent.trim()) {
        finalAssistantContent = "I’m sorry, I wasn’t able to generate a detailed response this time.";
        await sendEvent("token", { text: finalAssistantContent });
      }

      const assistantMessage = await prisma.chatMessage.create({
        data: {
          threadId: resolvedThread.id,
          role: "assistant",
          content: finalAssistantContent,
          status: "complete",
        },
      });

      await prisma.chatThread.update({
        where: { id: resolvedThread.id },
        data: {
          summary: finalAssistantContent.slice(0, 160),
        },
      });

      await sendEvent("complete", {
        messageId: assistantMessage.id,
        content: finalAssistantContent,
        createdAt: assistantMessage.createdAt.toISOString(),
        status: assistantMessage.status,
      });
    } catch (error) {
      let message = "Unable to generate a response right now.";

      if (isPrismaKnownRequestError(error)) {
        if (PRISMA_MIGRATION_ERROR_CODES.has(error.code)) {
          message = "Database migrations are pending. Run `npx prisma migrate dev` to provision chat tables.";
        } else {
          message = error.message;
        }
      } else if (error instanceof Error) {
        message = error.message;
        if (error.message.includes("OPENAI_API_KEY")) {
          message = "Chat responses require OPENAI_API_KEY to be set. Update your environment and retry.";
        }
      }

      if (resolvedThreadId) {
        try {
          await prisma.chatMessage.create({
            data: {
              threadId: resolvedThreadId,
              role: "assistant",
              content: message,
              status: "error",
            },
          });
          await prisma.chatThread.update({
            where: { id: resolvedThreadId },
            data: {
              summary: lastUserMessageContent.slice(0, 160),
            },
          });
        } catch {
          // ignore persistence errors while reporting the failure to the client
        }
      }

      await sendError(message);
    } finally {
      await sendEvent("done", {});
      try {
        await writer.close();
      } catch {
        // stream already closed
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
