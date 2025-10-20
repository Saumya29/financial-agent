import { Prisma, AgentTaskType, AgentTaskStatus, InstructionStatus, TaskStepStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type InstructionInput = {
  title: string;
  content: string;
  triggers?: string[];
  metadata?: Prisma.JsonValue;
};

export type InstructionEvent = {
  type: string;
  payload?: Prisma.JsonValue;
  occurredAt?: Date;
};

export async function createInstruction(userId: string, input: InstructionInput) {
  return prisma.instruction.create({
    data: {
      userId,
      title: input.title,
      content: input.content,
      triggers: input.triggers ? input.triggers : Prisma.DbNull,
      metadata: input.metadata ? input.metadata : Prisma.DbNull,
    },
  });
}

export async function updateInstructionStatus(instructionId: string, status: InstructionStatus) {
  return prisma.instruction.update({
    where: { id: instructionId },
    data: {
      status,
    },
  });
}

export async function evaluateInstructionsForEvent(userId: string, event: InstructionEvent) {
  const instructions = await prisma.instruction.findMany({
    where: {
      userId,
      status: InstructionStatus.active,
    },
  });

  const matched = instructions.filter((instruction) => {
    const triggers = Array.isArray(instruction.triggers) ? (instruction.triggers as string[]) : [];
    return triggers.includes(event.type);
  });

  const evaluations: Array<{ instructionId: string; taskId: string }> = [];

  for (const instruction of matched) {
    const evaluation = await prisma.$transaction(async (tx) => {
      const evaluationRecord = await tx.instructionEvaluation.create({
        data: {
          userId,
          instructionId: instruction.id,
          eventType: event.type,
          eventPayload: event.payload ? event.payload : Prisma.DbNull,
          outcome: "matched",
        },
      });

      await tx.instruction.update({
        where: { id: instruction.id },
        data: {
          lastEvaluatedAt: event.occurredAt ?? new Date(),
        },
      });

      const task = await tx.agentTask.create({
        data: {
          userId,
          instructionId: instruction.id,
          type: AgentTaskType.instruction,
          status: AgentTaskStatus.pending,
          summary: instruction.title,
          metadata: {
            instructionContent: instruction.content,
            eventType: event.type,
            evaluationId: evaluationRecord.id,
          },
        },
      });

      if (event.payload) {
        await tx.taskContext.create({
          data: {
            taskId: task.id,
            key: "event",
            value: event.payload,
          },
        });
      }

      await tx.taskStep.create({
        data: {
          taskId: task.id,
          index: 0,
          title: "Evaluate instruction",
          status: TaskStepStatus.pending,
          input: {
            instruction: instruction.content,
            eventType: event.type,
          },
        },
      });

      return { instructionId: instruction.id, taskId: task.id };
    });

    evaluations.push(evaluation);
  }

  return evaluations;
}
