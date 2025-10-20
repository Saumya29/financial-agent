import { NextResponse } from "next/server";
import crypto from "crypto";

import { auth } from "@/auth";
import { buildHubspotAuthorizeUrl } from "@/lib/hubspot";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const state = crypto.randomUUID();
  const url = buildHubspotAuthorizeUrl(state);

  const response = NextResponse.redirect(url, { status: 302 });
  response.cookies.set("hubspot_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
    sameSite: "lax",
  });

  return response;
}
