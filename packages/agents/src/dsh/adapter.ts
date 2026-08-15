/**
 * DSHAdapter:DeepSeek Harness 的 OpenHarness 接入层。
 * - 索引/监听 ~/.dsh/sessions 下 zstd 会话文件(整文件解压 + 行号游标)
 * - 经 `dsh --profile headless <task>` 发射单任务;结束文本回填为助手消息
 * - 打断 = 进程组 SIGINT;深链 = `dsh --profile tui --resume <sessionId>`
 * - probe 排除常驻的 `dsh web`(本控制台就运行在其中)
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  type AgentAdapter,
  type AgentConfigEntry,
  type AgentConfigInfo,
  type AgentStatus,
  type CursorStore,
  type HarnessEvent,
  type IndexHandlers,
  type LaunchOptions,
  type SessionSummary,
  type TaskHandle,
  truncate,
} from '@openharness/core';
import { entry } from '../config-utils.js';
import { listSessionFiles, parseSessionFile, type ParseResult } from './session-file.js';

export const DSH_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

export class DshAdapter implements AgentAdapter {
  readonly agentId = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness';
  readonly enabled = true;

  private readonly offsets = new Map<string, number>();

  constructor(private readonly cursorStore?: CursorStore) {}

  async listSessions(): Promise<SessionSummary[]> {
    const files = await listSessionFiles(DSH_SESSIONS_ROOT);
    const out: SessionSummary[] = [];
    for (const f of files) {
      try {
        out.push(this.toSummary(await parseSessionFile(f)));
      } catch {
        // 单个文件损坏不阻塞整体索引
      }
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  async indexEvents(handlers: IndexHandlers): Promise<void> {
    const files = await listSessionFiles(DSH_SESSIONS_ROOT);
    for (const f of files) {
      try {
        const start = this.cursorStore?.get(f) ?? this.offsets.get(f) ?? 0;
        const r = await parseSessionFile(f, { offset: start, onEvent: handlers.onEvent });
        this.offsets.set(f, r.offset);
        this.cursorStore?.set(f, r.offset);
        handlers.onSummary(this.toSummary(r));
      } catch {
        // 跳过损坏文件
      }
    }
  }

  async watch(onEvent: (e: HarnessEvent) => void): Promise<() => Promise<void>> {
    const watcher: FSWatcher = chokidar.watch(path.join(DSH_SESSIONS_ROOT, '**', '*.zstd'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    });

    let busy = false;
    const consume = async (filePath: string) => {
      if (busy) return;
      busy = true;
      try {
        const start = this.offsets.get(filePath) ?? 0;
        const r = await parseSessionFile(filePath, { offset: start, onEvent });
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
    const child = spawn('dsh', ['--profile', 'headless', opts.prompt], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const id = opts.taskId;
    let settled = false;
    let outBuf = '';
    let errTail = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      const final = outBuf.trim();
      if (final) {
        onEvent({
          ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
          kind: 'assistant-message', summary: truncate(final, 400),
          meta: { taskId: id },
        });
      }
      onEvent({
        ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
        kind: 'task-end',
        summary: state === 'done' ? '任务完成' : `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
        kind: 'error', summary: `启动失败:${err.message}`, meta: { taskId: id },
      });
      settle(null, 'error');
    });
    child.on('close', (code) => settle(code, code === 0 ? 'done' : 'error'));

    child.stdout?.on('data', (chunk: Buffer) => {
      outBuf += chunk.toString();
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

  /** 探测 DSH 任务进程;排除常驻的 `dsh web`(OpenHarness 自身就运行在其中)。 */
  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-fl', 'dsh'], (err, stdout) => {
        if (err) return resolve(false);
        const lines = (stdout ?? '').split('\n').filter((l) => l.trim());
        resolve(lines.some((l) => !/\bdsh web\b/.test(l) && /\bdsh\b/.test(l)));
      });
    });
  }

  resumeCommand(sessionId: string): string {
    return `dsh --profile tui --resume ${sessionId}`;
  }

  async describeConfig(): Promise<AgentConfigInfo> {
    const sections: AgentConfigInfo['sections'] = [];
    const notes: string[] = [];
    try {
      const yaml = await fs.readFile(path.join(os.homedir(), '.dsh', 'settings.yaml'), 'utf8');
      const get = (section: string, key: string): string | null => {
        const inSection = yaml.split('\n').some((l) => l.trim() === `${section}:`);
        if (!inSection) return null;
        const lines = yaml.split('\n');
        const start = lines.findIndex((l) => l.trim() === `${section}:`);
        for (let i = start + 1; i < lines.length; i++) {
          const line = lines[i]!;
          if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
          const m = line.match(new RegExp(`^\\s+${key}:\\s*(.+)$`));
          if (m) return m[1]!.trim().replace(/^"|"$/g, '');
        }
        return null;
      };
      const preset = get('permission', 'defaultPreset');
      if (preset) sections.push({ title: '权限', items: [{ key: 'defaultPreset', value: preset }] });
      const modelItems = [
        ...(get('agent-default-model', 'provider') ? [entry('provider', get('agent-default-model', 'provider')!)] : []),
        ...(get('agent-default-model', 'model') ? [entry('model', get('agent-default-model', 'model')!)] : []),
        ...(get('agent-default-model', 'reasoningEffort') ? [entry('reasoningEffort', get('agent-default-model', 'reasoningEffort')!)] : []),
      ];
      if (modelItems.length) sections.push({ title: '默认模型', items: modelItems });
      const providerNames = [...yaml.matchAll(/^\s{4}([A-Za-z0-9-]+):\s*$/gm)].map((m) => m[1]!);
      if (providerNames.length) {
        sections.push({ title: 'LLM Provider', items: providerNames.map((p) => ({ key: p, value: '已注册' })) });
      }
      notes.push('配置位于 ~/.dsh/settings.yaml;凭据保存在 ~/.dsh/.credentials.yaml(未展示)');
    } catch {
      notes.push('未找到 ~/.dsh/settings.yaml');
    }
    try {
      const profiles = await fs.readdir(path.join(os.homedir(), '.dsh', 'profiles'));
      const items: AgentConfigEntry[] = [];
      for (const p of profiles.filter((x) => x !== 'node_modules')) {
        try {
          const pkg = JSON.parse(
            await fs.readFile(path.join(os.homedir(), '.dsh', 'profiles', p, 'package.json'), 'utf8'),
          ) as { dsh?: { profile?: { bundles?: string[] } } };
          items.push({ key: p, value: (pkg.dsh?.profile?.bundles ?? []).join('、') || '(无 bundle)' });
        } catch {
          /* 非 package 目录 */
        }
      }
      if (items.length) sections.push({ title: 'Profiles', items });
    } catch {
      /* 忽略 */
    }
    return { agent: this.agentId, sections, notes };
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
