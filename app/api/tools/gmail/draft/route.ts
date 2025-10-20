import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { draftGmailMessage } from "@/lib/tools/gmail";

const DraftSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  text: z.string().optional(),
  html: z.string().optional(),
  threadId: z.string().optional(),
  references: z.array(z.string()).optional(),
  inReplyTo: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = DraftSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { to, cc, bcc, subject, text, html, threadId, references, inReplyTo } = parsed.data;

  if (!text && !html) {
    return NextResponse.json({ error: "Either text or html body is required" }, { status: 400 });
  }

  try {
    const response = await draftGmailMessage(session.user.id, {
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      threadId,
      references,
      inReplyTo,
    });

    return NextResponse.json({ draftId: response.id, messageId: response.message.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create draft";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
