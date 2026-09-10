export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DeepseekConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export async function* streamDeepseekChat(
  config: DeepseekConfig,
  messages: ChatMessage[]
): AsyncGenerator<string, void, unknown> {
  if (!config.apiKey) {
    throw new Error(
      "未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入密钥。"
    );
  }

  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `DeepSeek API 错误 ${res.status}: ${errText.slice(0, 500)}`
    );
  }

  if (!res.body) throw new Error("DeepSeek 响应无 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const token = json.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // ignore partial JSON
      }
    }
  }
}

export async function completeDeepseekChat(
  config: DeepseekConfig,
  messages: ChatMessage[],
  options?: {
    tools?: OpenAITool[];
    temperature?: number;
    timeoutMs?: number;
    json?: boolean;
    maxTokens?: number;
  }
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  if (!config.apiKey) {
    throw new Error(
      "未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入密钥。"
    );
  }

  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    temperature: options?.temperature ?? 0.5,
  };
  if (options?.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  if (options?.json) {
    body.response_format = { type: "json_object" };
  }
  if (options?.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? 90_000
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("DeepSeek 请求超时");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `DeepSeek API 错误 ${res.status}: ${errText.slice(0, 500)}`
    );
  }

  const json = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
    }[];
  };

  const message = json.choices?.[0]?.message;
  return {
    content: message?.content || "",
    toolCalls: message?.tool_calls || [],
  };
}
