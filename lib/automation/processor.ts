import { Prisma, AgentTaskStatus, TaskStepStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildRetrievalContextForPrompt } from "@/lib/retrieval";
import { getAgentToolDefinitions, executeAgentTool } from "@/lib/agent/tools";
import { runModelIteration } from "@/lib/agent/model";
import type { ChatCompletionMessage, ChatToolDefinition } from "@/lib/openai";

type AgentTaskWithRelations = Prisma.AgentTaskGetPayload<{
  include: {
    steps: true;
    contexts: true;
    instruction: true;
  };
}>;

type ProcessAgentTasksOptions = {
  limit?: number;
  userId?: string;
};

type ProcessResultStatus = "completed" | "skipped" | "failed";

export type ProcessAgentTasksResult = {
  taskId: string;
  status: ProcessResultStatus;
  error?: string;
};

const AUTOMATION_SYSTEM_PROMPT = `You are the background automation agent for a financial advisor.
Work autonomously to advance each assigned task. You can call tools to send email, manage
calendar events, read synced data via searchKnowledge, and update HubSpot contacts. Take
decisive actions, summarise what you accomplished, and schedule additional follow-ups with
scheduleFollowUpTask when the workflow needs to continue later.`;

export async function processPendingAgentTasks(options: ProcessAgentTasksOptions = {}) {
  const now = new Date();
  const limit = options.limit ?? 5;

  const dueTasks = await prisma.agentTask.findMany({
    where: {
      status: {
        in: [AgentTaskStatus.pending, AgentTaskStatus.waiting],
      },
      ...(options.userId ? { userId: options.userId } : {}),
      OR: [
        { scheduledFor: null },
        {
          scheduledFor: {
            lte: now,
          },
        },
      ],
    },
    select: {
      id: true,
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  const results: ProcessAgentTasksResult[] = [];

  for (const task of dueTasks) {
    const outcome = await processAgentTaskById(task.id);
    results.push(outcome);
  }

  return results;
}

async function processAgentTaskById(taskId: string): Promise<ProcessAgentTasksResult> {
  const claim = await prisma.agentTask.updateMany({
    where: {
      id: taskId,
      status: {
        in: [AgentTaskStatus.pending, AgentTaskStatus.waiting],
      },
    },
    data: {
      status: AgentTaskStatus.running,
      startedAt: new Date(),
    },
  });

  if (claim.count === 0) {
    return { taskId, status: "skipped" };
  }

  try {
    const taskRecord = await prisma.agentTask.findUnique({
      where: { id: taskId },
      include: {
        steps: {
          orderBy: { index: "asc" },
        },
        contexts: true,
        instruction: true,
      },
    });

    if (!taskRecord) {
      return { taskId, status: "failed", error: "Task not found after claim" };
    }

    const task: AgentTaskWithRelations = taskRecord;

    let nextStep = task.steps.find((step) =>
      step.status === TaskStepStatus.pending || step.status === TaskStepStatus.running,
    );

    if (!nextStep) {
      nextStep = await prisma.taskStep.create({
        data: {
          taskId: task.id,
          index: task.steps.length,
          title: task.summary ?? "Process task",
          status: TaskStepStatus.pending,
        },
      });
    }

    if (nextStep.status === TaskStepStatus.pending) {
      nextStep = await prisma.taskStep.update({
        where: { id: nextStep.id },
        data: {
          status: TaskStepStatus.running,
          startedAt: new Date(),
        },
      });
    }

    const execution = await runTaskAutomation({ task, step: nextStep });

    await prisma.taskStep.update({
      where: { id: nextStep.id },
      data: {
        status: TaskStepStatus.completed,
        completedAt: new Date(),
        output: execution.output,
        error: Prisma.DbNull,
      },
    });

    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        status: AgentTaskStatus.completed,
        completedAt: new Date(),
        summary: execution.summary ?? task.summary,
        metadata: mergeTaskMetadata(task.metadata, execution.taskMetadata),
      },
    });

    return { taskId: task.id, status: "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task processing failed";

    await prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: AgentTaskStatus.failed,
        errorMessage: message,
      },
    });

    await prisma.taskStep.updateMany({
      where: {
        taskId,
        status: TaskStepStatus.running,
      },
      data: {
        status: TaskStepStatus.failed,
        completedAt: new Date(),
        error: message,
      },
    });

    return { taskId, status: "failed", error: message };
  }
}

type RunTaskParams = {
  task: AgentTaskWithRelations;
  step: {
    id: string;
    title: string;
    input: Prisma.JsonValue | null;
  };
};

type TaskExecutionResult = {
  messages: string[];
  summary?: string;
  output: Prisma.InputJsonValue;
  taskMetadata?: Prisma.InputJsonValue;
};

