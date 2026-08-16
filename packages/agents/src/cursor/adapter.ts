/**
 * CursorAdapter:Cursor 的 OpenHarness 接入层。
 *
 * 历史会话:Cursor 的会话检索库 conversation-search.db 的 conversations 表
 * (id / title / updated_at;只读)。实时:经 `cursor-agent --print --output-format
 * stream-json` 发射任务并流式归一化。打断 = 进程组 SIGINT;
 * 深链 = `cursor agent --resume <chatId>`。
 */
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  type AgentAdapter,
  type AgentConfigEntry,
  type AgentConfigInfo,
  type AgentStatus,
  type ConfigFieldDef,
  type CursorStore,
  type HarnessEvent,
  type IndexHandlers,
  type LaunchOptions,
  type SessionSummary,
  type TaskHandle,
  isInjectedSystemText,
  truncate,
} from '@openharness/core';

export const CURSOR_SEARCH_DB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'conversation-search.db',
);

interface ConversationRow {
  id: string;
  title: string;
  ftsTitle: string;
  body: string;
  updated_at: number;
}

function listConversations(dbPath: string): ConversationRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, f.title AS fts_title, f.body AS body
         FROM conversations c
         LEFT JOIN conversation_fts f ON f.rowid = c.fts_rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      ftsTitle: String(r.fts_title ?? ''),
      body: String(r.body ?? ''),
      updated_at: Number(r.updated_at ?? 0),
    }));
  } finally {
    db.close();
  }
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text?: string } => c && typeof c === 'object' && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** 把 cursor-agent 的流式记录归一化(协议与 Claude 类似,容错处理) */
export function normalizeStreamRecord(rec: Record<string, unknown>): HarnessEvent[] {
  const type = rec.type as string | undefined;
  const sessionId = (rec.session_id ?? rec.chatId ?? '') as string;
  const cwd = (rec.cwd as string) ?? null;
  const ts = typeof rec.timestamp === 'string' && rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
  const base = { agent: 'cursor' as const, projectDir: cwd, sessionId, ts };

  if (type === 'system' && rec.subtype === 'init') {
    return [{ ...base, kind: 'session-start', summary: `任务会话开始(${String(rec.model ?? '模型')})`, meta: { model: rec.model } }];
  }
  if (type === 'assistant') {
    const message = (rec.message ?? {}) as Record<string, unknown>;
    const content = (message.content ?? []) as Array<Record<string, unknown>>;
    const events: HarnessEvent[] = [];
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        events.push({ ...base, kind: 'assistant-message', summary: truncate(c.text), meta: { fullText: c.text } });
      } else if (c.type === 'tool_use') {
        events.push({ ...base, kind: 'tool-call', summary: `调用工具 ${String(c.name ?? '?')}`, meta: { tool: c.name } });
      }
    }
    if (events.length > 0 && typeof message.model === 'string') {
      events[0] = { ...events[0]!, meta: { ...events[0]!.meta, model: message.model } };
    }
    return events;
  }
  if (type === 'user') {
    const text = collectText((rec.message as { content?: unknown } | undefined)?.content);
    if (text && isInjectedSystemText(text)) return [];
    return text ? [{ ...base, kind: 'user-message', summary: truncate(text) }] : [];
  }
  return [];
}

export class CursorAdapter implements AgentAdapter {
  readonly agentId = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly enabled = true;

  constructor(private readonly cursorStore?: CursorStore) {}

