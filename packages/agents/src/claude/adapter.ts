/**
 * ClaudeAdapter:Claude Code 的 OpenHarness 接入层。
 * - 索引/监听 ~/.claude/projects 下会话 JSONL(游标增量续读)
 * - 经 `claude -p --output-format stream-json` 发射任务并流式归一化
 * - 打断 = 进程组 SIGINT;深链 = `claude --resume <sessionId>`
 */
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  type AgentAdapter,
  type AgentStatus,
  type CursorStore,
  type HarnessEvent,
  type IndexHandlers,
  type LaunchOptions,
  type SessionSummary,
  type TaskHandle,
  truncate,
} from '@openharness/core';
import { listSessionFiles, normalizeRecord, parseSessionFile, type ParseResult } from './session-file.js';

export const CLAUDE_SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'projects');

export class ClaudeAdapter implements AgentAdapter {
  readonly agentId = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly enabled = true;

  /** 会话文件 → 已消费字节偏移(游标,持久化由 CursorStore 承担) */
  private readonly offsets = new Map<string, number>();

  constructor(private readonly cursorStore?: CursorStore) {}

  async listSessions(): Promise<SessionSummary[]> {
    const files = await listSessionFiles(CLAUDE_SESSIONS_ROOT);
    const out: SessionSummary[] = [];
    for (const f of files) {
      try {
        const r = await parseSessionFile(f.filePath);
        out.push(this.toSummary(r));
      } catch {
        // 单个文件损坏不阻塞整体索引
      }
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  async indexEvents(handlers: IndexHandlers): Promise<void> {
    const files = await listSessionFiles(CLAUDE_SESSIONS_ROOT);
    for (const f of files) {
      try {
        const start = this.cursorStore?.get(f.filePath) ?? this.offsets.get(f.filePath) ?? 0;
        const r = await parseSessionFile(f.filePath, { offset: start, onEvent: handlers.onEvent });
        this.offsets.set(f.filePath, r.offset);
        this.cursorStore?.set(f.filePath, r.offset);
        handlers.onSummary(this.toSummary(r));
      } catch {
        // 跳过损坏文件
      }
    }
  }

  async watch(onEvent: (e: HarnessEvent) => void): Promise<() => Promise<void>> {
    const watcher: FSWatcher = chokidar.watch(path.join(CLAUDE_SESSIONS_ROOT, '*.jsonl'), {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    let busy = false;
    const consume = async (filePath: string) => {
      if (busy) return;
      busy = true;
      try {
        const start = this.offsets.get(filePath) ?? 0;
        const r: ParseResult = await parseSessionFile(filePath, { offset: start, onEvent });
        this.offsets.set(filePath, r.offset);
      } catch {
        // 文件可能尚在写入,下轮 change 再试
      } finally {
        busy = false;
      }
    };

    watcher.on('add', (p) => void consume(p));
    watcher.on('change', (p) => void consume(p));

    return async () => {
      await watcher.close();
    };
  }

  async launch(opts: LaunchOptions, onEvent: (e: HarnessEvent) => void): Promise<TaskHandle> {
    const child = spawn(
      'claude',
      ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', ...(opts.model ? ['--model', opts.model] : [])],
      { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const id = opts.taskId;
    let sessionId: string | null = null;
    let settled = false;
    let errTail = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      onEvent({
        ts: Date.now(),
        agent: 'claude',
        projectDir: opts.cwd,
        sessionId: sessionId ?? id,
        kind: 'task-end',
        summary: state === 'done' ? '任务完成' : `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'claude', projectDir: opts.cwd, sessionId: sessionId ?? id,
        kind: 'error', summary: `启动失败:${err.message}`, meta: { taskId: id },
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
        sessionId = (rec.session_id as string) ?? sessionId;
        onEvent({
          ts: Date.now(), agent: 'claude', projectDir: opts.cwd, sessionId: sessionId!,
          kind: 'session-start', summary: `任务会话开始(${String(rec.model ?? '模型')})`,
          meta: { taskId: id, model: rec.model, cwd: rec.cwd },
        });
        return;
      }
      // stream-json 的消息体结构与 jsonl 一致,直接复用归一化器
      for (const e of normalizeRecord(rec)) {
        if (e.kind === 'user-message') continue; // 工具结果回显太噪,略过
        onEvent({ ...e, sessionId: sessionId ?? e.sessionId, meta: { ...e.meta, taskId: id } });
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

  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-f', 'claude'], (err) => resolve(!err));
    });
  }

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  }

  describeStatus(extra: Pick<AgentStatus, 'activeTasks' | 'queuedTasks' | 'sessionsCount'>): AgentStatus {
    return { agent: this.agentId, state: 'idle', enabled: this.enabled, ...extra };
  }

  private toSummary(r: ParseResult): SessionSummary {
    return {
      agent: this.agentId,
      sessionId: r.sessionId,
      projectDir: r.projectDir,
      title: r.title,
      firstTs: r.firstTs,
      lastTs: r.lastTs,
      messageCount: r.messageCount,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      resumeCommand: this.resumeCommand(r.sessionId),
    };
  }
}
