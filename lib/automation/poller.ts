import { prisma } from "@/lib/prisma";
import { processPendingAgentTasks, type ProcessAgentTasksResult } from "@/lib/automation/processor";
import { syncCalendarEvents, syncGmailMailbox, syncHubspotContacts } from "@/lib/sync";

type IntegrationSnapshot = {
  google: boolean;
  hubspot: boolean;
};

type UserCycleOutcome = {
  userId: string;
  integrations: IntegrationSnapshot;
  gmail?: { processed: number; created: number; updated: number } | { error: string };
  calendar?: { processed: number; created: number; updated: number } | { error: string };
  hubspot?: { processed: number; created: number; updated: number } | { error: string };
  tasks: ProcessAgentTasksResult[];
};

export type AutomationCycleResult = {
  usersProcessed: number;
  outcomes: UserCycleOutcome[];
};

type RunAutomationCycleOptions = {
  userId?: string;
  taskBatchSize?: number;
};

export async function runAutomationCycle(options: RunAutomationCycleOptions = {}): Promise<AutomationCycleResult> {
  const users = await prisma.user.findMany({
    where: options.userId ? { id: options.userId } : {},
    select: { id: true },
  });

  if (!users.length) {
    return { usersProcessed: 0, outcomes: [] };
  }

  const userIds = users.map((user) => user.id);

  const credentials = await prisma.oAuthCredential.findMany({
    where: {
      userId: { in: userIds },
      provider: {
        in: ["google", "hubspot"],
      },
    },
    select: {
      userId: true,
      provider: true,
    },
  });

  const integrationMap = new Map<string, IntegrationSnapshot>();

  for (const userId of userIds) {
    integrationMap.set(userId, { google: false, hubspot: false });
  }

  for (const credential of credentials) {
    const snapshot = integrationMap.get(credential.userId);
    if (!snapshot) {
      continue;
    }
    if (credential.provider === "google") {
      snapshot.google = true;
    }
    if (credential.provider === "hubspot") {
      snapshot.hubspot = true;
    }
  }

  const outcomes: UserCycleOutcome[] = [];
  const taskBatchSize = options.taskBatchSize ?? 5;

  for (const userId of userIds) {
    const integrations = integrationMap.get(userId) ?? { google: false, hubspot: false };
    const outcome: UserCycleOutcome = {
      userId,
      integrations,
      tasks: [],
    };

    if (integrations.google) {
      try {
        outcome.gmail = await syncGmailMailbox(userId, {
          maxPages: 3,
          pageSize: 75,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gmail sync failed";
        outcome.gmail = { error: message };
      }

      try {
        outcome.calendar = await syncCalendarEvents(userId, {
          maxResults: 120,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Calendar sync failed";
        outcome.calendar = { error: message };
      }
    }

    if (integrations.hubspot) {
      try {
        outcome.hubspot = await syncHubspotContacts(userId, {
          maxPages: 5,
          limit: 100,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "HubSpot sync failed";
        outcome.hubspot = { error: message };
      }
    }

    outcome.tasks = await processPendingAgentTasks({
      userId,
      limit: taskBatchSize,
    });

    outcomes.push(outcome);
  }

  return {
    usersProcessed: outcomes.length,
    outcomes,
  };
}
