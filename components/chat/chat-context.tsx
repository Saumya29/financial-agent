"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { ChatContextSnapshot } from "./types";

export type SectionId = "gmail" | "calendar" | "hubspot";

type ContextItem = {
  id: string;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  meta?: string | null;
};

export type ContextSectionConfig = {
  id: SectionId;
  label: string;
  description: string;
  count: number;
  totalCount?: number;
  emptyLabel: string;
  items: ContextItem[];
};

export type ChatContextHandle = {
  openPicker: () => void;
};

interface ChatContextProps {
  lastSynced: string;
  sections: Record<SectionId, ContextSectionConfig>;
  selected: SectionId[];
  onSelect: (sectionId: SectionId) => void;
  onRemove: (sectionId: SectionId) => void;
}

export const SECTION_ORDER: SectionId[] = ["gmail", "calendar", "hubspot"];

export function buildContextSections(snapshot: ChatContextSnapshot): Record<SectionId, ContextSectionConfig> {
  const emailItems = snapshot.emails.map<ContextItem>((email) => ({
    id: email.id,
    title: email.subject ?? "Untitled message",
    subtitle: email.from,
    detail: email.preview,
    meta: email.sentAt ? formatAbsolute(email.sentAt) : null,
  }));

  const calendarItems = snapshot.calendar.map<ContextItem>((event) => ({
    id: event.id,
    title: event.summary ?? "Untitled event",
    subtitle: event.location,
    detail: buildCalendarDetail(event.startTime, event.endTime),
    meta: event.startTime ? formatAbsolute(event.startTime) : null,
  }));

  const contactItems = snapshot.contacts.map<ContextItem>((contact) => ({
    id: contact.id,
    title: contact.name ?? contact.email ?? "HubSpot contact",
    subtitle: contact.email ?? contact.company,
    detail: buildContactDetail(contact.company, contact.lifecycleStage, contact.phone),
    meta: contact.updatedAt ? `Updated ${formatAbsolute(contact.updatedAt)}` : null,
  }));

  return {
    gmail: {
      id: "gmail",
      label: "Emails from Gmail",
      description: "Include recent email threads in the conversation context.",
      count: snapshot.emails.length,
      totalCount: snapshot.totalCounts?.emails,
      emptyLabel: "No synced email threads yet.",
      items: emailItems,
    },
    calendar: {
      id: "calendar",
      label: "Meetings from Calendar",
      description: "Add upcoming or recent meetings for quick reference.",
      count: snapshot.calendar.length,
      totalCount: snapshot.totalCounts?.calendar,
      emptyLabel: "No calendar events available.",
      items: calendarItems,
    },
    hubspot: {
      id: "hubspot",
      label: "HubSpot contacts",
      description: "Surface recently updated CRM contacts.",
      count: snapshot.contacts.length,
      totalCount: snapshot.totalCounts?.contacts,
      emptyLabel: "No HubSpot contacts synced yet.",
      items: contactItems,
    },
  } satisfies Record<SectionId, ContextSectionConfig>;
}

