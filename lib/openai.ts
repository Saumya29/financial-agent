const OPENAI_API_URL =
  process.env.OPENAI_CHAT_COMPLETIONS_URL ?? "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

export type ChatCompletionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatCompletionToolCall[];
};

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionChoice = {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ChatCompletionToolCall[];
  };
  finish_reason?: string | null;
};

export type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
};

export type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

type ChatCompletionParams = {
  messages: ChatCompletionMessage[];
  tools?: ChatToolDefinition[];
  temperature?: number;
};

export async function callChatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured. Set it in your environment to enable chat responses.");
  }

  const serialisedMessages = params.messages.map((message) => {
    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    if (message.tool_call_id) {
      payload.tool_call_id = message.tool_call_id;
    }

    if (message.tool_calls && message.tool_calls.length) {
      payload.tool_calls = message.tool_calls;
    }

    return payload;
  });

  const body: Record<string, unknown> = {
    model: DEFAULT_MODEL,
    messages: serialisedMessages,
    temperature: params.temperature ?? 0.2,
  };

  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText || response.statusText}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  return payload;
}

export async function* streamChatCompletion(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured. Set it in your environment to enable chat responses.");
  }

  const serialisedMessages = params.messages.map((message) => {
    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      payload.name = message.name;
    }

    if (message.tool_call_id) {
      payload.tool_call_id = message.tool_call_id;
    }

    if (message.tool_calls && message.tool_calls.length) {
      payload.tool_calls = message.tool_calls;
    }

    return payload;
  });

  const body: Record<string, unknown> = {
    model: DEFAULT_MODEL,
    messages: serialisedMessages,
    temperature: params.temperature ?? 0.2,
    stream: true,
  };

  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText || response.statusText}`);
  }

  const stream = response.body;

  if (!stream) {
    throw new Error("OpenAI API response did not include a body to stream");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const lines = chunk.split("\n");
        let dataLine = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLine += line.slice(5).trim();
          }
        }

        if (!dataLine) {
          boundary = buffer.indexOf("\n\n");
          continue;
        }

        if (dataLine === "[DONE]") {
          return;
        }

        try {
          const parsed = JSON.parse(dataLine) as ChatCompletionChunk;
          yield parsed;
        } catch (error) {
          console.warn("Failed to parse OpenAI stream chunk", error);
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
