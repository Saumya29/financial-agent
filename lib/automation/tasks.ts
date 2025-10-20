import { Prisma, AgentTaskStatus, AgentTaskType, TaskStepStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type CreateTaskInput = {
  instructionId?: string;
  type: AgentTaskType;
  summary?: string;
  metadata?: Prisma.JsonValue;
  scheduledFor?: Date;
  context?: Array<{ key: string; value?: Prisma.JsonValue }>;
  steps?: Array<{
    title: string;
    status?: TaskStepStatus;
    input?: Prisma.JsonValue;
  }>;
};

export async function createAgentTask(userId: string, input: CreateTaskInput) {
  const task = await prisma.agentTask.create({
    data: {
      userId,
      instructionId: input.instructionId,
      type: input.type,
      summary: input.summary,
      metadata: input.metadata ? input.metadata : Prisma.DbNull,
      scheduledFor: input.scheduledFor,
    },
  });

  if (input.context?.length) {
    await prisma.taskContext.createMany({
      data: input.context.map((entry) => ({
        taskId: task.id,
        key: entry.key,
        value: entry.value ? entry.value : Prisma.DbNull,
      })),
    });
  }

  if (input.steps?.length) {
    await prisma.taskStep.createMany({
      data: input.steps.map((step, index) => ({
        taskId: task.id,
        index,
        title: step.title,
        status: step.status ?? TaskStepStatus.pending,
        input: step.input ? step.input : Prisma.DbNull,
      })),
    });
  }

  return prisma.agentTask.findUnique({
    where: { id: task.id },
    include: {
      steps: {
        orderBy: { index: "asc" },
      },
      contexts: true,
    },
  });
}

export async function scheduleFollowUpTask(userId: string, input: { summary: string; runAt: Date; metadata?: Prisma.JsonValue }) {
  return createAgentTask(userId, {
    type: AgentTaskType.followUp,
    summary: input.summary,
    scheduledFor: input.runAt,
    metadata: input.metadata,
  });
}

export async function updateAgentTaskStatus(taskId: string, status: AgentTaskStatus, options?: { errorMessage?: string; summary?: string }) {
  const now = new Date();
  const data: Prisma.AgentTaskUpdateInput = {
    status,
    summary: options?.summary ?? undefined,
  };

  if (status === AgentTaskStatus.running) {
    data.startedAt = data.startedAt ?? now;
  }

  if (status === AgentTaskStatus.completed) {
    data.completedAt = now;
    data.errorMessage = null;
  }

  if (status === AgentTaskStatus.failed) {
    data.errorMessage = options?.errorMessage ?? "Task failed";
  }

  if (status === AgentTaskStatus.cancelled) {
    data.cancelledAt = now;
  }

  return prisma.agentTask.update({
    where: { id: taskId },
    data,
  });
}

export async function appendTaskStep(taskId: string, input: { title: string; status?: TaskStepStatus; input?: Prisma.JsonValue }) {
  const count = await prisma.taskStep.count({ where: { taskId } });

  return prisma.taskStep.create({
    data: {
      taskId,
      index: count,
      title: input.title,
      status: input.status ?? TaskStepStatus.pending,
      input: input.input ? input.input : Prisma.DbNull,
    },
  });
}

export async function updateTaskStep(taskStepId: string, updates: {
  status?: TaskStepStatus;
  output?: Prisma.JsonValue;
  error?: Prisma.JsonValue;
}) {
  const data: Prisma.TaskStepUpdateInput = {};

  if (updates.status) {
    data.status = updates.status;
    if (updates.status === TaskStepStatus.running) {
      data.startedAt = new Date();
    }
    if (updates.status === TaskStepStatus.completed) {
      data.completedAt = new Date();
    }
    if (updates.status === TaskStepStatus.failed) {
      data.completedAt = new Date();
    }
  }

  if (updates.output !== undefined) {
    data.output = updates.output ? updates.output : Prisma.DbNull;
  }

  if (updates.error !== undefined) {
    data.error = updates.error ? updates.error : Prisma.DbNull;
  }

  return prisma.taskStep.update({
    where: { id: taskStepId },
    data,
  });
}

export async function setTaskContext(taskId: string, key: string, value: Prisma.JsonValue | null) {
  const dbValue = value ? value : Prisma.DbNull;
  return prisma.taskContext.upsert({
    where: {
      taskId_key: {
        taskId,
        key,
      },
    },
    create: {
      taskId,
      key,
      value: dbValue,
    },
    update: {
      value: dbValue,
    },
  });
}