export const ChatContext = forwardRef<ChatContextHandle, ChatContextProps>(function ChatContext(
  { lastSynced, sections, selected, onSelect, onRemove }: ChatContextProps,
  ref,
) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SectionId | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      openPicker() {
        setIsPickerOpen(true);
      },
    }),
    [],
  );

  const lastSyncedRelative = formatRelative(lastSynced);

  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (pickerRef.current && event.target instanceof Node && !pickerRef.current.contains(event.target)) {
        setIsPickerOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPickerOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPickerOpen]);

  useEffect(() => {
    if (!selected.length) {
      setActiveSection(null);
      return;
    }

    setActiveSection((current) => {
      if (current && selected.includes(current)) {
        return current;
      }
      return selected[0];
    });
  }, [selected]);

  function handleToggle(sectionId: SectionId) {
    if (selected.includes(sectionId)) {
      onRemove(sectionId);
      setActiveSection((current) => (current === sectionId ? null : current));
    } else {
      onSelect(sectionId);
      setActiveSection(sectionId);
    }
    setIsPickerOpen(false);
  }

  const tabLabels: Record<SectionId, string> = {
    gmail: "All mails",
    calendar: "All meetings",
    hubspot: "All contacts",
  };

  return (
    <div className="space-y-3">
      {/* Horizontal tab bar */}
      <div className="flex items-center gap-2 overflow-x-auto" ref={pickerRef}>
        {SECTION_ORDER.map((sectionId) => {
          const config = sections[sectionId];
          const isSelected = selected.includes(sectionId);
          const isActive = sectionId === activeSection;

          return (
            <button
              key={sectionId}
              type="button"
              onClick={() => handleToggle(sectionId)}
              className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                isSelected
                  ? isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-primary/60 bg-primary/10 text-primary hover:bg-primary/20"
                  : "border-muted bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }`}
            >
              <span>{tabLabels[sectionId]}</span>
              {config.count > 0 && (
                <span className={`ml-1.5 text-[11px] ${isSelected ? "opacity-80" : "opacity-60"}`}>
                  {config.count}
                </span>
              )}
            </button>
          );
        })}

        {/* Sync status indicator */}
        <div className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground">
          Synced {lastSyncedRelative}
        </div>
      </div>

      {/* Active section content */}
      {activeSection && selected.includes(activeSection) ? (
        <ContextSection
          key={activeSection}
          title={sections[activeSection].label}
          items={sections[activeSection].items}
          emptyLabel={sections[activeSection].emptyLabel}
          totalCount={sections[activeSection].items.length}
          onRemove={() => handleToggle(activeSection)}
        />
      ) : null}
    </div>
  );
});

interface ContextSectionProps {
  title: string;
  items: ContextItem[];
  emptyLabel: string;
  totalCount: number;
  onRemove: () => void;
}

function ContextSection({ title, items, emptyLabel, totalCount, onRemove }: ContextSectionProps) {
  const VISIBLE_LIMIT = 20;
  const displayed = items.slice(0, VISIBLE_LIMIT);
  const hasMore = totalCount > VISIBLE_LIMIT;

  return (
    <div className="rounded-xl border bg-background/80 p-3 sm:p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Remove ${title} from context`}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {displayed.map((item) => (
            <li key={item.id} className="space-y-1 rounded-lg border border-muted/60 bg-background/60 p-3">
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              {item.subtitle ? (
                <p className="text-xs text-muted-foreground">{item.subtitle}</p>
              ) : null}
              {item.detail ? (
                <p className="text-xs text-muted-foreground line-clamp-2">{item.detail}</p>
              ) : null}
              {item.meta ? (
                <p className="text-[11px] text-muted-foreground/80">{item.meta}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <p className="mt-3 text-[11px] text-muted-foreground/80">
          Showing first {VISIBLE_LIMIT} of {totalCount} items.
        </p>
      ) : null}
    </div>
  );
}

function formatRelative(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }

  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatAbsolute(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString();
}

function buildCalendarDetail(start: string | null, end: string | null) {
  if (!start && !end) {
    return null;
  }

  const startLabel = start ? new Date(start).toLocaleString() : "";
  const endLabel = end ? new Date(end).toLocaleString() : "";

  if (startLabel && endLabel) {
    return `${startLabel} → ${endLabel}`;
  }

  return startLabel || endLabel;
}

function buildContactDetail(company: string | null, lifecycleStage: string | null, phone: string | null) {
  const details: string[] = [];
  if (company) {
    details.push(company);
  }
  if (lifecycleStage) {
    details.push(`Lifecycle: ${lifecycleStage}`);
  }
  if (phone) {
    details.push(`Phone: ${phone}`);
  }

  return details.length ? details.join(" • ") : null;
}
