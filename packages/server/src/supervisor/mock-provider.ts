/**
 * MockProvider:脚本化 LLM 响应,驱动 Supervisor 全循环单测(CI 无 API Key)。
 * 每次 complete() 依序消费一条脚本;脚本耗尽即抛错(测试里就是断言失败)。
 * 同时记录全部请求,供断言 prompt 注入与工具协议形状。
 */
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

export type ScriptedResponse = LlmResponse | ((req: LlmRequest, callIndex: number) => LlmResponse);

export class MockProvider implements LlmProvider {
  readonly calls: LlmRequest[] = [];

  constructor(private readonly script: ScriptedResponse[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(req);
    const s = this.script[index];
    if (!s) throw new Error(`MockProvider: 脚本耗尽(第 ${index + 1} 次调用)`);
    return typeof s === 'function' ? s(req, index) : s;
  }
}

/** 便捷构造:模型直接调用某个工具 */
export function toolCallResponse(name: string, args: Record<string, unknown>): LlmResponse {
  return {
    text: null,
    toolCalls: [{ id: `mock_${name}_${Math.random().toString(36).slice(2, 8)}`, name, args }],
    usage: { input: 100, output: 20 },
    stopReason: 'tool_use',
  };
}

/** 便捷构造:模型直接给纯文本 */
export function textResponse(text: string): LlmResponse {
  return { text, toolCalls: [], usage: { input: 50, output: 10 }, stopReason: 'end' };
}
