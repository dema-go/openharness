/**
 * Claude Code 会话文件解析。
 *
 * 源:~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * 每行一个带 type 的 JSON 记录(user/assistant/system/ai-title/mode/...)。
 * 实测结构见 docs/vision-discussion.md 第 2 轮记录。
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { truncate, type HarnessEvent } from '@openharness/core';

export interface SessionFile {
  filePath: string;
  /** 目录名编码的 cwd(仅作后备,真实 cwd 以记录内字段为准) */
  projectDirHint: string;
}

export interface ParseResult {
  sessionId: string;
  projectDir: string | null;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  /** 解析结束时的字节偏移,供增量续读 */
  offset: number;
}

export interface ParseOptions {
  /** 从该字节偏移开始解析(0 = 全量) */
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

/** 把一行原生记录归一化为 0..n 个 HarnessEvent */
export function normalizeRecord(rec: Record<string, unknown>): HarnessEvent[] {
  const type = rec.type as string | undefined;
  const sessionId = (rec.sessionId ?? rec.session_id ?? '') as string;
  const cwd = (rec.cwd as string) ?? null;
  const ts = typeof rec.timestamp === 'string' && rec.timestamp
    ? Date.parse(rec.timestamp)
    : Date.now();
  const base = { agent: 'claude' as const, projectDir: cwd, sessionId, ts };

  switch (type) {
    case 'user': {
      const text = collectText((rec.message as { content?: unknown } | undefined)?.content);
      if (!text) return [];
      return [{ ...base, kind: 'user-message', summary: truncate(text) }];
    }
    case 'assistant': {
      const message = rec.message as {
        content?: Array<Record<string, unknown>>;
        usage?: Record<string, unknown>;
        model?: unknown;
      } | undefined;
      const usage = message?.usage;
      const usageNorm = usage
        ? { input: (usage.input_tokens as number) ?? 0, output: (usage.output_tokens as number) ?? 0 }
        : undefined;
      const events: HarnessEvent[] = [];
      for (const c of message?.content ?? []) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          events.push({ ...base, kind: 'assistant-message', summary: truncate(c.text) });
        } else if (c.type === 'tool_use') {
          events.push({
            ...base,
            kind: 'tool-call',
            summary: `调用工具 ${String(c.name ?? '?')}`,
            meta: { tool: c.name, input: c.input },
          });
        }
      }
      if (events.length === 0 && (message?.content?.length ?? 0) > 0) {
        // 只有 thinking 块时也保留一条轻量事件,保证时间线连续
        events.push({ ...base, kind: 'assistant-message', summary: '（思考中…）' });
      }
      // usage 是消息级指标,只附在首个事件上,避免求和重复计数
      // model 是消息级信息,挂在首个事件 meta 上供用量归属
      if (events.length > 0) {
        const first = events[0]!;
        events[0] = {
          ...first,
          ...(usageNorm ? { usage: usageNorm } : {}),
          ...(typeof message?.model === 'string' ? { meta: { ...first.meta, model: message.model } } : {}),
        };
      }
      return events;
    }
    case 'mode':
      return [{ ...base, kind: 'mode-change', summary: `模式切换 → ${String(rec.mode ?? '?')}` }];
    case 'system': {
      if (rec.subtype === 'init') {
        return [{
          ...base,
          kind: 'session-start',
          summary: `会话开始(${String(rec.model ?? '模型')})`,
          meta: { model: rec.model, tools: rec.tools },
        }];
      }
      return [];
    }
    case 'file-history-snapshot':
    case 'file-history-delta': {
      const files = (rec.snapshot ?? rec.delta ?? []) as Array<{ path?: string }> | undefined;
      const n = files?.length ?? 0;
      if (n === 0) return [];
      return [{
        ...base,
        kind: 'file-edit',
        summary: `修改了 ${n} 个文件${n <= 3 ? ':' + files!.map((f) => ` ${f.path ?? '?'}`).join('') : ''}`,
      }];
    }
    default:
      return [];
  }
}

/**
 * 解析一个会话文件。onEvent 触发归一化事件;返回汇总供索引。
 */
export async function parseSessionFile(
  filePath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const offset = opts.offset ?? 0;
  const stream = createReadStream(filePath, { start: offset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = path.basename(filePath, '.jsonl');
  let projectDir: string | null = null;
  let title: string | null = null;
  let firstTs = 0;
  let lastTs = 0;
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const size = (await fs.stat(filePath)).size;
  let bytes = offset;

  for await (const line of rl) {
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const recSession = (rec.sessionId ?? rec.session_id) as string | undefined;
    if (recSession) sessionId = recSession;
    if (rec.cwd) projectDir = rec.cwd as string;

    const events = normalizeRecord(rec);
    for (const e of events) {
      if (firstTs === 0 || e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
      if (e.kind === 'user-message' || e.kind === 'assistant-message') messageCount++;
      if (e.usage) {
        inputTokens += e.usage.input;
        outputTokens += e.usage.output;
      }
      opts.onEvent?.(e);
    }

    if (!title && rec.type === 'ai-title') {
      title = (rec.text as string)?.trim() || null;
    }
    if (!title && rec.type === 'user' && !rec.isMeta) {
      const text = collectText((rec.message as { content?: unknown } | undefined)?.content).trim();
      if (text) title = truncate(text, 80);
    }
  }

  if (firstTs === 0) firstTs = Date.now();
  if (lastTs === 0) lastTs = firstTs;

  return {
    sessionId,
    projectDir,
    title: title ?? `会话 ${sessionId.slice(0, 8)}`,
    firstTs,
    lastTs,
    messageCount,
    inputTokens,
    outputTokens,
    offset: Math.max(bytes, size),
  };
}

/** 列出 ~/.claude/projects 下全部会话文件。 */
export async function listSessionFiles(root: string): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    let files;
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      out.push({ filePath: path.join(dirPath, f), projectDirHint: entry.name });
    }
  }
  return out;
}
