/**
 * ClaudeAdapter:Claude Code 的 OpenHarness 接入层。
 * - 索引/监听 ~/.claude/projects 下会话 JSONL(游标增量续读)
 * - 经 `claude -p --output-format stream-json` 发射任务并流式归一化
 * - 打断 = 进程组 SIGINT;深链 = `claude --resume <sessionId>`
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
  isSecretKey,
  maskSecret,
  truncate,
} from '@openharness/core';
import { flattenSection } from '../config-utils.js';
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
      [
        '-p',
        ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
        ...(opts.bypassPermissions ? ['--dangerously-skip-permissions'] : []),
        opts.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        ...(opts.model ? ['--model', opts.model] : []),
      ],
      { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const id = opts.taskId;
    let sessionId: string | null = null;
    let settled = false;
    let errTail = '';
    let lastAssistant = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      // headless 模式无人批准权限请求:检测到"权限被拦"时把任务显性标记为失败,
      // 否则会出现"任务完成但报告没写出来"的假成功
      const blocked = /权限|permission|approval|授权/i.test(`${lastAssistant} ${errTail}`);
      if (state === 'done' && blocked) {
        state = 'error';
      }
      onEvent({
        ts: Date.now(),
        agent: 'claude',
        projectDir: opts.cwd,
        sessionId: sessionId ?? id,
        kind: 'task-end',
        summary:
          state === 'done'
            ? '任务完成'
            : blocked
              ? `任务被权限请求拦截(headless 无法批准):${truncate(lastAssistant || errTail, 120)}。勾选「完全自主」后重试即可`
              : `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, conversationId: opts.conversationId, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'claude', projectDir: opts.cwd, sessionId: sessionId ?? id,
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
        sessionId = (rec.session_id as string) ?? sessionId;
        onEvent({
          ts: Date.now(), agent: 'claude', projectDir: opts.cwd, sessionId: sessionId!,
          kind: 'session-start', summary: `任务会话开始(${String(rec.model ?? '模型')})`,
          meta: { taskId: id, conversationId: opts.conversationId, model: rec.model, cwd: rec.cwd },
        });
        return;
      }
      // stream-json 的消息体结构与 jsonl 一致,直接复用归一化器
      for (const e of normalizeRecord(rec)) {
        if (e.kind === 'user-message') continue; // 工具结果回显太噪,略过
        if (e.kind === 'assistant-message') lastAssistant = e.summary;
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

  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-f', 'claude'], (err) => resolve(!err));
    });
  }

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  }

  async describeConfig(): Promise<AgentConfigInfo> {
    const sections: AgentConfigInfo['sections'] = [];
    const notes: string[] = [];
    try {
      const settings = JSON.parse(
        await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      const env = (settings.env ?? {}) as Record<string, unknown>;
      const plugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
      const rest = Object.fromEntries(
        Object.entries(settings).filter(([k]) => k !== 'env' && k !== 'enabledPlugins'),
      );
      if (Object.keys(rest).length) sections.push({ title: '偏好设置', items: flattenSection(rest) });
      if (Object.keys(plugins).length) {
        sections.push({
          title: '插件',
          items: Object.entries(plugins).map(([k, v]) => ({ key: k, value: v === true ? '启用' : '禁用' })),
        });
      }
      if (Object.keys(env).length) sections.push({ title: '环境变量(env)', items: flattenSection(env) });
      notes.push('配置位于 ~/.claude/settings.json(结构化展示,密钥已脱敏)');
    } catch {
      notes.push('未找到 ~/.claude/settings.json');
    }
    try {
      const j = JSON.parse(
        await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'),
      ) as { mcpServers?: Record<string, unknown> };
      const mcp = Object.keys(j.mcpServers ?? {});
      notes.push(mcp.length ? `MCP 服务器:${mcp.length} 个(${mcp.slice(0, 8).join('、')})` : '未配置 MCP 服务器');
    } catch {
      /* 忽略 */
    }
    return { agent: this.agentId, sections, notes };
  }

  // ---- 配置编辑(settings.json 只动目标键,其余保留) ----

  private readonly settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async configSchema(): Promise<ConfigFieldDef[]> {
    const settings = await this.readSettings();
    const env = (settings.env ?? {}) as Record<string, unknown>;
    const root = (k: string): string => (typeof settings[k] === 'string' ? (settings[k] as string) : '');
    const envStr = (k: string): string => (typeof env[k] === 'string' ? (env[k] as string) : '');
    const mk = (key: string, label: string, source: string, opts?: Partial<ConfigFieldDef>): ConfigFieldDef => ({
      key,
      label,
      type: 'string',
      group: '模型接入',
      value: source && isSecretKey(key) ? maskSecret(source) : source,
      ...opts,
    });
    return [
      mk('env.ANTHROPIC_AUTH_TOKEN', '认证令牌', envStr('ANTHROPIC_AUTH_TOKEN'), { secret: true, hint: '留空保持不变' }),
      mk('env.ANTHROPIC_API_KEY', 'API Key', envStr('ANTHROPIC_API_KEY'), { secret: true }),
      mk('env.ANTHROPIC_BASE_URL', 'Base URL', envStr('ANTHROPIC_BASE_URL'), { hint: '如 https://open.bigmodel.cn/api/anthropic' }),
      mk('env.ANTHROPIC_MODEL', '模型', envStr('ANTHROPIC_MODEL')),
      mk('env.ANTHROPIC_DEFAULT_SONNET_MODEL', '默认 Sonnet 模型', envStr('ANTHROPIC_DEFAULT_SONNET_MODEL')),
      mk('env.ANTHROPIC_DEFAULT_OPUS_MODEL', '默认 Opus 模型', envStr('ANTHROPIC_DEFAULT_OPUS_MODEL')),
      mk('env.ANTHROPIC_DEFAULT_HAIKU_MODEL', '默认 Haiku 模型', envStr('ANTHROPIC_DEFAULT_HAIKU_MODEL')),
      mk('model', '默认模型(根键)', root('model')),
    ];
  }

  async getConfigValues(): Promise<Record<string, string>> {
    const settings = await this.readSettings();
    const env = (settings.env ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    const schema = await this.configSchema();
    for (const f of schema) {
      const source = f.key.startsWith('env.')
        ? env[f.key.slice(4)]
        : settings[f.key];
      out[f.key] = typeof source === 'string' ? source : '';
    }
    return out;
  }

  async updateConfig(values: Record<string, string>): Promise<{ applied: string[] }> {
    const settings = await this.readSettings();
    const env = (settings.env ?? {}) as Record<string, unknown>;
    const applied: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('env.')) {
        const name = key.slice(4);
        if (!name) continue;
        env[name] = value;
        applied.push(key);
      } else if (key) {
        settings[key] = value;
        applied.push(key);
      }
    }
    if (Object.keys(env).length) settings.env = env;
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return { applied };
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
