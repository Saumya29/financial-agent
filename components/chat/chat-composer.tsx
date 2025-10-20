"use client";

import { useState } from "react";
import { Mic, Plus, Paperclip, User } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ContextSectionConfig, SectionId } from "./chat-context";

interface ChatComposerProps {
  onSubmit?: (value: string) => Promise<void> | void;
  disabled?: boolean;
  onAddContext?: (sectionId: SectionId) => void;
  onOpenContextPicker?: () => void;
  selectedSections?: SectionId[];
  sectionOrder?: SectionId[];
  sectionConfigs?: Partial<Record<SectionId, ContextSectionConfig>>;
  lastSynced?: string;
}

export function ChatComposer({
  onSubmit,
  disabled,
  onAddContext,
  selectedSections = [],
  sectionOrder = [],
  sectionConfigs = {},
  lastSynced,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showContextTabs, setShowContextTabs] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;

    try {
      setIsSubmitting(true);
      await onSubmit?.(trimmed);
      setValue("");
    } finally {
      setIsSubmitting(false);
    }
  }

  const tabLabels: Record<SectionId, string> = {
    gmail: "All emails",
    calendar: "All meetings",
    hubspot: "All contacts",
  };

  const formatRelative = (input: string) => {
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
  };

  return (
    <div className="space-y-3">
      {/* Context tabs - shown when + is clicked or when sections are selected */}
      {(showContextTabs || selectedSections.length > 0) && (
        <div className="rounded-2xl border bg-card/60 p-3 shadow-sm sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {sectionOrder.map((sectionId) => {
                const config = sectionConfigs[sectionId];
                if (!config) return null;

                const isSelected = selectedSections.includes(sectionId);

                const countDisplay = config.totalCount
                  ? `${config.count} of ${config.totalCount}`
                  : config.count;

                return (
                  <button
                    key={sectionId}
                    type="button"
                    onClick={() => {
                      onAddContext?.(sectionId);
                      setShowContextTabs(false);
                    }}
                    className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    <span>{tabLabels[sectionId]}</span>
                    {config.count > 0 && (
                      <span className={`ml-1.5 text-[11px] ${isSelected ? "opacity-80" : "opacity-60"}`}>
                        {countDisplay}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Sync status indicator */}
            {lastSynced && (
              <div className="flex-shrink-0 text-xs text-muted-foreground">
                Synced {formatRelative(lastSynced)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input form */}
      <form
        onSubmit={handleSubmit}
        className="relative flex items-center gap-1 rounded-2xl border bg-card p-2 shadow-sm sm:gap-2 sm:rounded-3xl sm:p-3"
      >
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            onClick={() => setShowContextTabs((prev) => !prev)}
            className="relative flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 sm:h-9 sm:w-9"
            disabled={disabled || isSubmitting}
          >
            <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="sr-only">Add context</span>
          </button>
        </div>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Ask about emails, meetings, or contacts..."
          className={cn(
            "flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground",
            "disabled:opacity-50"
          )}
          disabled={disabled || isSubmitting}
        />
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            className="hidden h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50 sm:flex"
            disabled={disabled || isSubmitting}
          >
            <Paperclip className="h-5 w-5" />
            <span className="sr-only">Attach file</span>
          </button>
          <button
            type="button"
            className="hidden h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50 sm:flex"
            disabled={disabled || isSubmitting}
          >
            <User className="h-5 w-5" />
            <span className="sr-only">User profile</span>
          </button>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50 sm:h-9 sm:w-9"
            disabled={disabled || isSubmitting}
          >
            <Mic className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="sr-only">Voice input</span>
          </button>
        </div>
      </form>
    </div>
  );
}
