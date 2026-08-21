/**
 * LLM Provider:Supervisor 的大脑。
 * M1 实现 OpenAI 兼容协议(/chat/completions,DeepSeek/Qwen/GLM/Kimi/Ollama 通用);
 * 消息支持原生 tool 协议(assistant.tool_calls + tool 回填),Supervisor 的
 * 规划/验收/反思循环都建立在这层之上。
 */

/** OpenAI function-calling 包装格式(request.tools 直接使用,provider 原样下发) */
export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
  usage: { input: number; output: number };
  stopReason: 'end' | 'tool_use' | 'max_tokens';
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** OpenAI 兼容 wire 格式(仅用到的字段) */
interface OpenAiChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
}

interface OpenAiBody {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseToolCallArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string },
    private readonly timeoutMs = 120_000,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const wireMessages = [
      { role: 'system', content: req.system },
      ...req.messages.map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        return {
          role: 'assistant',
          content: m.content ?? '',
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        };
      }),
    ];
    const body = {
      model: this.cfg.model,
      messages: wireMessages,
      ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
    };

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as OpenAiBody;
    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      args: parseToolCallArgs(tc.function?.arguments),
    }));
    const finish = choice?.finish_reason;
    return {
      text: choice?.message?.content ?? null,
      toolCalls,
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      stopReason: finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end',
    };
  }
}
