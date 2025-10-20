const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

export const HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "oauth",
  "crm.schemas.contacts.read",
];

export function getAppBaseUrl() {
  return process.env.APP_BASE_URL ?? "http://localhost:3000";
}

export function getHubspotClient() {
  const id = process.env.HUBSPOT_CLIENT_ID;
  const secret = process.env.HUBSPOT_CLIENT_SECRET;

  if (!id || !secret) {
    throw new Error("HubSpot client credentials are not configured");
  }

  return { id, secret };
}

export function buildHubspotAuthorizeUrl(state: string) {
  const client = getHubspotClient();
  const redirectUri = `${getAppBaseUrl()}/api/hubspot/callback`;
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: HUBSPOT_SCOPES.join(" "),
    state,
  });

  return `${HUBSPOT_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeHubspotCode(code: string) {
  const client = getHubspotClient();
  const redirectUri = `${getAppBaseUrl()}/api/hubspot/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot token exchange failed: ${errorText}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
    hub_id: number;
  }>;
}
