import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { InstructionStatus } from "@prisma/client";

const UpdateSchema = z.object({
  status: z.nativeEnum(InstructionStatus).optional(),
  triggers: z.array(z.string()).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ instructionId: string }> }) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = UpdateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const updates = parsed.data;

  const { instructionId } = await params;

  const instruction = await prisma.instruction.findFirst({
    where: {
      id: instructionId,
      userId: session.user.id,
    },
  });

  if (!instruction) {
    return NextResponse.json({ error: "Instruction not found" }, { status: 404 });
  }

  const result = await prisma.instruction.update({
    where: { id: instruction.id },
    data: {
      status: updates.status ?? undefined,
      triggers: updates.triggers ?? undefined,
      title: updates.title ?? undefined,
      content: updates.content ?? undefined,
      metadata: updates.metadata ?? undefined,
    },
  });

  return NextResponse.json({ instruction: result });
}
