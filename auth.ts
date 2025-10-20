import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";
import { GOOGLE_SCOPES, getGoogleClient } from "@/lib/google/config";

const GOOGLE_SCOPE_STRING = GOOGLE_SCOPES.join(" ");

async function storeGoogleCredential(params: {
  userId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  tokenType?: string | null;
}) {
  const { userId, accessToken, refreshToken, expiresAt, scope, tokenType } = params;

  const existing = await prisma.oAuthCredential.findUnique({
    where: { userId_provider: { userId, provider: "google" } },
  });

  const encryptedRefresh = refreshToken
    ? encrypt(refreshToken)
    : existing?.refreshToken ?? null;
  const encryptedAccess = accessToken
    ? encrypt(accessToken)
    : existing?.accessToken ?? null;

  await prisma.oAuthCredential.upsert({
    where: { userId_provider: { userId, provider: "google" } },
    create: {
      userId,
      provider: "google",
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: expiresAt ? new Date(expiresAt * 1000) : null,
      scope: scope ?? undefined,
      tokenType: tokenType ?? undefined,
      encryptionKey: "v1",
    },
    update: {
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: expiresAt ? new Date(expiresAt * 1000) : null,
      scope: scope ?? undefined,
      tokenType: tokenType ?? undefined,
      updatedAt: new Date(),
    },
  });
}

const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleClient();

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Google({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorization: {
        params: {
          scope: GOOGLE_SCOPE_STRING,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        if (token.email) {
          session.user.email = token.email;
        }
        if (token.name) {
          session.user.name = token.name;
        }
      }
      return session;
    },
  },
  events: {
    async linkAccount({ user, account }) {
      if (account?.provider === "google") {
        await storeGoogleCredential({
          userId: user.id,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          scope: account.scope,
          tokenType: account.token_type,
        });
      }
    },
    async signIn({ user, account }) {
      if (account?.provider === "google") {
        await storeGoogleCredential({
          userId: user.id,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          scope: account.scope,
          tokenType: account.token_type,
        });
      }
    },
  },
});
