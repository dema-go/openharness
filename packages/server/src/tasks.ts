/**
 * TaskManager:经原生 CLI 发射任务、持有进程句柄、跟踪状态。
 * 支持排队:queue=true 时,若该 Agent 正忙,任务进入 FIFO 队列,
 * 当前任务收尾后自动接续下一个。
 * 任务生命周期事件全部进入统一流水线(pipeline)。
 */
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, HarnessEvent, LaunchOptions, TaskHandle, TaskInfo } from '@openharness/core';
import { AGENT_DISPLAY, truncate } from '@openharness/core';
import { broadcast } from './bus.js';
import { desktopNotify } from './notify.js';
import type { Store } from './store.js';

interface ManagedTask {
  info: TaskInfo;
  adapter: AgentAdapter;
  handle?: TaskHandle;
  requestStop: () => void;
}

const MAX_KEPT = 50;

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly queues = new Map<TaskInfo['agent'], string[]>();
  private readonly notified = new Set<string>();

  constructor(
    private readonly pipeline: (e: HarnessEvent) => void,
    private readonly store?: Store,
    private readonly notify: boolean = true,
  ) {}

  /** 服务启动时恢复历史任务;遗留的 running/queued 归位(中断/清除) */
  async recover(): Promise<void> {
    if (!this.store) return;
    this.store.settleStaleTasks(Date.now());
    for (const t of this.store.loadTasks()) {
      this.tasks.set(t.id, {
        info: t,
        adapter: null as unknown as AgentAdapter,
        requestStop: () => undefined,
      });
    }
    if (this.tasks.size) {
      console.log(`[openharness] 已恢复 ${this.tasks.size} 条任务历史`);
    }
  }

  /** 立即启动(不排队;允许同一 Agent 并发) */
  async start(adapter: AgentAdapter, opts: Omit<LaunchOptions, 'taskId'>): Promise<TaskInfo> {
    const info = this.createInfo(adapter, opts);
    await this.spawn(info, adapter, opts);
    return info;
  }

  /** 排队启动:该 Agent 空闲则立即执行,否则进入 FIFO 队列 */
  async enqueue(adapter: AgentAdapter, opts: Omit<LaunchOptions, 'taskId'>): Promise<TaskInfo> {
    // 注意:必须先探测再建任务,否则新任务(running)会被自己计入
    const busy = this.activeCount(adapter.agentId) > 0;
    const info = this.createInfo(adapter, opts);
    if (busy) {
      info.state = 'queued';
      const q = this.queues.get(adapter.agentId) ?? [];
      q.push(info.id);
      this.queues.set(adapter.agentId, q);
      this.broadcastTask(info);
    } else {
      await this.spawn(info, adapter, opts);
    }
    return info;
  }

  async stop(id: string): Promise<TaskInfo | null> {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.info.state === 'queued') {
      // 出队终止
      const q = this.queues.get(t.info.agent) ?? [];
      this.queues.set(t.info.agent, q.filter((x) => x !== id));
      t.info.state = 'stopped';
      t.info.endedAt = Date.now();
      this.broadcastTask(t.info);
      return t.info;
    }
    if (t.info.state !== 'running') return t.info;
    t.requestStop();
    await t.handle?.stop();
    if (t.info.state === 'running') {
      t.info.state = 'stopped';
      t.info.endedAt = Date.now();
      this.broadcastTask(t.info);
      this.startNextQueued(t.info.agent);
    }
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

  queuedCount(agent: TaskInfo['agent']): number {
    return (this.queues.get(agent) ?? []).length;
  }

  // ---- 内部 ----

  private createInfo(adapter: AgentAdapter, opts: Omit<LaunchOptions, 'taskId'>): TaskInfo {
    const id = randomUUID();
    const info: TaskInfo = {
      id,
      agent: adapter.agentId,
      cwd: opts.cwd,
      // 任务记录展示用户原始输入:对话室注入的[对话背景]/协作约定不得混入
      prompt: opts.displayPrompt ?? opts.prompt,
      sessionId: null,
      state: 'running',
      startedAt: Date.now(),
    };
    const managed: ManagedTask = {
      info,
      adapter,
      requestStop: () => {
        /* spawn 时替换为真实实现 */
      },
    };
    this.tasks.set(id, managed);
    this.evict();
    return info;
  }

  private async spawn(
    info: TaskInfo,
    adapter: AgentAdapter,
    opts: Omit<LaunchOptions, 'taskId'>,
  ): Promise<void> {
    const managed = this.tasks.get(info.id);
    if (!managed) return;
    let stopRequested = false;
    managed.requestStop = () => {
      stopRequested = true;
    };

    this.pipeline({
      ts: Date.now(),
      agent: adapter.agentId,
      projectDir: opts.cwd,
      sessionId: info.id,
      kind: 'task-start',
      summary: `发起任务:${truncate(opts.displayPrompt ?? opts.prompt, 120)}`,
      meta: { taskId: info.id, cwd: opts.cwd, conversationId: opts.conversationId, resumeSessionId: opts.resumeSessionId },
    });
    info.state = 'running';
    info.startedAt = Date.now();
    this.broadcastTask(info);

    const handle = await adapter.launch({ ...opts, taskId: info.id }, (e) => {
      if (e.meta?.taskId === info.id) {
        if (e.kind === 'session-start') info.sessionId = e.sessionId;
        if (e.kind === 'task-end') {
          // 用户主动打断时 exit≠0 也归为 stopped,而非 error
          info.state = stopRequested ? 'stopped' : e.meta?.state === 'done' ? 'done' : 'error';
          info.endedAt = Date.now();
          info.exitCode = (e.meta?.exitCode as number | null) ?? null;
          this.broadcastTask(info);
          this.startNextQueued(info.agent);
        }
      }
      this.pipeline(e);
    });
    managed.handle = handle;
  }

  /** 当前任务收尾后,自动接续该 Agent 队列中的下一个 */
  private startNextQueued(agent: TaskInfo['agent']): void {
    if (this.activeCount(agent) > 0) return; // 该 Agent 还有并发任务在跑,等最后一个收尾
    const q = this.queues.get(agent) ?? [];
    const nextId = q.shift();
    if (!nextId) return;
    const t = this.tasks.get(nextId);
    if (!t || t.info.state !== 'queued') return this.startNextQueued(agent);
    void this.spawn(t.info, t.adapter, { cwd: t.info.cwd, prompt: t.info.prompt });
  }

  private broadcastTask(info: TaskInfo): void {
    this.store?.upsertTask(info);
    broadcast({ type: 'task', data: { ...info } });
    // 桌面通知:任务收尾且尚未通知过
    if (
      this.notify &&
      !this.notified.has(info.id) &&
      info.endedAt &&
      (info.state === 'done' || info.state === 'error' || info.state === 'stopped')
    ) {
      this.notified.add(info.id);
      const label = info.state === 'done' ? '任务完成' : info.state === 'stopped' ? '任务已打断' : '任务失败';
      desktopNotify(`${label} · ${AGENT_DISPLAY[info.agent]}`, info.prompt);
    }
  }

  private evict(): void {
    while (this.tasks.size > MAX_KEPT) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.info.startedAt - b.info.startedAt)[0];
      if (oldest && oldest.info.state !== 'running' && oldest.info.state !== 'queued') {
        this.tasks.delete(oldest.info.id);
      } else break;
    }
  }
}
