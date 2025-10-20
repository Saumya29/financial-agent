"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./types";

interface ChatMessageProps {
  message: ChatMessage;
}

const roleLabel: Record<ChatMessage["role"], string> = {
  user: "You",
  assistant: "Advisor AI",
  system: "System",
  tool: "Tool",
};

export function ChatMessageBubble({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isPending = message.status === "pending";
  const isError = message.status === "error";

  if (isUser) {
    // User message - compact design on the right
    return (
      <div className="flex w-full justify-end gap-3">
        <div className="flex max-w-[80%] flex-col items-end gap-1.5">
          <div className="rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
          </div>
          <span className="px-1 text-xs text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })}
          </span>
        </div>
      </div>
    );
  }

  // Assistant message - full-width with avatar
  return (
    <div className="flex w-full gap-3">
      <div className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/10 text-primary ring-1 ring-primary/20">
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">
            {roleLabel[message.role]}
          </span>
          <span className="text-xs text-muted-foreground">
            {isPending
              ? "Thinking..."
              : new Date(message.createdAt).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                })}
          </span>
        </div>
        <div
          className={cn(
            "rounded-2xl border bg-card px-4 py-3.5 shadow-sm",
            isPending && "border-dashed opacity-70",
            isError && "border-destructive/60 bg-destructive/5",
          )}
        >
          <div
            className={cn(
              "prose prose-base max-w-none text-sm leading-relaxed",
              isError ? "prose-red" : "prose-slate",
              // Reset default prose margins
              "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              // Paragraphs - base size (14px)
              "prose-p:my-3 prose-p:text-sm prose-p:leading-relaxed first:prose-p:mt-0 last:prose-p:mb-0",
              // Headings
              "prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground",
              "prose-h1:mb-3 prose-h1:mt-5 prose-h1:text-base first:prose-h1:mt-0",
              "prose-h2:mb-2.5 prose-h2:mt-4 prose-h2:text-[15px] first:prose-h2:mt-0",
              "prose-h3:mb-2 prose-h3:mt-3 prose-h3:text-sm first:prose-h3:mt-0",
              // Lists - base size (14px)
              "prose-ul:my-3 prose-ol:my-3",
              "prose-li:my-1 prose-li:text-sm prose-li:leading-relaxed",
              "prose-li:marker:text-muted-foreground",
              // Strong/Bold - inherit color and size
              "prose-strong:font-semibold prose-strong:text-foreground",
              // Code
              "prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-medium",
              "prose-code:text-foreground prose-code:before:content-[''] prose-code:after:content-['']",
              "prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted/50 prose-pre:p-3 prose-pre:text-[13px]",
              // Links
              "prose-a:font-medium prose-a:text-primary prose-a:no-underline prose-a:transition-colors hover:prose-a:underline",
              // Blockquotes
              "prose-blockquote:my-3 prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-muted-foreground",
              // HR
              "prose-hr:my-4 prose-hr:border-border",
              // Tables
              "prose-table:my-3 prose-table:w-full prose-table:text-sm",
              "prose-thead:border-b",
              "prose-th:px-2.5 prose-th:py-2 prose-th:text-left prose-th:text-sm prose-th:font-medium",
              "prose-td:px-2.5 prose-td:py-2 prose-td:text-sm",
              "prose-tr:border-b prose-tr:border-border",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
