import {
  streamChatCompletion,
  type ChatCompletionMessage,
  type ChatToolDefinition,
} from "@/lib/openai";

export type AgentIterationResult =
  | {
      type: "tool_calls";
      content?: string;
      toolCalls: NonNullable<ChatCompletionMessage["tool_calls"]>;
    }
  | {
      type: "message";
      content?: string;
    };

type RunModelIterationParams = {
  chatMessages: ChatCompletionMessage[];
  toolDefinitions: ChatToolDefinition[];
  onToken?: (text: string) => Promise<void> | void;
};

export async function runModelIteration({
  chatMessages,
  toolDefinitions,
  onToken,
}: RunModelIterationParams): Promise<AgentIterationResult> {
  const toolCallAccumulator: Array<
    | undefined
    | {
        id?: string;
        function: {
          name: string;
          arguments: string;
        };
      }
  > = [];

  let finishReason: string | null = null;
  let content = "";
  let toolCallDetected = false;

  for await (const chunk of streamChatCompletion({
    messages: chatMessages,
    tools: toolDefinitions,
  })) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) {
      continue;
    }

    const deltaToolCalls = delta.tool_calls;
    if (deltaToolCalls && deltaToolCalls.length) {
      toolCallDetected = true;
      for (const call of deltaToolCalls) {
        const index = call.index ?? 0;
        const existing = toolCallAccumulator[index] ?? {
          function: {
            name: "",
            arguments: "",
          },
        };

        if (call.id) {
          existing.id = call.id;
        }

        if (call.function?.name) {
          existing.function.name = call.function.name;
        }

        if (call.function?.arguments) {
          existing.function.arguments = `${existing.function.arguments ?? ""}${call.function.arguments}`;
        }

        toolCallAccumulator[index] = existing;
      }
    }

    if (delta.content) {
      const text = delta.content;
      content += text;
      if (!toolCallDetected && onToken) {
        await onToken(text);
      }
    }
  }

  if (toolCallDetected || finishReason === "tool_calls") {
    const toolCalls = toolCallAccumulator
      .map((call, index) => {
        if (!call) {
          return undefined;
        }

        const name = call.function.name;
        if (!name) {
          return undefined;
        }

        const id = call.id ?? `tool_call_${index}`;
        const args = call.function.arguments || "{}";

        return {
          id,
          type: "function" as const,
          function: {
            name,
            arguments: args,
          },
        };
      })
      .filter((call): call is NonNullable<ChatCompletionMessage["tool_calls"]>[number] => Boolean(call));

    return {
      type: "tool_calls",
      content,
      toolCalls,
    };
  }

  return {
    type: "message",
    content,
  };
}

export function normaliseRole(role: "assistant" | "system" | "user" | "tool") {
  switch (role) {
    case "assistant":
      return "assistant" as const;
    case "system":
      return "system" as const;
    default:
      return "user" as const;
  }
}
