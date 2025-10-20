import { getHubspotAccessToken } from "@/lib/hubspot/token";
import { ingestHubspotContact } from "@/lib/sync";

export type HubspotContactInput = {
  contactId?: string;
  properties: Record<string, unknown>;
};

export async function createOrUpdateHubspotContact(userId: string, input: HubspotContactInput) {
  const { accessToken } = await getHubspotAccessToken(userId);

  const ENDPOINT = "https://api.hubapi.com/crm/v3/objects/contacts";
  const body = JSON.stringify({ properties: input.properties });
  let response: Response;

  if (input.contactId) {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(input.contactId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });
  } else {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to upsert HubSpot contact: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as { id: string };

  try {
    await ingestHubspotContact(userId, payload.id);
  } catch (error) {
    console.warn(`Failed to ingest HubSpot contact ${payload.id}:`, error);
  }

  return payload;
}

