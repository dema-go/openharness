/**
 * TaskManager:经原生 CLI 发射任务、持有进程句柄、跟踪状态。
 * 任务生命周期事件全部进入统一流水线(pipeline)。
 */
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, HarnessEvent, LaunchOptions, TaskHandle, TaskInfo } from '@openharness/core';
import { truncate } from '@openharness/core';
import { broadcast } from './bus.js';

interface ManagedTask {
  info: TaskInfo;
  handle: TaskHandle;
}

const MAX_KEPT = 50;

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();

  constructor(
    private readonly getAdapter: (agent: TaskInfo['agent']) => AgentAdapter | undefined,
    private readonly pipeline: (e: HarnessEvent) => void,
  ) {}

  async start(adapter: AgentAdapter, opts: Omit<LaunchOptions, 'taskId'>): Promise<TaskInfo> {
    const id = randomUUID();
    const info: TaskInfo = {
      id,
      agent: adapter.agentId,
      cwd: opts.cwd,
      prompt: opts.prompt,
      sessionId: null,
      state: 'running',
      startedAt: Date.now(),
    };

    this.pipeline({
      ts: Date.now(),
      agent: adapter.agentId,
      projectDir: opts.cwd,
      sessionId: id,
      kind: 'task-start',
      summary: `发起任务:${truncate(opts.prompt, 120)}`,
      meta: { taskId: id, cwd: opts.cwd },
    });

    const handle = await adapter.launch({ ...opts, taskId: id }, (e) => {
      if (e.meta?.taskId === id) {
        if (e.kind === 'session-start') info.sessionId = e.sessionId;
        if (e.kind === 'task-end') {
          info.state = e.meta?.state === 'done' ? 'done' : 'error';
          info.endedAt = Date.now();
          info.exitCode = (e.meta?.exitCode as number | null) ?? null;
          this.broadcastTask(info);
        }
      }
      this.pipeline(e);
    });

    this.tasks.set(id, { info, handle });
    this.evict();
    this.broadcastTask(info);
    return info;
  }

  async stop(id: string): Promise<TaskInfo | null> {
    const t = this.tasks.get(id);
    if (!t || t.info.state !== 'running') return t?.info ?? null;
    await t.handle.stop();
    if (t.info.state === 'running') {
      t.info.state = 'stopped';
      t.info.endedAt = Date.now();
    }
    this.broadcastTask(t.info);
    return t.info;
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()]
      .map((t) => t.info)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  activeCount(agent: TaskInfo['agent']): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.info.agent === agent && t.info.state === 'running') n++;
    }
    return n;
  }

  private broadcastTask(info: TaskInfo): void {
    broadcast({ type: 'task', data: { ...info } });
  }

  private evict(): void {
    while (this.tasks.size > MAX_KEPT) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.info.startedAt - b.info.startedAt)[0];
      if (oldest && oldest.info.state !== 'running') this.tasks.delete(oldest.info.id);
      else break;
    }
  }
}
