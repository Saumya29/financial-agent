interface ChatFooterProps {
  message: string;
}

export function ChatFooter({ message }: ChatFooterProps) {
  return (
    <div className="py-3 text-center">
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}
