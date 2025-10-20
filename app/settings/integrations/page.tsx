import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/logout-button";
import { prisma } from "@/lib/prisma";
import { SyncProvider } from "@prisma/client";
import type { SyncState } from "@prisma/client";

import { SyncButton } from "./sync-button";

type SearchParams = Record<string, string | string[] | undefined>;

type PageProps = {
  searchParams: Promise<SearchParams>;
};

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [
    googleAccount,
    hubspotPortal,
    syncStates,
    emailMessageCount,
    emailThreadCount,
    calendarEventCount,
    hubspotContactCount,
  ] = await Promise.all([
    prisma.account.findFirst({
      where: { userId: session.user.id, provider: "google" },
    }),
    prisma.hubspotPortal.findFirst({
      where: { userId: session.user.id },
    }),
    prisma.syncState.findMany({
      where: { userId: session.user.id },
    }),
    prisma.emailMessage.count({ where: { userId: session.user.id } }),
    prisma.emailThread.count({ where: { userId: session.user.id } }),
    prisma.calendarEvent.count({ where: { userId: session.user.id } }),
    prisma.hubspotContact.count({ where: { userId: session.user.id } }),
  ]);

  const params = await searchParams;

  const hubspotStatus =
    typeof params.hubspot === "string" ? params.hubspot : undefined;
  const syncStatus =
    typeof params.syncStatus === "string" ? params.syncStatus : undefined;
  const syncProvider =
    typeof params.provider === "string" ? params.provider : undefined;
  const syncMessage =
    typeof params.message === "string"
      ? decodeURIComponent(params.message)
      : undefined;

  const gmailSyncState = pickLatestState(
    syncStates,
    SyncProvider.gmail,
    "primary"
  );
  const calendarSyncState = pickLatestState(
    syncStates,
    SyncProvider.calendar,
    "primary"
  );
  const hubspotSyncState = pickLatestState(
    syncStates,
    SyncProvider.hubspot,
    "contacts"
  );

  const numberFormatter = new Intl.NumberFormat("en-US");

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex items-center justify-between mb-4">
          <Link
            href="/"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back to home
          </Link>
          <LogoutButton />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Integrations
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect your productivity stack so the agent can automate workflows.
        </p>

        {syncStatus ? (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-sm sm:px-5 sm:py-4 ${
              syncStatus === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            <p className="font-medium">
              {syncStatus === "success" ? "Sync complete" : "Sync failed"}
            </p>
            <p className="mt-1 text-xs sm:text-sm">
              {syncStatus === "success"
                ? `Latest ${getProviderLabel(
                    syncProvider
                  )} data is now available.`
                : syncMessage ?? "Please try again or verify credentials."}
            </p>
          </div>
        ) : null}

        {hubspotStatus ? (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-sm sm:px-5 sm:py-4 ${
              hubspotStatus === "connected"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            <p className="font-medium">
              {hubspotStatus === "connected"
                ? "HubSpot connected successfully"
                : "Unable to connect HubSpot"}
            </p>
            {hubspotStatus === "error" && (
              <p className="mt-1 text-xs sm:text-sm">
                Please try again or check your HubSpot permissions.
              </p>
            )}
          </div>
        ) : null}

        <section className="mt-6 space-y-6 sm:mt-8 sm:space-y-8">
          <div className="rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold sm:text-xl">
                  Google Workspace
                </h2>
                <p className="text-xs text-muted-foreground sm:text-sm">
                  Required for Gmail and Google Calendar access.
                </p>
              </div>
              <span
                className={`text-xs font-medium sm:text-sm ${
                  googleAccount ? "text-green-600" : "text-muted-foreground"
                }`}
              >
                {googleAccount ? "Connected" : "Not connected"}
              </span>
            </header>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SyncMeta
                label="Last Gmail sync"
                value={formatSyncTimestamp(gmailSyncState?.lastSyncAt)}
              />
              <SyncMeta
                label="Gmail messages indexed"
                value={numberFormatter.format(emailMessageCount)}
              />
              <SyncMeta
                label="Threads tracked"
                value={numberFormatter.format(emailThreadCount)}
              />
              <SyncMeta
                label="Label filters"
                value={
                  readMetadataValue(gmailSyncState?.metadata, "labelIds") ??
                  "Inbox"
                }
              />
            </div>
            <p className="mt-4 text-xs text-muted-foreground sm:text-sm">
              Each sync scans roughly 30 days of Inbox mail (up to about 150
              messages per run). Rerun to continue backfilling.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground sm:text-sm">
                {gmailSyncState?.updatedAt
                  ? `Updated ${formatRelativeTime(gmailSyncState.updatedAt)}`
                  : "No sync has been run yet."}
              </span>
              <SyncButton
                provider="gmail"
                disabled={!googleAccount}
                pendingLabel="Syncing Gmail..."
              >
                Sync Gmail now
              </SyncButton>
            </div>
            {!googleAccount ? (
              <div className="mt-4">
                <Button asChild className="w-full sm:w-auto">
                  <Link href="/login">Connect Google</Link>
                </Button>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold sm:text-xl">
                  Google Calendar
                </h2>
                <p className="text-xs text-muted-foreground sm:text-sm">
                  Keep meetings and follow-ups in sync for proactive assistance.
                </p>
              </div>
              <span
                className={`text-xs font-medium sm:text-sm ${
                  googleAccount ? "text-green-600" : "text-muted-foreground"
                }`}
              >
                {googleAccount ? "Connected" : "Requires Google auth"}
              </span>
            </header>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SyncMeta
                label="Last calendar sync"
                value={formatSyncTimestamp(calendarSyncState?.lastSyncAt)}
              />
              <SyncMeta
                label="Events indexed"
                value={numberFormatter.format(calendarEventCount)}
              />
              <SyncMeta
                label="Tracked calendar"
                value={calendarSyncState?.resourceId ?? "primary"}
              />
              <SyncMeta label="Sync range" value="30 days forward" />
            </div>
            <p className="mt-4 text-xs text-muted-foreground sm:text-sm">
              Each sync indexes calendar events updated in roughly the last 30
              days (up to 100 events per run).
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground sm:text-sm">
                {calendarSyncState?.updatedAt
                  ? `Last synced ${formatRelativeTime(
                      calendarSyncState.updatedAt
                    )}`
                  : "No sync has been run yet."}
              </span>
              <SyncButton
                provider="calendar"
                disabled={!googleAccount}
                pendingLabel="Syncing Calendar..."
              >
                Sync Calendar now
              </SyncButton>
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold sm:text-xl">
                  HubSpot CRM
                </h2>
                <p className="text-xs text-muted-foreground sm:text-sm">
                  Sync contacts today; companies and deals support is coming
                  soon.
                </p>
              </div>
              <span
                className={`text-xs font-medium sm:text-sm ${
                  hubspotPortal ? "text-green-600" : "text-muted-foreground"
                }`}
              >
                {hubspotPortal ? "Connected" : "Not connected"}
              </span>
            </header>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SyncMeta
                label="Last CRM sync"
                value={formatSyncTimestamp(hubspotSyncState?.lastSyncAt)}
              />
              <SyncMeta
                label="Contacts indexed"
                value={numberFormatter.format(hubspotContactCount)}
              />
            </div>
            <p className="mt-4 text-xs text-muted-foreground sm:text-sm">
              We process HubSpot contacts in batches of up to 500 records per
              sync run, ordered by last modified date.
            </p>
            <p className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground/70">
              HubSpot scopes: crm.objects.contacts.read,
              crm.objects.contacts.write, crm.objects.companies.read,
              crm.objects.deals.read, crm.objects.owners.read
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-muted-foreground sm:text-sm">
                {hubspotStatus === "connected" && (
                  <span className="text-green-600">
                    HubSpot connected successfully.
                  </span>
                )}
                {hubspotStatus === "error" && (
                  <span className="text-red-600">
                    Unable to connect HubSpot.
                  </span>
                )}
                {hubspotSyncState?.updatedAt ? (
                  <span className="block text-muted-foreground">
                    Updated {formatRelativeTime(hubspotSyncState.updatedAt)}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                {!hubspotPortal && (
                  <Button asChild className="w-full sm:w-auto">
                    <Link href="/api/hubspot/authorize">Connect HubSpot</Link>
                  </Button>
                )}
                <SyncButton
                  provider="hubspot"
                  disabled={!hubspotPortal}
                  pendingLabel="Syncing HubSpot..."
                >
                  Sync HubSpot now
                </SyncButton>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function pickLatestState(
  states: SyncState[],
  provider: SyncProvider,
  resourceId?: string | null
) {
  const matches = states.filter((state) => {
    if (state.provider !== provider) {
      return false;
    }
    if (resourceId === undefined) {
      return true;
    }
    return state.resourceId === resourceId;
  });
  if (!matches.length) return undefined;
  return matches.reduce<SyncState | undefined>((latest, current) => {
    if (!latest) return current;
    return current.updatedAt > latest.updatedAt ? current : latest;
  }, undefined);
}

function formatSyncTimestamp(value?: Date | null) {
  if (!value) {
    return "Never";
  }
  return `${formatRelativeTime(value)} • ${value.toLocaleString()}`;
}

function formatRelativeTime(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) {
    return diffMs >= 0 ? "just now" : "in <1m";
  }

  const diffMinutes = Math.round(absMs / 60_000);
  if (diffMinutes < 60) {
    return diffMs >= 0 ? `${diffMinutes}m ago` : `in ${diffMinutes}m`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return diffMs >= 0 ? `${diffHours}h ago` : `in ${diffHours}h`;
  }

  const diffDays = Math.round(diffHours / 24);
  return diffMs >= 0 ? `${diffDays}d ago` : `in ${diffDays}d`;
}

function getProviderLabel(provider?: string) {
  switch (provider) {
    case "gmail":
      return "Gmail";
    case "calendar":
      return "Google Calendar";
    case "hubspot":
      return "HubSpot";
    default:
      return "integration";
  }
}

function readMetadataValue(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  const value = record[key];

  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  const stringValue = String(value).trim();
  return stringValue.length ? stringValue : undefined;
}

function SyncMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background/70 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {label}
      </p>
      <p className="mt-1 text-sm text-foreground">{value}</p>
    </div>
  );
}
