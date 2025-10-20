import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { ChatShell } from "@/components/chat/chat-shell";
import { LogoutButton } from "@/components/logout-button";
import type {
  AgentNotification,
  ChatContextSnapshot,
  ChatMessage,
  ChatSuggestion,
  ChatThreadPreview,
  ConnectionStatus,
  TaskPreview,
} from "@/components/chat/types";
import { buildRetrievalContextForPrompt } from "@/lib/retrieval";
import { prisma } from "@/lib/prisma";
import { AgentTaskStatus } from "@prisma/client";

export default async function HomePage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const [
    googleAccount,
    hubspotPortal,
    recentThread,
    threadRecords,
    taskRecords,
    evaluationRecords,
    instructionRecords,
    retrievalContext,
    syncStates,
    totalEmailCount,
    totalCalendarCount,
    totalContactCount,
  ] = await Promise.all([
    prisma.account.findFirst({
      where: { userId: session.user.id, provider: "google" },
    }),
    prisma.hubspotPortal.findFirst({
      where: { userId: session.user.id },
    }),
    prisma.chatThread.findFirst({
      where: { userId: session.user.id },
      orderBy: { updatedAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          take: 50,
        },
      },
    }),
    prisma.chatThread.findMany({
      where: { userId: session.user.id },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    prisma.agentTask.findMany({
      where: {
        userId: session.user.id,
        status: {
          in: [AgentTaskStatus.pending, AgentTaskStatus.running, AgentTaskStatus.waiting],
        },
      },
      orderBy: [
        { scheduledFor: "asc" },
        { createdAt: "asc" },
      ],
      include: {
        steps: {
          orderBy: { index: "asc" },
          take: 1,
        },
      },
      take: 5,
    }),
    prisma.instructionEvaluation.findMany({
      where: { userId: session.user.id },
      include: { instruction: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.instruction.findMany({
      where: { userId: session.user.id },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
    buildRetrievalContextForPrompt(session.user.id, "", {
      emailLimit: 100,
      calendarLimit: 200,
      contactLimit: 200,
    }),
    prisma.syncState.findMany({
      where: { userId: session.user.id },
      orderBy: { lastSyncAt: "desc" },
    }),
    prisma.emailMessage.count({
      where: { userId: session.user.id },
    }),
    prisma.calendarEvent.count({
      where: { userId: session.user.id },
    }),
    prisma.hubspotContact.count({
      where: { userId: session.user.id },
    }),
  ]);

  const connectionStatus: ConnectionStatus = {
    gmail: googleAccount ? "connected" : "disconnected",
    calendar: googleAccount ? "connected" : "disconnected",
    hubspot: hubspotPortal ? "connected" : "pending",
  };

  const taskPreviews: TaskPreview[] = taskRecords.map((task) => {
    const firstStep = task.steps[0];
    const metadata = typeof task.metadata === "object" && task.metadata !== null ? task.metadata : null;
    const description = typeof metadata === "object" && metadata && "description" in metadata
      ? String((metadata as Record<string, unknown>).description ?? "")
      : "Awaiting next action.";

    return {
      id: task.id,
      title: task.summary ?? `Task ${task.id.slice(0, 6)}`,
      summary: firstStep?.title ?? description,
      status: mapAgentTaskStatus(task.status),
      dueAt: task.scheduledFor?.toISOString(),
    };
  });

  const evaluationNotifications: AgentNotification[] = evaluationRecords.map((evaluation) => ({
    id: evaluation.id,
    title: evaluation.instruction.title,
    description: buildNotificationDescription(evaluation.instruction.content, evaluation.eventType),
    eventType: evaluation.eventType,
    createdAt: evaluation.createdAt.toISOString(),
  }));

  const instructionActivities: AgentNotification[] = instructionRecords.map((instruction) => ({
    id: `instruction-${instruction.id}`,
    title: instruction.title,
    description: buildInstructionActivityDescription(instruction.content, instruction.triggers),
    eventType: `instruction.${instruction.status}`,
    createdAt: instruction.updatedAt.toISOString(),
  }));

  const activityEntries: AgentNotification[] = [...instructionActivities, ...evaluationNotifications].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const notifications: AgentNotification[] = activityEntries.slice(0, 10);

  // Get the most recent sync time across all providers
  const mostRecentSync = syncStates
    .filter((state) => state.lastSyncAt)
    .reduce<Date | null>((latest, state) => {
      if (!state.lastSyncAt) return latest;
      if (!latest) return state.lastSyncAt;
      return state.lastSyncAt > latest ? state.lastSyncAt : latest;
    }, null);

  const contextSnapshot: ChatContextSnapshot = {
    lastSynced: mostRecentSync?.toISOString() ?? new Date().toISOString(),
    totalCounts: {
      emails: totalEmailCount,
      calendar: totalCalendarCount,
      contacts: totalContactCount,
    },
    emails: retrievalContext.emailSnippets.map((snippet) => ({
      id: snippet.messageId,
      subject: snippet.subject,
      preview: snippet.snippet,
      from: snippet.from,
      sentAt: snippet.sentAt,
      similarity: snippet.similarity,
    })),
    calendar: retrievalContext.calendarSnippets.map((event) => ({
      id: event.eventId,
      summary: event.summary,
      startTime: event.startTime,
      endTime: event.endTime,
      location: event.location,
      similarity: event.similarity,
    })),
    contacts: retrievalContext.hubspotContacts.map((contact) => ({
      id: contact.contactId,
      name: contact.fullName,
      email: contact.email,
      company: contact.company,
      phone: contact.phone,
      lifecycleStage: contact.lifecycleStage,
      updatedAt: contact.lastModifiedAt,
      similarity: contact.similarity,
    })),
  };

  const dynamicSuggestions: ChatSuggestion[] = [];

  if (taskPreviews[0]) {
    dynamicSuggestions.push({
      id: `task-${taskPreviews[0].id}`,
      label: `Advance ${taskPreviews[0].title}`,
      prompt: `Outline the next two steps to progress ${taskPreviews[0].title}. Include any required outreach or materials.`,
    });
  }

  const threadMessages: ChatMessage[] = recentThread
    ? recentThread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        status: message.status,
      }))
    : [];

  const threadPreviews: ChatThreadPreview[] = threadRecords.map((thread) => ({
    id: thread.id,
    title: thread.title ?? "Untitled chat",
    summary: thread.summary ?? "",
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  }));

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-gradient-to-br from-background via-background to-muted/40">
      <header className="flex-shrink-0 border-b bg-background">
        <div className="flex w-full items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
              Financial Advisor Agent
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <p className="text-sm text-muted-foreground">
              {session.user.email}
            </p>
            <LogoutButton />
          </div>
        </div>
      </header>
      <div className="flex h-full flex-1 overflow-hidden">
        <ChatShell
          connectionStatus={connectionStatus}
          tasks={taskPreviews}
          contextSnapshot={contextSnapshot}
          notifications={notifications}
          defaultMessages={threadMessages.length ? threadMessages : undefined}
          defaultSuggestions={dynamicSuggestions.length ? dynamicSuggestions : undefined}
          threadId={recentThread?.id}
          threads={threadPreviews}
        />
      </div>
    </main>
  );
}

function mapAgentTaskStatus(status: AgentTaskStatus): TaskPreview["status"] {
  switch (status) {
    case AgentTaskStatus.running:
      return "in-progress";
    case AgentTaskStatus.completed:
    case AgentTaskStatus.failed:
    case AgentTaskStatus.cancelled:
      return "done";
    default:
      return "waiting";
  }
}

function buildNotificationDescription(instructionContent: string, eventType: string) {
  const cleanContent = instructionContent.trim();
  const snippet = cleanContent.length > 80 ? `${cleanContent.slice(0, 77)}…` : cleanContent;
  const formattedEvent = eventType.replace(/\./g, " → ");
  return `${formattedEvent}: ${snippet}`;
}

function buildInstructionActivityDescription(instructionContent: string, triggers: unknown) {
  const triggerList = Array.isArray(triggers)
    ? triggers.filter((trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0)
    : [];
  const triggerText = triggerList.length ? `Triggers: ${triggerList.join(", ")}` : "Triggers: none configured";
  const cleanContent = instructionContent.trim();
  const snippet = cleanContent.length > 80 ? `${cleanContent.slice(0, 77)}…` : cleanContent;
  const detail = snippet || "Instruction saved.";
  return `${triggerText} • ${detail}`;
}
