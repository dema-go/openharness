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
import { entry, patchYamlFlat, patchYamlIndent } from '../config-utils.js';
import { listSessionFiles, parseSessionFile, type ParseResult } from './session-file.js';

export const DSH_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

export class DshAdapter implements AgentAdapter {
  readonly agentId = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness';
  readonly enabled = true;

  private readonly offsets = new Map<string, number>();
  /** 本适配器发射任务的进程组 id:probe 时排除,避免任务收尾残留进程导致状态卡长期 RUN */
  private readonly taskGroups = new Set<number>();

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
        // 已消费完的文件跳过汇总:否则空解析把库里汇总覆盖成 messageCount=0
        if (start > 0 && r.messageCount === 0 && r.offset <= start) continue;
        handlers.onSummary(this.toSummary(r));
      } catch {
        // 跳过损坏文件
      }
    }
  }

  async watch(onEvent: (e: HarnessEvent) => void): Promise<() => Promise<void>> {
    // 注意:chokidar v4 对绝对路径 + glob 的 watch 不触发,必须监听根目录、
    // 在处理器里按扩展名过滤
    const watcher: FSWatcher = chokidar.watch(DSH_SESSIONS_ROOT, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    });

    let busy = false;
    const consume = async (filePath: string) => {
      if (busy || !filePath.endsWith('.zstd')) return;
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
    // 注意:dsh headless 不接受 --resume(仅 tui 支持),续接上下文由
    // ConversationManager 注入摘要完成。
    // bypassPermissions(dsh 无对应 CLI 开关):权限由 ~/.dsh/settings.yaml 的
    // permission.defaultPreset 控制,设置 danger-full-access 即为完全自主。
    const child = spawn('dsh', ['--profile', 'headless', opts.prompt], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) this.taskGroups.add(child.pid);
    const id = opts.taskId;
    let settled = false;
    let outBuf = '';
    let errTail = '';

    const settle = (exitCode: number | null, state: 'done' | 'error') => {
      if (settled) return;
      settled = true;
      // 任务收尾后清理残留进程组:CLI 退出但孙进程(agent loop)可能滞留,
      // 10 秒宽限后仍未退出则 SIGKILL 整组,防止状态卡长期误报 RUN
      const pgid = child.pid;
      if (pgid) {
        setTimeout(() => {
          try {
            process.kill(-pgid, 0);
            process.kill(-pgid, 'SIGKILL');
          } catch {
            /* 已退出 */
          }
          this.taskGroups.delete(pgid);
        }, 10_000).unref();
      }
      const final = outBuf.trim();
      if (final) {
        onEvent({
          ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
          kind: 'assistant-message', summary: truncate(final, 400),
          meta: { taskId: id, conversationId: opts.conversationId, fullText: final },
        });
      }
      onEvent({
        ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
        kind: 'task-end',
        summary: state === 'done' ? '任务完成' : `任务异常退出${errTail ? ':' + truncate(errTail, 160) : ''}`,
        meta: { taskId: id, conversationId: opts.conversationId, exitCode, state },
      });
    };

    child.on('error', (err) => {
      onEvent({
        ts: Date.now(), agent: 'dsh', projectDir: opts.cwd, sessionId: id,
        kind: 'error', summary: `启动失败:${err.message}`, meta: { taskId: id, conversationId: opts.conversationId },
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

  /** 探测 DSH 任务进程;排除常驻的 `dsh web` 与本适配器任务的残留进程组。 */
  async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-fl', 'dsh'], (err, stdout) => {
        if (err) return resolve(false);
        // 本适配器任务组的成员(残留中)→ 不算"原生使用"
        const aliveGroups = [...this.taskGroups].filter((g) => {
          try {
            process.kill(-g, 0);
            return true;
          } catch {
            return false;
          }
        });
        const lines = (stdout ?? '').split('\n').filter((l) => l.trim());
        // 只在"可执行位置"匹配:命令里出现 /dsh 或 dsh 作为独立词(如 bin/dsh --profile、
        // dsh --profile tui);排除 JSON 字符串、文件路径等字符串污染
        const candidates = lines.filter(
          (l) => !/\bdsh web\b/.test(l) && /(?:^|\s|\/)dsh(?:\s|$)/.test(l),
        );
        if (candidates.length === 0) return resolve(false);
        if (aliveGroups.length === 0) return resolve(true);
        // 逐行取 pgid,判断是否全部属于自家残留进程组
        let pending = candidates.length;
        let external = false;
        for (const line of candidates) {
          const pid = Number((line.match(/^\s*(\d+)/) ?? [])[1]);
          if (!Number.isFinite(pid) || pid <= 0) {
            if (--pending === 0) resolve(external);
            continue;
          }
          execFile('ps', ['-o', 'pgid=', '-p', String(pid)], (err2, out) => {
            const pgid = Number((out ?? '').trim().split(/\s+/)[0]);
            if (!aliveGroups.includes(pgid)) external = true;
            if (--pending === 0) resolve(external);
          });
        }
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
      const preset = yamlGet(yaml, 'permission', 'defaultPreset');
      if (preset) sections.push({ title: '权限', items: [{ key: 'defaultPreset', value: preset }] });
      const modelItems = [
        ...(yamlGet(yaml, 'agent-default-model', 'provider') ? [entry('provider', yamlGet(yaml, 'agent-default-model', 'provider')!)] : []),
        ...(yamlGet(yaml, 'agent-default-model', 'model') ? [entry('model', yamlGet(yaml, 'agent-default-model', 'model')!)] : []),
        ...(yamlGet(yaml, 'agent-default-model', 'reasoningEffort') ? [entry('reasoningEffort', yamlGet(yaml, 'agent-default-model', 'reasoningEffort')!)] : []),
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

  // ---- 配置编辑(settings.yaml / .credentials.yaml 逐行补丁) ----

  private readonly settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml');
  private readonly credentialsPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');

  private async readFileSafe(p: string): Promise<string> {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return '';
    }
  }

  async configSchema(): Promise<ConfigFieldDef[]> {
    const settingsYaml = await this.readFileSafe(this.settingsPath);
    const credYaml = await this.readFileSafe(this.credentialsPath);
    const settings = (k: string): string => {
      const [section, key] = k.split('.');
      return yamlGet(settingsYaml, section!, key!) ?? '';
    };
    const cred = (k: string): string => {
      for (const line of credYaml.split('\n')) {
        const m = line.match(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`));
        if (m) return m[1]!.trim().replace(/^"|"$/g, '');
      }
      return '';
    };
    const mk = (key: string, label: string, value: string, opts?: Partial<ConfigFieldDef>): ConfigFieldDef => ({
      key,
      label,
      type: 'string',
      group: '默认模型',
      // 密钥字段绝不回传任何值片段
      value: opts?.secret ? '' : value,
      ...(opts?.secret ? { hasValue: value !== '', secret: true } : {}),
      ...opts,
    });
    return [
      mk('agent-default-model.provider', 'Provider', settings('agent-default-model.provider'), {
        hint: 'settings.yaml 中 llm-pi-ai.providers 下注册的 id',
      }),
      mk('agent-default-model.model', '模型', settings('agent-default-model.model')),
      mk('agent-default-model.reasoningEffort', '推理强度', settings('agent-default-model.reasoningEffort'), {
        type: 'select',
        options: ['minimal', 'low', 'medium', 'high', 'max'],
      }),
      mk('permission.defaultPreset', '默认权限', settings('permission.defaultPreset'), {
        type: 'select',
        options: ['read-only', 'workspace-write', 'danger-full-access'],
        group: '权限',
      }),
      mk('cred.DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', cred('DEEPSEEK_API_KEY'), { secret: true, group: '凭据' }),
      mk('cred.ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_API_KEY', cred('ZAI_CODING_CN_API_KEY'), { secret: true, group: '凭据' }),
    ];
  }

  async getConfigValues(): Promise<Record<string, string>> {
    const settingsYaml = await this.readFileSafe(this.settingsPath);
    const credYaml = await this.readFileSafe(this.credentialsPath);
    const out: Record<string, string> = {};
    const schema = await this.configSchema();
    for (const f of schema) {
      if (f.key.startsWith('cred.')) {
        const name = f.key.slice(5);
        for (const line of credYaml.split('\n')) {
          const m = line.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`));
          if (m) {
            out[f.key] = m[1]!.trim().replace(/^"|"$/g, '');
            break;
          }
        }
        if (!(f.key in out)) out[f.key] = '';
      } else {
        const [section, key] = f.key.split('.');
        out[f.key] = yamlGet(settingsYaml, section!, key!) ?? '';
      }
    }
    return out;
  }

  async updateConfig(values: Record<string, string>): Promise<{ applied: string[] }> {
    const settingsUpdates: Array<{ section: string | null; key: string; value: string }> = [];
    const credUpdates: Array<{ key: string; value: string }> = [];
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('cred.')) {
        credUpdates.push({ key: key.slice(5), value });
      } else if (key.includes('.')) {
        const [section, k] = key.split('.');
        settingsUpdates.push({ section: section!, key: k!, value });
      }
    }
    const applied: string[] = [];
    if (settingsUpdates.length) {
      const content = await this.readFileSafe(this.settingsPath);
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      await fs.writeFile(this.settingsPath, patchYamlIndent(content, settingsUpdates), 'utf8');
      applied.push(...settingsUpdates.map((u) => `${u.section}.${u.key}`));
    }
    if (credUpdates.length) {
      const content = await this.readFileSafe(this.credentialsPath);
      await fs.mkdir(path.dirname(this.credentialsPath), { recursive: true });
      await fs.writeFile(this.credentialsPath, patchYamlFlat(content, credUpdates), 'utf8');
      applied.push(...credUpdates.map((u) => `cred.${u.key}`));
    }
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

/** 缩进式 YAML:读取 section 下的单行标量键(不存在返回 null) */
function yamlGet(content: string, section: string, key: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${section}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    const m = line.match(new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`));
    if (m) return m[1]!.trim().replace(/^"|"$/g, '');
  }
  return null;
}
