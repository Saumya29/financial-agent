import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { exchangeHubspotCode, getAppBaseUrl } from "@/lib/hubspot";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const cookieStore = await cookies();
  const storedState = cookieStore.get("hubspot_oauth_state")?.value;

  const redirectBase = getAppBaseUrl();
  const redirectUrl = new URL("/settings/integrations", redirectBase);

  if (error) {
    redirectUrl.searchParams.set("hubspot", error);
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }

  if (!code || !state) {
    redirectUrl.searchParams.set("hubspot", "missing_code");
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }

  if (!storedState || storedState !== state) {
    redirectUrl.searchParams.set("hubspot", "invalid_state");
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }

  const session = await auth();
  if (!session?.user) {
    redirectUrl.searchParams.set("hubspot", "unauthorized");
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }

  try {
    const tokenResponse = await exchangeHubspotCode(code);
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);
    const portalId = tokenResponse.hub_id.toString();

    const existingCredential = await prisma.oAuthCredential.findUnique({
      where: {
        userId_provider: {
          userId: session.user.id,
          provider: "hubspot",
        },
      },
    });

    const encryptedRefresh = tokenResponse.refresh_token
      ? encrypt(tokenResponse.refresh_token)
      : existingCredential?.refreshToken ?? null;

    await prisma.oAuthCredential.upsert({
      where: {
        userId_provider: {
          userId: session.user.id,
          provider: "hubspot",
        },
      },
      create: {
        userId: session.user.id,
        provider: "hubspot",
        providerAccountId: portalId,
        accessToken: encrypt(tokenResponse.access_token),
        refreshToken: encryptedRefresh,
        expiresAt,
        scope: tokenResponse.scope,
        tokenType: tokenResponse.token_type,
        encryptionKey: "v1",
      },
      update: {
        providerAccountId: portalId,
        accessToken: encrypt(tokenResponse.access_token),
        refreshToken: encryptedRefresh,
        expiresAt,
        scope: tokenResponse.scope,
        tokenType: tokenResponse.token_type,
        updatedAt: new Date(),
      },
    });

    await prisma.hubspotPortal.upsert({
      where: {
        userId_portalId: {
          userId: session.user.id,
          portalId,
        },
      },
      create: {
        userId: session.user.id,
        portalId,
      },
      update: {
        updatedAt: new Date(),
      },
    });

    redirectUrl.searchParams.set("hubspot", "connected");
    const response = NextResponse.redirect(redirectUrl, { status: 302 });
    response.cookies.set("hubspot_oauth_state", "", {
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (err) {
    redirectUrl.searchParams.set("hubspot", "error");
    redirectUrl.searchParams.set("message", (err as Error).message);
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }
}
