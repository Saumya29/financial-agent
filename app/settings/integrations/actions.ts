"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import {
  syncCalendarEvents,
  syncGmailMailbox,
  syncHubspotContacts,
} from "@/lib/sync";

type Provider = "gmail" | "calendar" | "hubspot";

export async function runProviderSync(provider: Provider) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const userId = session.user.id;

  try {
    switch (provider) {
      case "gmail":
        await syncGmailMailbox(userId, { maxPages: 2, pageSize: 25 });
        break;
      case "calendar":
        await syncCalendarEvents(userId, { maxResults: 250 });
        break;
      case "hubspot":
        await syncHubspotContacts(userId, { maxPages: 2, limit: 50 });
        break;
      default:
        throw new Error("Unsupported provider");
    }

    revalidatePath("/settings/integrations");
    redirect(`/settings/integrations?syncStatus=success&provider=${provider}`);
  } catch (error) {
    revalidatePath("/settings/integrations");
    if (
      error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest?: unknown }).digest === "string" &&
      (error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Sync failed";
    console.error(`Failed to run ${provider} sync`, error);
    redirect(
      `/settings/integrations?syncStatus=error&provider=${provider}&message=${encodeURIComponent(
        message
      )}`
    );
  }
}
