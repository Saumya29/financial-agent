import type { ChatSuggestion } from "./types";

interface ChatSuggestionsProps {
  suggestions: ChatSuggestion[];
  onSelect?: (suggestion: ChatSuggestion) => void;
}

export function ChatSuggestions({ suggestions, onSelect }: ChatSuggestionsProps) {
  if (!suggestions.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          onClick={() => onSelect?.(suggestion)}
          type="button"
          className="w-full rounded-xl border border-border bg-background px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-muted/50"
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  );
}
