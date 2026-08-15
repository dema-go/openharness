/**
 * Codex 会话文件解析。
 *
 * 源:~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * 每行一个 JSON 记录,顶层 type:session_meta / turn_context / response_item /
 * event_msg / world_state / compacted / inter_agent_communication_metadata。
 * 实测结构见 docs/vision-discussion.md 第 4 轮记录。
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { truncate, type HarnessEvent } from '@openharness/core';

export interface ParseResult {
  /** 对话级会话 ID(session_meta.session_id),用于 resume */
  sessionId: string;
  projectDir: string | null;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  offset: number;
}

export interface ParseOptions {
  offset?: number;
  onEvent?: (e: HarnessEvent) => void;
}

function usageOf(rec: Record<string, unknown>): { input: number; output: number } | undefined {
  const p = rec.payload as Record<string, unknown> | undefined;
  const u = (p?.usage ?? rec.usage) as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const input = Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0);
  return input || output ? { input, output } : undefined;
}

/** 把一行原生记录归一化为 0..n 个 HarnessEvent */
export function normalizeRecord(rec: Record<string, unknown>): HarnessEvent[] {
  const type = rec.type as string | undefined;
  const payload = (rec.payload ?? {}) as Record<string, unknown>;
  const sessionId = (payload.session_id ?? payload.id ?? '') as string;
  const cwd = (payload.cwd as string) ?? null;
  const ts = typeof rec.timestamp === 'string' && rec.timestamp
    ? Date.parse(rec.timestamp)
    : Date.now();
  const base = { agent: 'codex' as const, projectDir: cwd, sessionId, ts };
  const usage = usageOf(rec);

  switch (type) {
    case 'session_meta':
      return [{ ...base, kind: 'session-start', summary: '会话开始', meta: { cliVersion: payload.cli_version } }];
    case 'response_item': {
      const rt = payload.type;
      if (rt === 'message') {
        const role = payload.role;
        const content = (payload.content ?? []) as Array<Record<string, unknown>>;
        const text = content
          .filter((c) => c.type === 'output_text' || c.type === 'input_text')
          .map((c) => String(c.text ?? ''))
          .join('\n')
          .trim();
        if (role === 'user') {
          return text ? [{ ...base, kind: 'user-message', summary: truncate(text) }] : [];
        }
        if (role === 'assistant') {
          if (text) return [{ ...base, kind: 'assistant-message', summary: truncate(text), usage, meta: { fullText: text } }];
          if (content.some((c) => c.type === 'reasoning')) {
            return [{ ...base, kind: 'assistant-message', summary: '（思考中…）', usage }];
          }
        }
        return [];
      }
      if (rt === 'function_call' || rt === 'custom_tool_call' || rt === 'web_search_call' || rt === 'tool_search_call') {
        return [{
          ...base,
          kind: 'tool-call',
          summary: `调用工具 ${String(payload.name ?? rt)}`,
          meta: { tool: payload.name },
        }];
      }
      if (rt === 'agent_message') {
        const text = String(payload.text ?? payload.summary ?? '');
        return [{ ...base, kind: 'assistant-message', summary: truncate(text), meta: { fullText: text } }];
      }
      return [];
    }
    case 'compacted':
      return [{ ...base, kind: 'mode-change', summary: '上下文压缩(compacted)' }];
    case 'item.completed': {
      // codex CLI v0.144+ 的 --json 流格式:item.completed + item 内嵌(type/text/name)
      const item = (rec.item ?? {}) as Record<string, unknown>;
      const it = item.type;
      if (it === 'agent_message') {
        const text = String(item.text ?? '').trim();
        return text ? [{ ...base, kind: 'assistant-message', summary: truncate(text), usage, meta: { fullText: text } }] : [];
      }
      if (it === 'function_call' || it === 'custom_tool_call' || it === 'local_shell_call' || it === 'web_search_call') {
        return [{ ...base, kind: 'tool-call', summary: `调用工具 ${String(item.name ?? it)}`, meta: { tool: item.name } }];
      }
      return [];
    }
    case 'item.started':
    case 'turn.completed':
      // 流式中间标记/usage 汇总:无时间线价值
      return [];
    case 'error':
      return [{
        ...base,
        kind: 'error',
        summary: truncate(String(payload.message ?? rec.message ?? '未知错误'), 200),
      }];
    default:
      // event_msg 是流式中间增量,response_item 已有完整消息,跳过;
      // turn_context / world_state 无时间线价值,跳过。
      return [];
  }
}

/** 解析一个 rollout 文件。 */
export async function parseSessionFile(
  filePath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const offset = opts.offset ?? 0;
  const stream = createReadStream(filePath, { start: offset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // 缺省 ID 取文件名尾段(rollout id)
  const fileId = path.basename(filePath, '.jsonl').split('-').slice(-1)[0] ?? 'unknown';
  let sessionId = fileId;
  let projectDir: string | null = null;
  let title: string | null = null;
  let turnModel: string | null = null;
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
    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    if (payload.session_id) sessionId = payload.session_id as string;
    if (payload.cwd) projectDir = payload.cwd as string;
    // 模型名在 turn_context 里,挂到后续 session-start 事件的 meta 上
    if (rec.type === 'turn_context' && typeof payload.model === 'string') {
      turnModel = payload.model as string;
    }
    if (!title && typeof payload.summary === 'string' && payload.summary.trim()) {
      title = payload.summary.trim();
    }

    for (const e of normalizeRecord(rec)) {
      // 关键修复:response_item 等记录不含 session_id(payload.id 是条目 ID,
      // 并非会话 ID),文件级必须一律覆盖为追踪到的会话 ID,否则消息事件
      // 散落到各个条目 ID 下,会话档案时间线查不到轨迹
      e.sessionId = sessionId || e.sessionId;
      if (projectDir) e.projectDir = projectDir;
      if (e.kind === 'session-start' && turnModel) e.meta = { ...e.meta, model: turnModel };
      if (firstTs === 0 || e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
      if (e.kind === 'user-message' || e.kind === 'assistant-message') messageCount++;
      if (e.usage) {
        inputTokens += e.usage.input;
        outputTokens += e.usage.output;
      }
      opts.onEvent?.(e);
    }
  }

  if (firstTs === 0) firstTs = Date.now();
  if (lastTs === 0) lastTs = firstTs;

  return {
    sessionId,
    projectDir,
    title: title ? truncate(title, 80) : `会话 ${sessionId.slice(0, 8)}`,
    firstTs,
    lastTs,
    messageCount,
    inputTokens,
    outputTokens,
    offset: Math.max(bytes, size),
  };
}

/** 列出 ~/.codex/sessions 下全部 rollout 文件。 */
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
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(root);
  return out;
}