  async listSessions(): Promise<SessionSummary[]> {
    const rows = listConversations(CURSOR_SEARCH_DB);
    return rows
      .map((r) => this.toSummary(r))
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  async indexEvents(handlers: IndexHandlers): Promise<void> {
    const rows = listConversations(CURSOR_SEARCH_DB);
    for (const r of rows) {
      const cursorKey = `cursor-conv:${r.id}`;
      if (this.cursorStore?.get(cursorKey)) continue;
      this.cursorStore?.set(cursorKey, 1);
      handlers.onSummary(this.toSummary(r));
      handlers.onEvent({
        ts: r.updated_at,
        agent: 'cursor',
        projectDir: null,
        sessionId: r.id,
        kind: 'session-start',
        summary: `会话开始:${r.title || r.ftsTitle || `会话 ${r.id.slice(0, 8)}`}`,
        meta: { chatId: r.id },
      });
      // search-db 的 FTS body 存有会话全文(无角色分段):以一条消息事件呈现对话轨迹
      if (r.body.trim()) {
        handlers.onEvent({
          ts: r.updated_at,
          agent: 'cursor',
          projectDir: null,
          sessionId: r.id,
          kind: 'user-message',
          summary: `对话内容(共 ${r.body.length} 字):${truncate(r.body, 300)}`,
          meta: { chatId: r.id },
        });
      }
    }
  }

  async watch(onEvent: (e: HarnessEvent) => void): Promise<() => Promise<void>> {
    // conversation-search.db 随 Cursor 使用而更新;变化时增量发现新会话
    const watcher: FSWatcher = chokidar.watch(CURSOR_SEARCH_DB, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 300 },
    });
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const r of listConversations(CURSOR_SEARCH_DB)) {
          const cursorKey = `cursor-conv:${r.id}`;
          if (this.cursorStore?.get(cursorKey)) continue;
          this.cursorStore?.set(cursorKey, 1);
          onEvent({
            ts: r.updated_at,
            agent: 'cursor',
            projectDir: null,
            sessionId: r.id,
            kind: 'session-start',
            summary: `新会话:${r.title || r.ftsTitle || `会话 ${r.id.slice(0, 8)}`}`,
            meta: { chatId: r.id },
          });
          if (r.body.trim()) {
            onEvent({
              ts: r.updated_at,
              agent: 'cursor',
              projectDir: null,
              sessionId: r.id,
              kind: 'user-message',
              summary: `对话内容(共 ${r.body.length} 字):${truncate(r.body, 300)}`,
              meta: { chatId: r.id },
            });
          }
        }
      } catch {
        // DB 可能被锁,下轮再试
      } finally {
        busy = false;
      }
    };
    watcher.on('add', () => void refresh());
    watcher.on('change', () => void refresh());

    return async () => {
      await watcher.close();
    };
  }

  async launch(opts: LaunchOptions, onEvent: (e: HarnessEvent) => void): Promise<TaskHandle> {
    // 优先直连 cursor-agent;未安装则退回 `cursor agent` 包装命令
    const [bin, prefix] = await this.resolveBinary();
    const child = spawn(
      bin,
      [
        ...prefix,
        '--print',
        '--output-format',
        'stream-json',
        ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
        ...(opts.bypassPermissions ? ['--yolo', '--sandbox', 'disabled', '--approve-mcps'] : []),
        ...(opts.model ? ['--model', opts.model] : []),
        opts.prompt,
      ],
      { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const id = opts.taskId;
    let sessionId: string | null = null;
    let settled = false;
    let errTail = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      // 常见失败原因映射为可操作提示
      const hint = /Authentication required/i.test(errTail)
        ? `cursor-agent 未登录:请在终端执行 cursor-agent login(与 Cursor IDE 登录态不共享),或设置 CURSOR_API_KEY 环境变量后重试`
        : errTail.includes('ENOENT')
          ? '未找到 cursor-agent,请先安装(brew install cursor-agent 或 Cursor IDE 内置)'
          : '';
      onEvent({
        ts: Date.now(), agent: 'cursor', projectDir: opts.cwd, sessionId: sessionId ?? id,
        kind: 'task-end',
        summary: state === 'done' ? '任务完成' : hint || `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, conversationId: opts.conversationId, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'cursor', projectDir: opts.cwd, sessionId: sessionId ?? id,
        kind: 'error', summary: `启动失败:${err.message}`, meta: { taskId: id, conversationId: opts.conversationId },
      });
      settle(null, 'error');
    });
    child.on('close', (code) => settle(code, code === 0 ? 'done' : 'error'));

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (rec.type === 'system' && rec.subtype === 'init') {
        sessionId = (rec.session_id as string) ?? (rec.chatId as string) ?? sessionId;
      }
      if (rec.type === 'result' && rec.session_id) sessionId = rec.session_id as string;
      for (const e of normalizeStreamRecord(rec)) {
        if (e.kind === 'user-message') continue; // 回显略过
        onEvent({ ...e, sessionId: sessionId ?? e.sessionId, meta: { ...e.meta, taskId: id, conversationId: opts.conversationId } });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString()).slice(-600);
    });

    return {
      id,
      pid: child.pid,
      stop: () =>
        new Promise<void>((resolve) => {
          if (settled || !child.pid) return resolve();
          const killer = setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch { /* 已退出 */ }
          }, 5000);
          child.once('close', () => {
            clearTimeout(killer);
            resolve();
          });
          try {
            process.kill(-child.pid, 'SIGINT');
          } catch {
            clearTimeout(killer);
            resolve();
          }
        }),
    };
  }

  /** 探测 cursor-agent CLI 进程(IDE 本体不算) */
  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-x', 'cursor-agent'], (err) => resolve(!err));
    });
  }

  resumeCommand(sessionId: string): string {
    return `cursor agent --resume ${sessionId}`;
  }

  async describeConfig(): Promise<AgentConfigInfo> {
    const sections: AgentConfigInfo['sections'] = [];
    const notes: string[] = [];
    const run = (bin: string, args: string[]): Promise<string> =>
      new Promise((resolve) => {
        execFile(bin, args, { timeout: 8000 }, (err, stdout) => resolve(err ? '' : (stdout ?? '').trim()));
      });

    const cliVersion = await run('cursor-agent', ['--version']);
    const ideVersion = await run('defaults', ['read', '/Applications/Cursor.app/Contents/Info.plist', 'CFBundleShortVersionString']);
    const items: AgentConfigEntry[] = [];
    if (cliVersion) items.push({ key: 'cursor-agent CLI', value: cliVersion });
    if (ideVersion) items.push({ key: 'Cursor IDE', value: ideVersion });
    if (items.length) sections.push({ title: '版本', items });

    notes.push('CLI 登录态与 IDE 不共享:控制台发任务前需执行一次 `cursor-agent login`');
    notes.push('会话索引来自 ~/Library/Application Support/Cursor/User/globalStorage/conversation-search.db(只读)');
    notes.push('Cursor 凭据走 OAuth 登录(钥匙串),不落配置文件;修改 api key / baseUrl 请用 `cursor-agent login` 或 Cursor IDE 设置');
    return { agent: this.agentId, sections, notes };
  }

  // ---- 配置编辑:Cursor 无配置文件可改,提供空 schema ----

  async configSchema(): Promise<ConfigFieldDef[]> {
    return [];
  }

  async getConfigValues(): Promise<Record<string, string>> {
    return {};
  }

  async updateConfig(_values: Record<string, string>): Promise<{ applied: string[] }> {
    throw new Error('Cursor 凭据走 OAuth 登录,请用 `cursor-agent login` 修改');
  }

  describeStatus(extra: Pick<AgentStatus, 'activeTasks' | 'queuedTasks' | 'sessionsCount'>): AgentStatus {
    return { agent: this.agentId, state: 'idle', enabled: this.enabled, ...extra };
  }

  private toSummary(r: ConversationRow): SessionSummary {
    return {
      agent: this.agentId,
      sessionId: r.id,
      projectDir: null,
      title: r.title || r.ftsTitle || `会话 ${r.id.slice(0, 8)}`,
      firstTs: r.updated_at,
      lastTs: r.updated_at,
      messageCount: r.body.trim() ? 1 : 0,
      inputTokens: 0,
      outputTokens: 0,
      resumeCommand: this.resumeCommand(r.id),
    };
  }

  private async resolveBinary(): Promise<[string, string[]]> {
    return new Promise((resolve) => {
      execFile('which', ['cursor-agent'], (err) => {
        if (!err) return resolve(['cursor-agent', []]);
        resolve(['cursor', ['agent']]);
      });
    });
  }
}
