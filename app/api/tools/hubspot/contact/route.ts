import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { createOrUpdateHubspotContact } from "@/lib/tools/hubspot";

const ContactSchema = z.object({
  contactId: z.string().optional(),
  properties: z.record(z.any()),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = ContactSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await createOrUpdateHubspotContact(session.user.id, parsed.data);
    return NextResponse.json({ contactId: result.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upsert contact";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
