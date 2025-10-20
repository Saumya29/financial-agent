import { getGoogleAccessToken } from "@/lib/google/token";
import { ingestGmailMessage } from "@/lib/sync";

type GmailSendResponse = {
  id: string;
  threadId: string;
  labelIds?: string[];
};

export type GmailMessagePayload = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  threadId?: string;
  references?: string[];
  inReplyTo?: string;
};

export async function sendGmailMessage(userId: string, payload: GmailMessagePayload) {
  const { accessToken } = await getGoogleAccessToken(userId);
  const mime = buildMimeMessage(payload);

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: mime,
      threadId: payload.threadId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to send Gmail message: ${detail || response.statusText}`);
  }

  const result = (await response.json()) as GmailSendResponse;

  try {
    await ingestGmailMessage(userId, result.id);
  } catch (error) {
    console.warn(`Failed to ingest sent Gmail message ${result.id}:`, error);
  }

  return result;
}

export async function draftGmailMessage(userId: string, payload: GmailMessagePayload) {
  const { accessToken } = await getGoogleAccessToken(userId);
  const mime = buildMimeMessage(payload);

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        raw: mime,
        threadId: payload.threadId,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to create Gmail draft: ${detail || response.statusText}`);
  }

  return response.json() as Promise<{
    id: string;
    message: GmailSendResponse;
  }>;
}

function buildMimeMessage(payload: GmailMessagePayload) {
  if (!payload.text && !payload.html) {
    throw new Error("Either text or html content must be provided to compose a Gmail message");
  }

  const lines: string[] = [];

  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: multipart/alternative; boundary=boundary123");
  lines.push(`Subject: ${encodeHeader(payload.subject)}`);
  lines.push(`To: ${payload.to.join(", ")}`);

  if (payload.cc?.length) {
    lines.push(`Cc: ${payload.cc.join(", ")}`);
  }

  if (payload.bcc?.length) {
    lines.push(`Bcc: ${payload.bcc.join(", ")}`);
  }

  if (payload.inReplyTo) {
    lines.push(`In-Reply-To: ${payload.inReplyTo}`);
  }

  if (payload.references?.length) {
    lines.push(`References: ${payload.references.join(" ")}`);
  }

  lines.push("");
  lines.push("--boundary123");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(payload.text ?? "");

  if (payload.html) {
    lines.push("--boundary123");
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(payload.html);
  }

  lines.push("--boundary123--");

  const message = lines.join("\r\n");
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeader(input: string) {
  if (/^[\x20-\x7E]*$/.test(input)) {
    return input;
  }

  const encoded = Buffer.from(input, "utf8").toString("base64");
  return `=?utf-8?B?${encoded}?=`;
}
