import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/encryption";

import { getHubspotClient } from "../hubspot";

type HubspotTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
};

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

export async function getHubspotAccessToken(userId: string) {
  const credential = await prisma.oAuthCredential.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: "hubspot",
      },
    },
  });

  if (!credential) {
    throw new Error("HubSpot account is not connected for this user");
  }

  const accessToken = credential.accessToken ? decrypt(credential.accessToken) : null;
  const refreshToken = credential.refreshToken ? decrypt(credential.refreshToken) : null;
  const expiresAt = credential.expiresAt ?? undefined;

  if (accessToken && expiresAt && expiresAt.getTime() > Date.now() - 60_000) {
    return {
      accessToken,
      refreshToken,
      expiresAt,
      portalId: credential.providerAccountId ?? null,
    };
  }

  if (!refreshToken) {
    throw new Error("HubSpot refresh token is unavailable. Reconnect the integration to continue");
  }

  const refreshed = await refreshHubspotAccessToken(userId, refreshToken);

  return {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? refreshToken,
    expiresAt: addSeconds(new Date(), refreshed.expires_in),
    portalId: credential.providerAccountId ?? null,
  };
}

async function refreshHubspotAccessToken(userId: string, refreshToken: string) {
  const { id, secret } = getHubspotClient();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret,
  });

  const response = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to refresh HubSpot access token: ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as HubspotTokenResponse;
  const expiresAt = addSeconds(new Date(), payload.expires_in);

  await prisma.oAuthCredential.update({
    where: {
      userId_provider: {
        userId,
        provider: "hubspot",
      },
    },
    data: {
      accessToken: encrypt(payload.access_token),
      refreshToken: payload.refresh_token ? encrypt(payload.refresh_token) : undefined,
      expiresAt,
      scope: payload.scope ?? undefined,
      tokenType: payload.token_type ?? undefined,
      updatedAt: new Date(),
    },
  });

  return payload;
}
