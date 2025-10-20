import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/encryption";

import { GOOGLE_TOKEN_URL, getGoogleClient } from "./config";

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

export async function getGoogleAccessToken(userId: string) {
  const credential = await prisma.oAuthCredential.findUnique({
    where: { userId_provider: { userId, provider: "google" } },
  });

  if (!credential) {
    throw new Error("Google account is not connected for this user");
  }

  const accessToken = credential.accessToken ? decrypt(credential.accessToken) : null;
  const refreshToken = credential.refreshToken ? decrypt(credential.refreshToken) : null;
  const expiresAt = credential.expiresAt ?? undefined;

  if (accessToken && expiresAt && expiresAt.getTime() > Date.now() - 60_000) {
    return {
      accessToken,
      refreshToken,
      expiresAt,
      scope: credential.scope ?? undefined,
      tokenType: credential.tokenType ?? undefined,
    };
  }

  if (!refreshToken) {
    throw new Error("Google refresh token is unavailable. Reconnect the integration to continue");
  }

  const refreshed = await refreshGoogleAccessToken(userId, refreshToken);
  return {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? refreshToken,
    expiresAt: addSeconds(new Date(), refreshed.expires_in),
    scope: refreshed.scope,
    tokenType: refreshed.token_type,
  };
}

async function refreshGoogleAccessToken(userId: string, refreshToken: string) {
  const { clientId, clientSecret } = getGoogleClient();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google access token: ${errorText || response.statusText}`);
  }

  const payload = (await response.json()) as GoogleTokenResponse;
  const expiresAt = addSeconds(new Date(), payload.expires_in);

  await prisma.oAuthCredential.update({
    where: { userId_provider: { userId, provider: "google" } },
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
