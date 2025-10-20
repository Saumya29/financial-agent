export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageStatus = "pending" | "complete" | "error";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSuggestion {
  id: string;
  label: string;
  prompt: string;
}

export interface ChatThreadPreview {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationState = "connected" | "pending" | "disconnected";

export interface ConnectionStatus {
  gmail: IntegrationState;
  calendar: IntegrationState;
  hubspot: IntegrationState;
}

export interface TaskPreview {
  id: string;
  title: string;
  summary: string;
  status: "waiting" | "in-progress" | "done";
  dueAt?: string;
}

export interface ChatContextSnapshot {
  lastSynced: string;
  totalCounts?: {
    emails: number;
    calendar: number;
    contacts: number;
  };
  emails: Array<{
    id: string;
    subject: string | null;
    preview: string;
    from: string | null;
    sentAt: string | null;
    similarity?: number;
  }>;
  calendar: Array<{
    id: string;
    summary: string | null;
    startTime: string | null;
    endTime: string | null;
    location: string | null;
    similarity?: number;
  }>;
  contacts: Array<{
    id: string;
    name: string | null;
    email: string | null;
    company: string | null;
    phone: string | null;
    lifecycleStage: string | null;
    updatedAt: string | null;
    similarity?: number;
  }>;
}

export interface AgentNotification {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  eventType: string;
}
