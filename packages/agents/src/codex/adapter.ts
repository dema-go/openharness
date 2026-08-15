/**
 * CodexAdapter:OpenAI Codex CLI 的 OpenHarness 接入层。
 * - 索引/监听 ~/.codex/sessions 下 rollout JSONL(游标增量续读)
 * - 经 `codex exec --json` 发射任务并流式归一化
 * - 打断 = 进程组 SIGINT;深链 = `codex resume <sessionId>`
 * - probe 排除 ChatGPT 桌面 App 的常驻 codex 进程,只认 CLI 任务进程
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  type AgentAdapter,
  type AgentConfigInfo,
  type AgentStatus,
  type ConfigFieldDef,
  type CursorStore,
  type HarnessEvent,
  type IndexHandlers,
  type LaunchOptions,
  type SessionSummary,
  type TaskHandle,
  truncate,
} from '@openharness/core';
import { entry, parseTomlSections, patchToml } from '../config-utils.js';
import { listSessionFiles, normalizeRecord, parseSessionFile, type ParseResult } from './session-file.js';

export const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

export class CodexAdapter implements AgentAdapter {
  readonly agentId = 'codex' as const;
  readonly displayName = 'Codex';
  readonly enabled = true;

  private readonly offsets = new Map<string, number>();

  constructor(private readonly cursorStore?: CursorStore) {}

  async listSessions(): Promise<SessionSummary[]> {
    const files = await listSessionFiles(CODEX_SESSIONS_ROOT);
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
    const files = await listSessionFiles(CODEX_SESSIONS_ROOT);
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
    const watcher: FSWatcher = chokidar.watch(path.join(CODEX_SESSIONS_ROOT, '**', '*.jsonl'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
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
    const autonomy = opts.bypassPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
    // 续接模式:`codex exec resume <sessionId> --json <prompt>`(--json 已验证可用)
    const args = opts.resumeSessionId
      ? [
          'exec',
          'resume',
          opts.resumeSessionId,
          '--json',
          ...autonomy,
          ...(opts.model ? ['-c', `model=${opts.model}`] : []),
          opts.prompt,
        ]
      : ['exec', '--json', ...autonomy, ...(opts.model ? ['-m', opts.model] : []), opts.prompt];
    const child = spawn('codex', args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const id = opts.taskId;
    let sessionId: string | null = opts.resumeSessionId ?? null;
    let settled = false;
    let errTail = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      onEvent({
        ts: Date.now(),
        agent: 'codex',
        projectDir: opts.cwd,
        sessionId: sessionId ?? id,
        kind: 'task-end',
        summary: state === 'done' ? '任务完成' : `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, conversationId: opts.conversationId, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'codex', projectDir: opts.cwd, sessionId: sessionId ?? id,
        kind: 'error', summary: `启动失败:${err.message}`, meta: { taskId: id, conversationId: opts.conversationId },
      });
      settle(null, 'error');
    });
    child.on('close', (code) => settle(code, code === 0 ? 'done' : 'error'));

    const rl = createInterface({ input: child.stdout! });
    let turnModel: string | null = null;
    rl.on('line', (line) => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      const payload = (rec.payload ?? {}) as Record<string, unknown>;
      if (rec.type === 'session_meta' && payload.session_id) {
        sessionId = payload.session_id as string;
      }
      if (rec.type === 'thread.started' && typeof rec.thread_id === 'string' && !sessionId) {
        sessionId = rec.thread_id as string;
      }
      if (rec.type === 'turn_context' && typeof payload.model === 'string') {
        turnModel = payload.model as string;
      }
      for (const e of normalizeRecord(rec)) {
        if (e.kind === 'user-message') continue; // 工具结果回显太噪,略过
        onEvent({
          ...e,
          sessionId: sessionId ?? e.sessionId,
          meta: { ...e.meta, taskId: id, conversationId: opts.conversationId, ...(turnModel ? { model: turnModel } : {}) },
        });
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

  /**
   * 探测 Codex CLI 任务进程。
   * 只认进程名恰为 codex 的 CLI 会话(app-server / code-mode-host 等桌面常驻排除)。
   */
  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-x', 'codex'], (err, stdout) => {
        if (err) return resolve(false);
        const pids = (stdout ?? '').split('\n').filter(Boolean);
        if (pids.length === 0) return resolve(false);
        execFile('ps', ['-o', 'args=', '-p', pids.join(',')], (err2, out) => {
          if (err2) return resolve(false);
          const lines = (out ?? '').split('\n').filter((l) => l.trim());
          resolve(lines.some((l) => !/app-server|code-mode-host/.test(l)));
        });
      });
    });
  }

  resumeCommand(sessionId: string): string {
    return `codex resume ${sessionId}`;
  }

  async describeConfig(): Promise<AgentConfigInfo> {
    const sections: AgentConfigInfo['sections'] = [];
    const notes: string[] = [];
    try {
      const content = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
      const toml = parseTomlSections(content);

      const root = toml.get('') ?? new Map();
      const rootItems = [
        ...(root.has('model') ? [entry('model', root.get('model')!)] : []),
        ...(root.has('model_reasoning_effort') ? [entry('model_reasoning_effort', root.get('model_reasoning_effort')!)] : []),
        ...(root.has('sandbox_mode') ? [entry('sandbox_mode', root.get('sandbox_mode')!)] : []),
        ...(root.has('approval_policy') ? [entry('approval_policy', root.get('approval_policy')!)] : []),
      ];
      if (rootItems.length) sections.push({ title: '模型与沙箱', items: rootItems });

      const features = toml.get('features');
      if (features?.size) sections.push({ title: '特性开关', items: [...features].map(([k, v]) => entry(k, v)) });

      const plugins = [...toml.entries()]
        .filter(([name]) => name.startsWith('plugins.'))
        .filter(([, kv]) => kv.get('enabled') === 'true')
        .map(([name]) => name.replace(/^plugins\./, '').replace(/^"|"$/g, ''));
      if (plugins.length) {
        sections.push({ title: '插件(启用)', items: plugins.map((p) => ({ key: p, value: '启用' })) });
      }

      const mcp = [...toml.entries()].filter(
        ([name]) => name.startsWith('mcp_servers.') && !name.endsWith('.env'),
      );
      if (mcp.length) {
        sections.push({
          title: 'MCP 服务器',
          items: mcp.map(([name, kv]) => ({
            key: name.replace(/^mcp_servers\./, ''),
            value: `${kv.get('command') ?? '?'}${kv.get('enabled') === 'false' ? '(禁用)' : ''}`,
          })),
        });
      }

      const projects = [...toml.entries()].filter(([name]) => name.startsWith('projects.'));
      if (projects.length) {
        sections.push({ title: '项目信任', items: [{ key: '已信任项目', value: `${projects.length} 个` }] });
      }

      const shellEnv = toml.get('shell_environment_policy.set');
      if (shellEnv?.size) sections.push({ title: 'Shell 环境注入', items: [...shellEnv].map(([k, v]) => entry(k, v)) });

      const memories = toml.get('memories');
      if (memories?.size) sections.push({ title: '记忆', items: [...memories].map(([k, v]) => entry(k, v)) });

      notes.push('配置位于 ~/.codex/config.toml(结构化展示,密钥已脱敏)');
    } catch {
      notes.push('未找到 ~/.codex/config.toml');
    }
    return { agent: this.agentId, sections, notes };
  }

  // ---- 配置编辑(config.toml 逐行补丁,其余内容保留) ----

  private readonly configPath = path.join(os.homedir(), '.codex', 'config.toml');

  private async readToml(): Promise<string> {
    try {
      return await fs.readFile(this.configPath, 'utf8');
    } catch {
      return '';
    }
  }

  async configSchema(): Promise<ConfigFieldDef[]> {
    const root = parseTomlSections(await this.readToml()).get('') ?? new Map<string, string>();
    const get = (k: string): string => root.get(k) ?? '';
    const mk = (key: string, label: string, opts?: Partial<ConfigFieldDef>): ConfigFieldDef => ({
      key,
      label,
      type: 'string',
      group: '模型与沙箱',
      value: get(key),
      ...opts,
    });
    return [
      mk('model', '模型', { hint: '如 gpt-5.6-sol' }),
      mk('model_provider', '模型供应商', { hint: 'config.toml 中 [model_providers.<id>] 定义的 id' }),
      mk('model_reasoning_effort', '推理强度', { options: ['minimal', 'low', 'medium', 'high', 'xhigh'], type: 'select' }),
      mk('sandbox_mode', '沙箱模式', { options: ['read-only', 'workspace-write', 'danger-full-access'], type: 'select' }),
      mk('approval_policy', '审批策略', { options: ['untrusted', 'on-failure', 'on-request', 'never'], type: 'select' }),
    ];
  }

  async getConfigValues(): Promise<Record<string, string>> {
    const root = parseTomlSections(await this.readToml()).get('') ?? new Map<string, string>();
    const out: Record<string, string> = {};
    for (const f of await this.configSchema()) out[f.key] = root.get(f.key) ?? '';
    return out;
  }

  async updateConfig(values: Record<string, string>): Promise<{ applied: string[] }> {
    const content = await this.readToml();
    const updates = Object.entries(values).map(([key, value]) => ({ section: null, key, value }));
    const next = patchToml(content, updates);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, next, 'utf8');
    return { applied: Object.keys(values) };
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
