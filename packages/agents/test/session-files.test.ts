import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRecord as normalizeCodex } from '../src/codex/session-file.js';
import { parseSessionFile as parseCodexFile } from '../src/codex/session-file.js';
import { normalizeRecord as normalizeClaude } from '../src/claude/session-file.js';
import { normalizeRecord as normalizeDsh } from '../src/dsh/session-file.js';
import { normalizeStreamRecord as normalizeCursor } from '../src/cursor/adapter.js';

describe('claude 归一化', () => {
  it('assistant 文本带 fullText,user 消息过滤系统注入', () => {
    const events = normalizeClaude({
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-08-16T00:00:00.000Z',
      message: { content: [{ type: 'text', text: '长回复'.repeat(100) }] },
    });
    expect(events[0]!.kind).toBe('assistant-message');
    expect(events[0]!.meta?.fullText).toHaveLength(300);
    expect(events[0]!.summary.length).toBeLessThan(300); // 摘要截断,全文保留

    const injected = normalizeClaude({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-08-16T00:00:00.000Z',
      message: { content: [{ type: 'text', text: '<system-reminder> 遵守规范' }] },
    });
    expect(injected).toHaveLength(0);
  });

  it('[本轮消息] 注入任务只保留真实输入', () => {
    const events = normalizeClaude({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-08-16T00:00:00.000Z',
      message: { content: [{ type: 'text', text: '[对话背景] 历史…\n\n[本轮消息] 真实任务' }] },
    });
    expect(events[0]!.summary).toBe('真实任务');
  });
});

describe('codex 归一化', () => {
  it('response_item 消息:角色/全文/注入过滤', () => {
    const a = normalizeCodex({
      type: 'response_item',
      timestamp: '2026-08-16T00:00:00.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到' }] },
    });
    expect(a[0]!.kind).toBe('assistant-message');
    expect(a[0]!.meta?.fullText).toBe('收到');

    const sys = normalizeCodex({
      type: 'response_item',
      timestamp: '2026-08-16T00:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nA\nB' }] },
    });
    expect(sys).toHaveLength(0);
  });

  it('item.completed 新流格式(agent_message / tool call)', () => {
    const msg = normalizeCodex({ type: 'item.completed', timestamp: '2026-08-16T00:00:00.000Z', item: { id: 'i1', type: 'agent_message', text: '好' } });
    expect(msg[0]!.kind).toBe('assistant-message');
    expect(msg[0]!.summary).toBe('好');

    const tool = normalizeCodex({ type: 'item.completed', timestamp: '2026-08-16T00:00:00.000Z', item: { id: 'i2', type: 'local_shell_call', name: 'exec' } });
    expect(tool[0]!.kind).toBe('tool-call');
  });
});

describe('dsh 归一化', () => {
  it('system-reminder 不算用户消息;[本轮消息] 提取真实输入', () => {
    const sys = normalizeDsh({ type: 'user/message', time: '2026-08-16T00:00:00.000Z', data: { content: [{ type: 'text', text: '<system-reminder> x' }] } });
    expect(sys).toHaveLength(0);
    const real = normalizeDsh({ type: 'user/message', time: '2026-08-16T00:00:00.000Z', data: { content: [{ type: 'text', text: '[对话背景] 历史\n\n[本轮消息] 你好' }] } });
    expect(real[0]!.summary).toBe('你好');
  });
});

describe('cursor 流式归一化', () => {
  it('assistant 文本带 fullText,tool_use 归类', () => {
    const events = normalizeCursor({
      type: 'assistant',
      session_id: 'c1',
      message: { content: [{ type: 'text', text: '回答' }, { type: 'tool_use', name: 'edit' }] },
    });
    expect(events.map((e) => e.kind)).toEqual(['assistant-message', 'tool-call']);
    expect(events[0]!.meta?.fullText).toBe('回答');
  });
});

describe('codex 文件解析:游标续读', () => {
  it('增量解析不重复产出,汇总不被空解析清零', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-codex-test-'));
    const file = path.join(dir, 'rollout-test.jsonl');
    const rec = (n: number) =>
      `${JSON.stringify({ timestamp: '2026-08-16T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `消息${n}` }] } })}\n`;
    try {
      writeFileSync(file, rec(1) + rec(2));
      const r1 = await parseCodexFile(file);
      expect(r1.messageCount).toBe(2);
      // 追加一条
      writeFileSync(file, rec(1) + rec(2) + rec(3));
      const seen: string[] = [];
      const r2 = await parseCodexFile(file, { offset: r1.offset, onEvent: (e) => seen.push(e.summary) });
      expect(r2.messageCount).toBe(1); // 只解析新增
      expect(seen).toEqual(['消息3']);
      // 已消费完:跳过解析时汇总保持有效(由适配器层保证,这里验证 offset 语义)
      const r3 = await parseCodexFile(file, { offset: r2.offset });
      expect(r3.messageCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
