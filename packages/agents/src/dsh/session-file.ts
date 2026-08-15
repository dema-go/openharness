/**
 * DSH(DeepSeek Harness)会话文件解析。
 *
 * 源:~/.dsh/sessions/<enc-cwd>/session-<id>/session.jsonl.zstd
 * zstd 压缩 JSONL,记录为 chunk 化事件流:
 * session / user/message / assistant/message / assistant/chunk / tool/call /
 * tool/result / step/start / step/end / todo/write / …-chunks。
 * 实测结构见 docs/vision-discussion.md 第 5 轮记录。
 */
import { promises as fs } from 'node:fs';
import { decompress } from 'fzstd';
import { truncate, type HarnessEvent } from '@openharness/core';

export interface ParseResult {
  sessionId: string;
  projectDir: string | null;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  /** 已消费的记录行数(游标;zstd 流无法按字节续读,按行号跳过) */
  offset: number;
}

export interface ParseOptions {
  /** 从第 N 行开始(0 = 全量) */
  offset?: number;
  onEvent?: (e: HarnessEvent) => void;
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text?: string } => c && typeof c === 'object' && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** 把一条原生记录归一化为 0..n 个 HarnessEvent */
export function normalizeRecord(rec: Record<string, unknown>): HarnessEvent[] {
  const type = rec.type as string | undefined;
  const data = (rec.data ?? {}) as Record<string, unknown>;
  const ts = typeof rec.time === 'string' && rec.time ? Date.parse(rec.time) : Date.now();
  const base = { agent: 'dsh' as const, projectDir: null as string | null, sessionId: '', ts };

  switch (type) {
    case 'session':
      return [{
        ...base,
        kind: 'session-start',
        summary: `会话开始(${String(rec.agentPreset ?? 'agent')})`,
        meta: { agentPreset: rec.agentPreset },
      }];
    case 'user/message': {
      const text = collectText(data.content);
      if (!text) return [];
      return [{ ...base, kind: 'user-message', summary: truncate(text) }];
    }
    case 'assistant/message': {
      const message = (data.message ?? {}) as Record<string, unknown>;
      const text = collectText(message.content);
      const usage = (data.usage ?? {}) as Record<string, unknown>;
      const usageNorm = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || Number(usage.output_tokens ?? usage.outputTokens ?? 0)
        ? {
            input: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
            output: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
          }
        : undefined;
      if (!text) {
        return [{ ...base, kind: 'assistant-message', summary: '（思考中…）', usage: usageNorm }];
      }
      return [{ ...base, kind: 'assistant-message', summary: truncate(text), usage: usageNorm }];
    }
    case 'tool/call':
      return [{
        ...base,
        kind: 'tool-call',
        summary: `调用工具 ${String(data.name ?? '?')}`,
        meta: { tool: data.name },
      }];
    case 'todo/write': {
      const todos = data.todos as Array<{ content?: string; status?: string }> | undefined;
      if (!todos?.length) return [];
      return [{ ...base, kind: 'mode-change', summary: `计划更新(${todos.length} 项)` }];
    }
    default:
      // assistant/chunk、tool-call-chunks、reasoning-chunks 等流式增量,
      // 完整消息已有对应记录,跳过;tool/result 回显略过。
      return [];
  }
}

/** 解压并解析一个 DSH 会话文件。 */
export async function parseSessionFile(
  filePath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  const text = new TextDecoder().decode(decompress(new Uint8Array(buf)));
  const lines = text.split('\n');

  let sessionId = '';
  let projectDir: string | null = null;
  let title: string | null = null;
  let firstTs = 0;
  let lastTs = 0;
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let consumed = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (consumed < (opts.offset ?? 0)) {
      consumed++;
      continue;
    }
    consumed++;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      sessionId = String(rec.id ?? sessionId);
      projectDir = (rec.cwd as string) ?? projectDir;
      if (typeof rec.createdAt === 'number' && firstTs === 0) firstTs = rec.createdAt;
    }
    const events = normalizeRecord(rec);
    for (const e of events) {
      const ev = { ...e, sessionId, projectDir: projectDir ?? e.projectDir };
      if (firstTs === 0 || ev.ts < firstTs) firstTs = ev.ts;
      if (ev.ts > lastTs) lastTs = ev.ts;
      if (ev.kind === 'user-message' || ev.kind === 'assistant-message') messageCount++;
      if (ev.usage) {
        inputTokens += ev.usage.input;
        outputTokens += ev.usage.output;
      }
      if (!title && ev.kind === 'user-message') title = truncate(ev.summary, 80);
      opts.onEvent?.(ev);
    }
  }

  if (!sessionId) sessionId = filePath.split('/').find((s) => s.startsWith('session-')) ?? 'unknown';
  if (firstTs === 0) firstTs = Date.now();
  if (lastTs === 0) lastTs = firstTs;

  return {
    sessionId,
    projectDir,
    title: title ?? `会话 ${sessionId.replace('session-', '').slice(0, 8)}`,
    firstTs,
    lastTs,
    messageCount,
    inputTokens,
    outputTokens,
    offset: consumed,
  };
}

/** 列出 ~/.dsh/sessions 下全部会话文件。 */
export async function listSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.zstd')) out.push(p);
    }
  }
  await walk(root);
  return out;
}
