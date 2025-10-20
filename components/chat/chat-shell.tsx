"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { ChatComposer } from "./chat-composer";
import {
  buildContextSections,
  SECTION_ORDER,
  type SectionId,
} from "./chat-context";
import { ChatMessageBubble } from "./chat-message";
import type {
  AgentNotification,
  ChatContextSnapshot,
  ChatMessage,
  ChatSuggestion,
  ChatThreadPreview,
  ConnectionStatus,
  MessageStatus,
  TaskPreview,
} from "./types";

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2);
}

const fallbackMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I’m connected to your Gmail, Calendar, and HubSpot data. Ask me to draft a follow-up, prepare for a meeting, or automate a workflow.",
    createdAt: new Date().toISOString(),
    status: "complete",
  },
];

const fallbackSuggestions: ChatSuggestion[] = [];

interface ChatShellProps {
  connectionStatus: ConnectionStatus;
  tasks: TaskPreview[];
  contextSnapshot: ChatContextSnapshot;
  notifications: AgentNotification[];
  threads: ChatThreadPreview[];
  defaultMessages?: ChatMessage[];
  defaultSuggestions?: ChatSuggestion[];
  threadId?: string;
}

export function ChatShell({
  connectionStatus,
  tasks,
  contextSnapshot,
  notifications,
  threads,
  defaultMessages = fallbackMessages,
  defaultSuggestions = fallbackSuggestions,
  threadId,
}: ChatShellProps) {
  const browserTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }, []);

  const derivedSuggestions = useMemo(() => {
    if (defaultSuggestions.length) {
      return defaultSuggestions;
    }

    const dynamic: ChatSuggestion[] = [];

    const firstEmail = contextSnapshot.emails[0];
    if (firstEmail) {
      dynamic.push({
        id: `follow-up-${firstEmail.id}`,
        label: `Follow up with ${firstEmail.from ?? "this client"}`,
        prompt: `Draft a polished follow-up responding to ${
          firstEmail.subject ?? "this email"
        }. Include key points from the thread and suggest next steps.`,
      });
    }

    const nextEvent = contextSnapshot.calendar[0];
    if (nextEvent) {
      dynamic.push({
        id: `prep-${nextEvent.id}`,
        label: `Prep for ${nextEvent.summary ?? "upcoming meeting"}`,
        prompt: `Prepare a briefing for ${
          nextEvent.summary ?? "the upcoming meeting"
        }, including recent communications and action items.`,
      });
    }

    const topContact = contextSnapshot.contacts[0];
    if (topContact) {
      dynamic.push({
        id: `contact-${topContact.id}`,
        label: topContact.name
          ? `Review ${topContact.name}`
          : "Review top CRM contact",
        prompt: `Summarize recent activity for ${
          topContact.name ?? topContact.email ?? "this HubSpot contact"
        } and recommend the next best action.`,
      });
    }

    return dynamic;
  }, [contextSnapshot, defaultSuggestions]);

  const [messages, setMessages] = useState<ChatMessage[]>(defaultMessages);
  const [suggestions, setSuggestions] =
    useState<ChatSuggestion[]>(derivedSuggestions);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentThreadId, setCurrentThreadId] = useState<string | undefined>(
    threadId
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    threadId
  );
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [threadList, setThreadList] = useState<ChatThreadPreview[]>(threads);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [selectedSections, setSelectedSections] = useState<SectionId[]>([]);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);

  const contextSections = useMemo(
    () => buildContextSections(contextSnapshot),
    [contextSnapshot]
  );

  const activeThread = useMemo(
    () =>
      threadList.find((thread) =>
        selectedThreadId
          ? thread.id === selectedThreadId
          : currentThreadId
          ? thread.id === currentThreadId
          : false
      ),
    [threadList, selectedThreadId, currentThreadId]
  );

  const refreshThreads = useCallback(async (): Promise<
    ChatThreadPreview[] | undefined
  > => {
    try {
      const response = await fetch("/api/chat/threads");

      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as unknown;

      if (!payload || typeof payload !== "object" || payload === null) {
        return undefined;
      }

      if (
        !("threads" in payload) ||
        !Array.isArray((payload as { threads: unknown }).threads)
      ) {
        return undefined;
      }

      const rawThreads = (payload as { threads: unknown[] }).threads;

      const normalised = rawThreads
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }

          const item = entry as {
            id?: unknown;
            title?: unknown;
            summary?: unknown;
            createdAt?: unknown;
            updatedAt?: unknown;
          };

          const id = typeof item.id === "string" ? item.id : null;
          if (!id) {
            return null;
          }

          return {
            id,
            title:
              typeof item.title === "string" && item.title.trim().length > 0
                ? item.title
                : "Untitled chat",
            summary: typeof item.summary === "string" ? item.summary : "",
            createdAt:
              typeof item.createdAt === "string"
                ? item.createdAt
                : new Date().toISOString(),
            updatedAt:
              typeof item.updatedAt === "string"
                ? item.updatedAt
                : new Date().toISOString(),
          } satisfies ChatThreadPreview;
        })
        .filter((entry): entry is ChatThreadPreview => Boolean(entry));

      setThreadList(normalised);
      return normalised;
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    setSuggestions(derivedSuggestions);
  }, [derivedSuggestions]);

  useEffect(() => {
    setThreadList(threads);
  }, [threads]);

  useEffect(() => {
    if (currentThreadId) {
      setSelectedThreadId(currentThreadId);
    }
  }, [currentThreadId]);

  useEffect(() => {
    if (!isTaskModalOpen && !isActivityModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsTaskModalOpen(false);
        setIsActivityModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTaskModalOpen, isActivityModalOpen]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  async function handleSubmit(content: string) {
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      status: "complete",
    };

    const baseMessages = [...messages, userMessage];
    const pendingAssistant: ChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    setMessages([...baseMessages, pendingAssistant]);
    setIsSubmitting(true);

    const assistantMessageId = pendingAssistant.id;
    let streamingContent = "";
    let streamErrored = false;

    try {
      const payload: Record<string, unknown> = {
        threadId: currentThreadId,
        messages: baseMessages.map(({ id, role, content: messageContent }) => ({
          id,
          role,
          content: messageContent,
        })),
      };

      if (browserTimeZone) {
        payload.client = { timeZone: browserTimeZone };
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const contentType = response.headers.get("content-type") ?? "";

      if (!response.ok || !response.body) {
        if (contentType.includes("application/json")) {
          const payload = await response.json().catch(() => null);
          const errorMessage =
            (payload &&
            typeof payload === "object" &&
            payload &&
            "error" in payload &&
            typeof payload.error === "string"
              ? payload.error
              : null) ?? `Request failed with status ${response.status}`;
          throw new Error(errorMessage);
        }

        throw new Error(`Request failed with status ${response.status}`);
      }

      if (!contentType.includes("text/event-stream")) {
        const payload = await response.json().catch(() => null);
        const errorMessage =
          (payload &&
          typeof payload === "object" &&
          payload &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : null) ?? "Unexpected response format";
        throw new Error(errorMessage);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      const applyToken = (token: string) => {
        streamingContent += token;
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: streamingContent,
                }
              : message
          )
        );
      };

      const markComplete = (data: {
        messageId?: string;
        content?: string;
        createdAt?: string;
        status?: string;
      }) => {
        if (data.content && !streamingContent) {
          streamingContent = data.content;
        }

        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  id: data.messageId ?? message.id,
                  content: data.content ?? streamingContent,
                  status: (data.status as ChatMessage["status"]) ?? "complete",
                  createdAt: data.createdAt ?? message.createdAt,
                }
              : message
          )
        );
      };

      const markError = (message: string) => {
        streamErrored = true;
        setMessages((current) =>
          current.map((entry) =>
            entry.id === assistantMessageId
              ? {
                  ...entry,
                  content: message,
                  status: "error",
                }
              : entry
          )
        );
      };

      const processEvent = (eventName: string, data: unknown) => {
        if (!data || typeof data !== "object") {
          return;
        }

        if (
          eventName === "thread" &&
          "threadId" in data &&
          typeof data.threadId === "string"
        ) {
          setCurrentThreadId(data.threadId);
          setSelectedThreadId(data.threadId);
          setThreadLoadError(null);
          void refreshThreads();
          return;
        }

        if (eventName === "done") {
          done = true;
          return;
        }

        if (
          eventName === "token" &&
          "text" in data &&
          typeof data.text === "string"
        ) {
          applyToken(data.text);
          return;
        }

        if (eventName === "complete") {
          markComplete({
            messageId:
              "messageId" in data && typeof data.messageId === "string"
                ? data.messageId
                : undefined,
            content:
              "content" in data && typeof data.content === "string"
                ? data.content
                : undefined,
            createdAt:
              "createdAt" in data && typeof data.createdAt === "string"
                ? data.createdAt
                : undefined,
            status:
              "status" in data && typeof data.status === "string"
                ? data.status
                : undefined,
          });
          setThreadLoadError(null);
          void refreshThreads();
          return;
        }

        if (
          eventName === "error" &&
          "message" in data &&
          typeof data.message === "string"
        ) {
          markError(data.message);
          setThreadLoadError(data.message);
          return;
        }

        if (
          eventName === "tool" &&
          "name" in data &&
          typeof data.name === "string"
        ) {
          // tool events can be used for UX updates later
          return;
        }
      };

      try {
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            if (rawEvent.trim()) {
              const lines = rawEvent.split("\n");
              let eventName = "message";
              let dataLine = "";

              for (const line of lines) {
                if (line.startsWith("event:")) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                  dataLine += line.slice(5).trim();
                }
              }

              if (eventName === "done") {
                done = true;
                break;
              }

              if (dataLine) {
                try {
                  const parsed = JSON.parse(dataLine) as unknown;
                  processEvent(eventName, parsed);
                } catch {
                  // ignore malformed payloads
                }
              }
            }

            boundary = buffer.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      const fallback =
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.";
      streamErrored = true;
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: fallback,
                status: "error",
              }
            : message
        )
      );
    } finally {
      setIsSubmitting(false);

      if (!streamErrored && !streamingContent) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: "No response received.",
                  status: "error",
                }
              : message
          )
        );
      }
    }
  }

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [messages]
  );

  const handleToggleSection = (sectionId: SectionId) => {
    setSelectedSections((previous) => {
      if (previous.includes(sectionId)) {
        // Remove if already selected
        return previous.filter((id) => id !== sectionId);
      }

      // Add in the correct order
      return SECTION_ORDER.filter(
        (id) => id === sectionId || previous.includes(id)
      );
    });
  };

  function handleStartNewChat() {
    // Clear all state for a fresh start
    setSelectedThreadId(undefined);
    setCurrentThreadId(undefined);
    setIsLoadingThread(false);
    setThreadLoadError(null);
    setMessages([]);
    setSelectedSections([]);
    // Reset suggestions to initial state
    setSuggestions(derivedSuggestions);
  }

  async function handleSelectThread(threadId: string) {
    if (!threadId) {
      handleStartNewChat();
      return;
    }

    if (isLoadingThread) {
      return;
    }

    setThreadLoadError(null);
    setIsLoadingThread(true);
    setSelectedThreadId(threadId);

    const previousThreadId = currentThreadId;
    const previousMessages = messages;
    const previousSections = [...selectedSections];
    const previousSuggestions = [...suggestions];

    setMessages([]);
    setSelectedSections([]);
    setSuggestions([]);

    try {
      const response = await fetch(`/api/chat/threads/${threadId}`);

      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Chat not found. It may have been archived."
            : "Unable to load chat history. Please try again."
        );
      }

      const payload = (await response.json()) as unknown;

      if (
        !payload ||
        typeof payload !== "object" ||
        payload === null ||
        !("thread" in payload)
      ) {
        throw new Error("Unexpected response while loading chat history.");
      }

      const threadPayload = (payload as { thread?: unknown }).thread;
      if (!threadPayload || typeof threadPayload !== "object") {
        throw new Error("Unexpected response while loading chat history.");
      }

      const threadData = threadPayload as {
        id?: unknown;
        messages?: unknown;
      };

      const resolvedThreadId =
        typeof threadData.id === "string" ? threadData.id : threadId;

      const loadedMessages = Array.isArray(threadData.messages)
        ? threadData.messages
            .map((entry) => {
              if (!entry || typeof entry !== "object") {
                return null;
              }

              const item = entry as {
                id?: unknown;
                role?: unknown;
                content?: unknown;
                createdAt?: unknown;
                status?: unknown;
                metadata?: unknown;
              };

              const id = typeof item.id === "string" ? item.id : createId();
              const role =
                item.role === "assistant" ||
                item.role === "user" ||
                item.role === "system" ||
                item.role === "tool"
                  ? (item.role as ChatMessage["role"])
                  : "assistant";
              const content =
                typeof item.content === "string" ? item.content : "";
              const createdAt =
                typeof item.createdAt === "string"
                  ? item.createdAt
                  : new Date().toISOString();
              const status: MessageStatus | undefined =
                item.status === "pending" ||
                item.status === "complete" ||
                item.status === "error"
                  ? (item.status as MessageStatus)
                  : "complete";

              const metadata =
                item.metadata && typeof item.metadata === "object"
                  ? (item.metadata as Record<string, unknown>)
                  : undefined;

              const message: ChatMessage = {
                id,
                role,
                content,
                createdAt,
                status,
                metadata,
              };
              return message;
            })
            .filter(
              (message): message is NonNullable<typeof message> =>
                message !== null
            )
        : [];

      setMessages(loadedMessages);
      setCurrentThreadId(resolvedThreadId);
      setSelectedThreadId(resolvedThreadId);
      setThreadLoadError(null);
    } catch (error) {
      setSelectedThreadId(previousThreadId);
      setCurrentThreadId(previousThreadId);
      setMessages(previousMessages);
      setSelectedSections(previousSections);
      setSuggestions(previousSuggestions);
      const fallbackMessage =
        error instanceof Error
          ? error.message
          : "Unable to load chat history. Please try again.";
      setThreadLoadError(fallbackMessage);
    } finally {
      setIsLoadingThread(false);
      void refreshThreads();
    }
  }

  return (
    <div className="flex h-full w-full">
      <aside className="hidden w-64 flex-shrink-0 border-r bg-background lg:block">
        <div className="flex h-full w-64 flex-col overflow-hidden p-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Chat history
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartNewChat}
              disabled={isSubmitting || isLoadingThread}
            >
              New chat
            </Button>
          </div>
          <div className="mt-4 flex-1 space-y-2 overflow-y-auto pr-2">
            {threadList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No past chats yet.
              </p>
            ) : (
              threadList.map((thread) => {
                const isActive = thread.id === selectedThreadId;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => handleSelectThread(thread.id)}
                    disabled={isSubmitting || isLoadingThread}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left transition-colors",
                      isActive ? "bg-muted" : "hover:bg-muted/50"
                    )}
                  >
                    <p className="text-sm font-medium text-foreground">
                      {thread.title}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {thread.summary || "No summary yet."}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground/80">
                      Updated {formatTimeSince(thread.updatedAt)} ago
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>
      <div
        className="flex h-full flex-1 flex-col overflow-hidden"
        style={{ width: "calc(100vw - 36rem)" }}
      >
        <div className="mb-3 flex flex-col gap-2 px-4 pt-4 lg:hidden">
          <div className="flex items-center gap-2">
            <select
              className="flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              value={selectedThreadId ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                if (!value) {
                  handleStartNewChat();
                  return;
                }
                handleSelectThread(value);
              }}
              disabled={isSubmitting || isLoadingThread}
            >
              <option value="">Start new chat</option>
              {threadList.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartNewChat}
              disabled={isSubmitting || isLoadingThread}
            >
              New chat
            </Button>
          </div>
          {activeThread ? (
            <p className="text-xs text-muted-foreground">
              Updated {formatTimeSince(activeThread.updatedAt)} ago
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Draft a prompt to begin a new chat.
            </p>
          )}
        </div>
        <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto bg-muted/5 px-6 py-4 sm:space-y-4">
          {sortedMessages.map((message) => (
            <ChatMessageBubble key={message.id} message={message} />
          ))}
          {isLoadingThread && (
            <div className="rounded-xl border border-dashed border-muted bg-muted/30 p-3 text-center text-xs text-muted-foreground">
              Loading chat…
            </div>
          )}
          {threadLoadError && (
            <div className="rounded-xl border text-center text-xs font-medium p-3 border-rose-200 bg-rose-50 text-rose-700">
              {threadLoadError}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="flex-shrink-0 border-t bg-background p-4 space-y-3 sm:space-y-4">
          <ChatComposer
            onSubmit={handleSubmit}
            disabled={isSubmitting || isLoadingThread}
            onAddContext={handleToggleSection}
            selectedSections={selectedSections}
            sectionOrder={SECTION_ORDER}
            sectionConfigs={contextSections}
            lastSynced={contextSnapshot.lastSynced}
          />
        </div>
      </div>
      <aside className="hidden w-80 flex-shrink-0 border-l bg-background lg:block">
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
          <div className="rounded-3xl border bg-card p-6 shadow-sm">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Connection status
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-center justify-between">
                <span>Gmail</span>
                <StatusPill state={connectionStatus.gmail} />
              </li>
              <li className="flex items-center justify-between">
                <span>Google Calendar</span>
                <StatusPill state={connectionStatus.calendar} />
              </li>
              <li className="flex items-center justify-between">
                <span>HubSpot</span>
                <StatusPill state={connectionStatus.hubspot} />
              </li>
            </ul>
            <a
              href="/settings/integrations"
              className="mt-6 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Manage connections
            </a>
          </div>
          <div className="rounded-3xl border bg-card p-6 shadow-sm">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Active tasks
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              {tasks.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No active tasks right now.
                </li>
              ) : (
                tasks.map((task) => (
                  <li
                    key={task.id}
                    className="space-y-1 rounded-2xl border bg-background/60 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-foreground">
                        {task.title}
                      </p>
                      <TaskStatusBadge status={task.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {task.summary}
                    </p>
                    {task.dueAt ? (
                      <p className="text-[11px] text-muted-foreground/80">
                        Due in {formatTimeUntil(task.dueAt)}
                      </p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
            <button
              type="button"
              onClick={() => setIsTaskModalOpen(true)}
              className="mt-4 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              View task queue
            </button>
          </div>
          <div className="rounded-3xl border bg-card p-6 shadow-sm">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Agent activity
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              {notifications.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No recent triggers.
                </li>
              ) : (
                notifications.map((notification) => (
                  <li
                    key={notification.id}
                    className="space-y-1 rounded-2xl border bg-background/60 p-3"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {notification.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {notification.description}
                    </p>
                    <p className="text-[11px] text-muted-foreground/80">
                      {notification.eventType} •{" "}
                      {formatTimeSince(notification.createdAt)} ago
                    </p>
                  </li>
                ))
              )}
            </ul>
            <button
              type="button"
              onClick={() => setIsActivityModalOpen(true)}
              className="mt-4 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              View activity log
            </button>
          </div>
        </div>
      </aside>
      <Modal
        title="Task queue"
        open={isTaskModalOpen}
        onClose={() => setIsTaskModalOpen(false)}
      >
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active tasks right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="space-y-2 rounded-2xl border bg-background/60 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-foreground">{task.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {task.summary}
                    </p>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </div>
                {task.dueAt ? (
                  <p className="text-[11px] text-muted-foreground/80">
                    Due in {formatTimeUntil(task.dueAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <Modal
        title="Agent activity"
        open={isActivityModalOpen}
        onClose={() => setIsActivityModalOpen(false)}
      >
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent triggers.</p>
        ) : (
          <ul className="space-y-3">
            {notifications.map((notification) => (
              <li
                key={notification.id}
                className="space-y-1 rounded-2xl border bg-background/60 p-3"
              >
                <p className="font-medium text-foreground">
                  {notification.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {notification.description}
                </p>
                <p className="text-[11px] text-muted-foreground/80">
                  {notification.eventType} •{" "}
                  {formatTimeSince(notification.createdAt)} ago
                </p>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const modalTitleId = `${title
    .replace(/\s+/g, "-")
    .toLowerCase()}-modal-title`;
  const handleOverlayClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={modalTitleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={handleOverlayClick}
    >
      <div className="relative w-full max-w-lg rounded-3xl border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3
            id={modalTitleId}
            className="text-lg font-semibold text-foreground"
          >
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-transparent p-1 text-muted-foreground transition hover:border-muted-foreground/40 hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  state,
}: {
  state: ConnectionStatus[keyof ConnectionStatus];
}) {
  const styles: Record<ConnectionStatus[keyof ConnectionStatus], string> = {
    connected: "bg-emerald-100 text-emerald-700",
    pending: "bg-amber-100 text-amber-700",
    disconnected: "bg-rose-100 text-rose-700",
  };

  const labels: Record<ConnectionStatus[keyof ConnectionStatus], string> = {
    connected: "Active",
    pending: "Pending",
    disconnected: "Action required",
  };

  return (
    <span
      className={`rounded-full px-2 py-1 text-xs font-medium ${styles[state]}`}
    >
      {labels[state]}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: TaskPreview["status"] }) {
  const styles: Record<TaskPreview["status"], string> = {
    waiting: "bg-amber-100 text-amber-700",
    "in-progress": "bg-sky-100 text-sky-700",
    done: "bg-emerald-100 text-emerald-700",
  };

  const labels: Record<TaskPreview["status"], string> = {
    waiting: "Waiting",
    "in-progress": "In progress",
    done: "Completed",
  };

  return (
    <span
      className={`rounded-full px-2 py-1 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function formatTimeUntil(input: string) {
  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return "soon";
  }

  const diff = date.getTime() - Date.now();

  if (diff <= 0) {
    return "now";
  }

  const minutes = Math.round(diff / 60000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatTimeSince(input: string) {
  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return "moments";
  }

  const diff = Date.now() - date.getTime();

  if (diff < 0) {
    return "moments";
  }

  const minutes = Math.max(1, Math.round(diff / 60000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.round(hours / 24);
  return `${days}d`;
}
