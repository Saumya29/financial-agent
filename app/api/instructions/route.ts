import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createInstruction } from "@/lib/instructions";

const InstructionSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  triggers: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
});

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instructions = await prisma.instruction.findMany({
    where: {
      userId: session.user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return NextResponse.json({ instructions });
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = InstructionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const instruction = await createInstruction(session.user.id, parsed.data);
    return NextResponse.json({ instruction }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create instruction";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
