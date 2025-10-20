import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const ParamsSchema = z.object({
  threadId: z.string(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const parseResult = ParamsSchema.safeParse(params);

  if (!parseResult.success) {
    return NextResponse.json({ error: "Invalid thread id" }, { status: 400 });
  }

  const { threadId } = parseResult.data;

  const thread = await prisma.chatThread.findFirst({
    where: {
      id: threadId,
      userId: session.user.id,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: 100,
      },
    },
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  return NextResponse.json({
    thread: {
      id: thread.id,
      title: thread.title ?? "Untitled chat",
      summary: thread.summary ?? "",
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
        metadata: message.metadata,
      })),
    },
  });
}
