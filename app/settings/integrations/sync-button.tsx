"use client";

import { useTransition, type ReactNode, type ComponentProps } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { runProviderSync } from "./actions";

type Provider = "gmail" | "calendar" | "hubspot";

interface SyncButtonProps {
  provider: Provider;
  children: ReactNode;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  pendingLabel?: string;
}

export function SyncButton({
  provider,
  children,
  disabled,
  variant = "default",
  size,
  pendingLabel = "Syncing...",
}: SyncButtonProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled || isPending}
      onClick={() => {
        startTransition(() => {
          void runProviderSync(provider);
        });
      }}
      className="flex items-center gap-2"
    >
      {isPending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}