async function runTaskAutomation({ task, step }: RunTaskParams): Promise<TaskExecutionResult> {
  if (!task) {
    throw new Error("Task context was not provided");
  }

  const toolDefinitions = getAgentToolDefinitions();
  const chatMessages: ChatCompletionMessage[] = [
    {
      role: "system",
      content: AUTOMATION_SYSTEM_PROMPT,
    },
  ];

  const retrieval = await buildRetrievalContextForPrompt(task.userId, task.summary ?? "", {
    emailLimit: 5,
    calendarLimit: 5,
    contactLimit: 5,
  });

  chatMessages.push({
    role: "user",
    content: buildTaskPrompt(task, step, retrieval),
  });

  const executedTools: Array<{
    id: string;
    name: string;
    arguments: unknown;
    success: boolean;
    result?: unknown;
    error?: string;
  }> = [];

  let assistantContent = "";
  const maxIterations = 6;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let streamedContent = "";
    const result = await runModelIteration({
      chatMessages,
      toolDefinitions: toolDefinitions as ChatToolDefinition[],
      onToken: async (text) => {
        streamedContent += text;
      },
    });

    if (result.type === "tool_calls") {
      chatMessages.push({
        role: "assistant",
        content: result.content ?? streamedContent,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const { name } = toolCall.function;
        const argsText = toolCall.function.arguments || "{}";
        let parsedArgs: unknown = argsText;
        try {
          parsedArgs = JSON.parse(argsText);
        } catch {
          // keep as raw string when not JSON
        }

        const execution = await executeAgentTool(name, argsText, { userId: task.userId });

        executedTools.push({
          id: toolCall.id,
          name,
          arguments: parsedArgs,
          success: execution.success,
          result: execution.success ? execution.result : undefined,
          error: execution.success ? undefined : execution.error,
        });

        chatMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(execution),
        });
      }

      continue;
    }

    assistantContent = result.content ?? streamedContent;
    break;
  }

  if (!assistantContent.trim()) {
    assistantContent = "Automation run completed without a detailed response.";
  }

  const output = toInputJson({
    assistant: assistantContent,
    tools: executedTools,
  });

  return {
    messages: [assistantContent],
    summary: assistantContent.slice(0, 160),
    output,
  };
}

function buildTaskPrompt(
  task: AgentTaskWithRelations,
  step: { title: string; input: Prisma.JsonValue | null },
  retrieval: Awaited<ReturnType<typeof buildRetrievalContextForPrompt>>,
) {
  const contextLines: string[] = [];

  contextLines.push(`Task ID: ${task.id}`);
  contextLines.push(`Task type: ${task.type}`);
  if (task.summary) {
    contextLines.push(`Summary: ${task.summary}`);
  }
  if (task.scheduledFor) {
    contextLines.push(`Scheduled for: ${task.scheduledFor.toISOString()}`);
  }

  if (task.instruction) {
    contextLines.push(`Instruction: ${task.instruction.title}\n${task.instruction.content}`);
  }

  if (task.metadata !== null) {
    contextLines.push(`Task metadata: ${JSON.stringify(task.metadata)}`);
  }

  if (task.contexts.length) {
    const entries = task.contexts
      .map((entry) => `${entry.key}: ${JSON.stringify(entry.value)}`)
      .join("\n");
    contextLines.push(`Task context entries:\n${entries}`);
  }

  if (step.input !== null) {
    contextLines.push(`Current step input: ${JSON.stringify(step.input)}`);
  }

  const emailSummaries = retrieval.emailSnippets
    .map((email) => `- ${email.subject ?? "(no subject)"} from ${email.from ?? "unknown"}`)
    .join("\n");
  if (emailSummaries) {
    contextLines.push(`Relevant email snippets:\n${emailSummaries}`);
  }

  const calendarSummaries = retrieval.calendarSnippets
    .map((event) => `- ${event.summary ?? "(no title)"} (${event.startTime ?? "time tbd"})`)
    .join("\n");
  if (calendarSummaries) {
    contextLines.push(`Relevant calendar events:\n${calendarSummaries}`);
  }

  const contactSummaries = retrieval.hubspotContacts
    .map((contact) => `- ${contact.fullName ?? contact.email ?? contact.contactId}`)
    .join("\n");
  if (contactSummaries) {
    contextLines.push(`Relevant HubSpot contacts:\n${contactSummaries}`);
  }

  contextLines.push(
    `Current step: ${step.title}. Move the workflow forward. Use tools if necessary and summarise the outcome.`,
  );

  return contextLines.join("\n\n");
}

function mergeTaskMetadata(
  existing: Prisma.JsonValue | null | undefined,
  updates: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (updates == null) {
    return existing == null ? Prisma.DbNull : toInputJson(existing);
  }

  if (existing == null) {
    return toInputJson(updates);
  }

  if (isPlainObject(existing) && isPlainObject(updates)) {
    return toInputJson({
      ...(existing as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    });
  }

  return toInputJson(updates);
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  const normalized = value ?? null;
  const serialized = JSON.stringify(normalized);

  if (serialized === undefined) {
    return JSON.parse("null") as Prisma.InputJsonValue;
  }

  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
