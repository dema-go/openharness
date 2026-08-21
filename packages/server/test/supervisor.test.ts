/**
 * Supervisor 编排层全链路单测:MockProvider 脚本化 LLM + 内存桩 Store/Tasks,
 * 覆盖 规划→门禁→派发→验收→重试→反思→重规划→收尾 与 边界(预算/轮次/中止)。
 * CI 无需 API Key。
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  HarnessEvent,
  LaunchOptions,
  SupervisorRunRecord,
  SupervisorStepRecord,
  TaskInfo,
} from '@openharness/core';
import { broadcast } from '../src/bus.js';
import { MockProvider, textResponse, toolCallResponse, type ScriptedResponse } from '../src/supervisor/mock-provider.js';
import { SupervisorManager } from '../src/supervisor/manager.js';
import { OpenAICompatibleProvider } from '../src/supervisor/provider.js';
import { findTool, validateArgs, executeTool, type ToolContext } from '../src/supervisor/tools.js';
import { SupervisorConfigStore } from '../src/supervisor/config.js';
import type { LlmProvider } from '../src/supervisor/provider.js';

// ---- 内存桩 ----

class FakeStore {
  runs = new Map<string, SupervisorRunRecord>();
  steps = new Map<string, SupervisorStepRecord[]>();
  upsertSupervisorRun(r: SupervisorRunRecord): void {
    this.runs.set(r.id, { ...r, plan: r.plan ? { ...r.plan } : null });
  }
  getSupervisorRun(id: string): SupervisorRunRecord | undefined {
    const r = this.runs.get(id);
    return r ? { ...r } : undefined;
  }
  listSupervisorRuns(limit = 50): SupervisorRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((r) => ({ ...r }));
  }
  upsertSupervisorStep(s: SupervisorStepRecord): void {
    const list = this.steps.get(s.runId) ?? [];
    const i = list.findIndex((x) => x.stepId === s.stepId);
    if (i >= 0) list[i] = { ...s };
    else list.push({ ...s });
    this.steps.set(s.runId, list);
  }
  listSupervisorSteps(runId: string): SupervisorStepRecord[] {
    return (this.steps.get(runId) ?? []).map((s) => ({ ...s }));
  }
}

class FakeTasks {
  launched: Array<{ agent: string; opts: LaunchOptions }> = [];
  infos: TaskInfo[] = [];
  stopped: string[] = [];
  /** 任务收尾策略:按序消费;耗尽后默认 done */
  outcomes: Array<'done' | 'error'> = [];
  /** true = 任务永不收尾(测中止/超时) */
  hold = false;
  output = '已完成全部工作,产出报告如下。';
  async start(adapter: { agentId: string }, opts: LaunchOptions): Promise<TaskInfo> {
    const agent = adapter.agentId;
    this.launched.push({ agent, opts });
    const info: TaskInfo = {
      id: `t${this.launched.length}`,
      agent: agent as TaskInfo['agent'],
      cwd: opts.cwd,
      prompt: opts.prompt,
      sessionId: null,
      state: 'running',
      startedAt: Date.now(),
    };
    this.infos.push(info);
    if (this.hold) return info;
    // 模拟真实链路:assistant 产出 + 任务收尾均经总线广播
    setTimeout(() => {
      broadcast({
        type: 'event',
        data: {
          ts: Date.now(),
          agent: info.agent,
          projectDir: opts.cwd,
          sessionId: 'sess',
          kind: 'assistant-message',
          summary: '产出',
          meta: { taskId: info.id, fullText: this.output },
        } satisfies HarnessEvent,
      });
      const outcome = this.outcomes.shift() ?? 'done';
      broadcast({
        type: 'task',
        data: { ...info, state: outcome, endedAt: Date.now(), exitCode: outcome === 'done' ? 0 : 1 },
      });
    }, 5);
    return info;
  }
  async stop(id: string): Promise<TaskInfo | null> {
    const t = this.infos.find((x) => x.id === id);
    if (!t) return null;
    this.stopped.push(id);
    broadcast({ type: 'task', data: { ...t, state: 'stopped', endedAt: Date.now() } });
    return t;
  }
}

function makeManager(
  script: ScriptedResponse[],
  opts: { limits?: Record<string, number>; taskOutcomes?: Array<'done' | 'error'>; taskOutput?: string; holdTasks?: boolean } = {},
) {
  const provider = new MockProvider(script);
  const store = new FakeStore();
  const tasks = new FakeTasks();
  if (opts.taskOutcomes) tasks.outcomes = [...opts.taskOutcomes];
  if (opts.taskOutput) tasks.output = opts.taskOutput;
  if (opts.holdTasks) tasks.hold = true;
  const memory = { read: () => '', append: () => undefined };
  const roles = { inject: (_a: string, p: string) => p };
  const events: HarnessEvent[] = [];
  const mgr = new SupervisorManager({
    store,
    createProvider: () => provider as LlmProvider,
    getAdapter: (a) => ({ agentId: a }) as AgentAdapter,
    tasks: tasks as never,
    memory,
    roles: roles as never,
    emitEvent: (e) => events.push(e),
    limits: opts.limits,
  });
  return { mgr, provider, store, tasks, events };
}

/** 轮询等待 run 到达终态 */
async function waitFor(mgr: SupervisorManager, id: string, timeoutMs = 3000): Promise<SupervisorRunRecord> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = mgr.get(id)?.run;
    if (r && ['done', 'failed', 'stopped'].includes(r.state)) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('等待 run 终态超时');
}

const planStep = { title: '第一步', agent: 'claude', prompt: '做某事', acceptanceCheck: '产出包含完成说明', autoCheck: false };
const planStep2 = { title: '第二步', agent: 'dsh', prompt: '复盘', acceptanceCheck: '', autoCheck: true };

describe('SupervisorManager 全链路', () => {
  it('hitl:计划 → 审批 → 派发 → 验收 → 报告', async () => {
    const { mgr, store, tasks, events } = makeManager([
      toolCallResponse('submit_plan', { steps: [planStep, planStep2] }),
      toolCallResponse('submit_verdict', { pass: true, reason: '产出符合标准' }),
      textResponse('## 结果摘要\n全部完成。'),
    ]);
    const run = await mgr.start({ goal: '完成 A', cwd: '/tmp', mode: 'hitl' });
    expect(run.state).toBe('planning');

    // 等到门禁
    await new Promise((res) => setTimeout(res, 30));
    const gated = mgr.get(run.id)!.run;
    expect(gated.state).toBe('awaiting_approval');
    expect(gated.plan?.steps).toHaveLength(2);
    expect(events.map((e) => e.kind)).toContain('plan-created');
    expect(events.map((e) => e.kind)).toContain('gate-waiting');
    expect(tasks.launched).toHaveLength(0); // 未批准不派发

    await mgr.approve(run.id, 'approve');
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    expect(final.report).toContain('结果摘要');
    // 第一步 LLM 验收,第二步 autoCheck;各派发一次
    expect(tasks.launched.map((l) => l.agent)).toEqual(['claude', 'dsh']);
    const steps = store.listSupervisorSteps(run.id);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done']);
    expect(steps[0].verifyResult).toBe('pass');
    expect(steps[1].verifyResult).toBe('pass'); // autoCheck: done 状态
    expect(events.map((e) => e.kind)).toContain('verify-passed');
    expect(events.map((e) => e.kind)).toContain('run-finalized');
  });

  it('hitl:拒绝计划 → failed', async () => {
    const { mgr } = makeManager([toolCallResponse('submit_plan', { steps: [planStep] })]);
    const run = await mgr.start({ goal: '完成 B', cwd: '/tmp', mode: 'hitl' });
    await new Promise((res) => setTimeout(res, 30));
    await mgr.approve(run.id, 'reject');
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('failed');
    expect(final.error).toContain('拒绝');
  });

  it('hitl:带修订批准 → goal 与计划同步更新并按修订执行', async () => {
    const { mgr, store, tasks } = makeManager([
      toolCallResponse('submit_plan', { steps: [planStep] }),
      // 修订步骤 autoCheck:true → 不消耗验收调用,此处直接是收尾报告
      textResponse('## 结果摘要\n按修订计划完成。'),
    ]);
    const run = await mgr.start({ goal: '完成原始目标', cwd: '/tmp', mode: 'hitl' });
    await new Promise((res) => setTimeout(res, 30));

    const revised = {
      goal: '完成修订目标',
      steps: [
        {
          id: 's1',
          title: '修订后的步骤',
          agent: 'codex' as const,
          prompt: '修订后的执行内容',
          acceptanceCheck: '修订验收标准',
          autoCheck: true,
        },
      ],
    };
    await mgr.approve(run.id, 'approve', revised);
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    // 回归断言:goal 与 plan 均为修订版(曾出现 goal 停留旧值导致报告口径错位)
    expect(final.goal).toBe('完成修订目标');
    expect(final.plan?.steps[0].title).toBe('修订后的步骤');
    expect(tasks.launched[0].agent).toBe('codex');
    expect(tasks.launched[0].opts.prompt).toContain('修订后的执行内容');
    // 持久化层同步
    expect(store.getSupervisorRun(run.id)?.goal).toBe('完成修订目标');
  });

  it('bypassPermissions:run 级开关透传到 Worker 派发', async () => {
    const { mgr, tasks } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: true }] }),
      textResponse('报告'),
    ]);
    const run = await mgr.start({ goal: '完成自主', cwd: '/tmp', mode: 'auto', bypassPermissions: true });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    expect(final.bypassPermissions).toBe(true);
    expect(tasks.launched[0].opts.bypassPermissions).toBe(true);

    // 默认关:不透传
    const { mgr: mgr2, tasks: tasks2 } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: true }] }),
      textResponse('报告'),
    ]);
    const run2 = await mgr2.start({ goal: '完成保守', cwd: '/tmp', mode: 'auto' });
    const final2 = await waitFor(mgr2, run2.id);
    expect(final2.state).toBe('done');
    expect(final2.bypassPermissions).toBe(false);
    expect(tasks2.launched[0].opts.bypassPermissions).toBe(false);
  });

  it('auto 模式:跳过门禁直接执行', async () => {
    const { mgr, tasks } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: true }] }),
      textResponse('报告'),
    ]);
    const run = await mgr.start({ goal: '完成 C', cwd: '/tmp', mode: 'auto' });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    expect(tasks.launched).toHaveLength(1);
  });

  it('验收失败 → 自动重试(带失败反馈)→ 第二次通过', async () => {
    const { mgr, tasks, store } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: false }] }),
      toolCallResponse('submit_verdict', { pass: false, reason: '缺少测试说明' }),
      toolCallResponse('submit_verdict', { pass: true, reason: '补齐了' }),
      textResponse('报告'),
    ]);
    const run = await mgr.start({ goal: '完成 D', cwd: '/tmp', mode: 'auto' });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    expect(tasks.launched).toHaveLength(2); // 重试一次
    // 重试 prompt 携带失败反馈
    expect(tasks.launched[1]!.opts.prompt).toContain('上次尝试未通过验收');
    expect(tasks.launched[1]!.opts.prompt).toContain('缺少测试说明');
    expect(store.listSupervisorSteps(run.id)[0]!.attempt).toBe(2);
  });

  it('重试耗尽 → 反思决定 replan → 新计划再执行', async () => {
    const { mgr, tasks, store } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: false }] }),
      toolCallResponse('submit_verdict', { pass: false, reason: '始终失败-1' }),
      toolCallResponse('submit_verdict', { pass: false, reason: '始终失败-2' }),
      toolCallResponse('submit_verdict', { pass: false, reason: '始终失败-3' }),
      toolCallResponse('decide_next', { action: 'replan', reason: '换 Worker 重来' }),
      // 重规划(带背景上下文)→ 新计划
      toolCallResponse('submit_plan', { steps: [{ ...planStep, agent: 'codex', title: '换人重做' }] }),
      toolCallResponse('submit_verdict', { pass: true, reason: '这次好了' }),
      textResponse('最终报告'),
    ]);
    const run = await mgr.start({ goal: '完成 E', cwd: '/tmp', mode: 'auto', });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('done');
    expect(tasks.launched.map((l) => l.agent)).toEqual(['claude', 'claude', 'claude', 'codex']);
    const steps = store.listSupervisorSteps(run.id);
    expect(steps.map((s) => s.stepId)).toEqual(['s1', 'r2-s1']); // 重规划轮次前缀
    expect(steps[0]!.state).toBe('failed');
    expect(steps[1]!.state).toBe('done');
  });

  it('反思决定 abort → failed', async () => {
    const { mgr } = makeManager([
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: false }] }),
      toolCallResponse('submit_verdict', { pass: false, reason: '不行-1' }),
      toolCallResponse('submit_verdict', { pass: false, reason: '不行-2' }),
      toolCallResponse('submit_verdict', { pass: false, reason: '不行-3' }),
      toolCallResponse('decide_next', { action: 'abort', reason: '目标不可达' }),
    ]);
    const run = await mgr.start({ goal: '完成 F', cwd: '/tmp', mode: 'auto' });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('failed');
    expect(final.error).toContain('放弃');
  });

  it('Token 预算耗尽 → failed', async () => {
    const big = { text: null as unknown as string, toolCalls: [], usage: { input: 900_000, output: 1 }, stopReason: 'end' as const };
    const { mgr } = makeManager([
      { ...big },
    ]);
    const run = await mgr.start({ goal: '完成 G', cwd: '/tmp', mode: 'auto' });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('failed');
    expect(final.error).toContain('Token 预算');
  });

  it('规划不产出计划(脚本耗尽)→ failed', async () => {
    const { mgr } = makeManager([textResponse('我觉得这事不用计划')]);
    const run = await mgr.start({ goal: '完成 H', cwd: '/tmp', mode: 'auto' });
    const final = await waitFor(mgr, run.id);
    expect(final.state).toBe('failed');
  });

  it('stop():执行中中止 → stopped,Worker 任务被打断', async () => {
    const { mgr, tasks } = makeManager(
      [
        toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: true }] }),
        textResponse('报告'),
      ],
      { holdTasks: true },
    );
    const run = await mgr.start({ goal: '完成 I', cwd: '/tmp', mode: 'auto' });
    await new Promise((res) => setTimeout(res, 20)); // 已进入执行、任务挂着
    expect(mgr.get(run.id)!.run.state).toBe('executing');
    const final = await mgr.stop(run.id);
    expect(final?.state).toBe('stopped');
    expect(tasks.stopped).toHaveLength(1); // Worker 任务被 stop
  });

  it('stop():规划阶段中止 → stopped(不进入门禁挂起)', async () => {
    const { mgr, store } = makeManager([toolCallResponse('submit_plan', { steps: [planStep] })]);
    const run = await mgr.start({ goal: '完成 K', cwd: '/tmp', mode: 'hitl' });
    // 立刻中止:planPhase 尚未完成,无 gate、非 executing
    const final = await mgr.stop(run.id);
    expect(final?.state).toBe('stopped');
    // 回归断言:run 不得停留在 awaiting_approval 挂起等审批
    const settled = store.getSupervisorRun(run.id)!;
    expect(['stopped', 'failed', 'done']).toContain(settled.state);
    expect(settled.state).not.toBe('awaiting_approval');
  });

  it('规划前可调用 context 工具(query_events/memory_read)', async () => {
    const { mgr, provider } = makeManager([
      toolCallResponse('memory_read', {}),
      toolCallResponse('submit_plan', { steps: [{ ...planStep, autoCheck: true }] }),
      textResponse('报告'),
    ]);
    await mgr.start({ goal: '完成 J', cwd: '/tmp', mode: 'auto' });
    await new Promise((res) => setTimeout(res, 100));
    // 第一轮请求带上下文工具;memory_read 结果以 tool 消息回填
    const first = provider.calls[0]!;
    expect(first.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['query_events', 'memory_read', 'submit_plan']),
    );
    const second = provider.calls[1]!;
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('Supervisor 恢复', () => {
  it('recover():executing 归 stopped;awaiting_approval 重建可审批', async () => {
    const store = new FakeStore();
    // 一条重启遗留的 executing run 与一条门禁挂起的 run
    store.upsertSupervisorRun({
      id: 'run-exec', goal: 'X', cwd: '/tmp', mode: 'auto', state: 'executing',
      plan: null, report: null, error: null, usage: { input: 0, output: 0 }, createdAt: Date.now(), endedAt: null,
    });
    store.upsertSupervisorRun({
      id: 'run-gate', goal: 'Y', cwd: '/tmp', mode: 'hitl', state: 'awaiting_approval',
      plan: { goal: 'Y', steps: [{ id: 's1', ...planStep }] }, report: null, error: null,
      usage: { input: 0, output: 0 }, createdAt: Date.now(), endedAt: null,
    });
    const provider = new MockProvider([
      toolCallResponse('submit_verdict', { pass: true, reason: 'ok' }),
      textResponse('恢复后的报告'),
    ]);
    const mgr = new SupervisorManager({
      store,
      createProvider: () => provider,
      getAdapter: (a) => ({ agentId: a }) as AgentAdapter,
      tasks: new FakeTasks() as never,
      memory: { read: () => '', append: () => undefined },
      roles: { inject: (_a: string, p: string) => p } as never,
      emitEvent: () => undefined,
    });
    mgr.recover();
    expect(store.getSupervisorRun('run-exec')!.state).toBe('stopped');
    // 挂起 run 审批后续跑至终态
    await mgr.approve('run-gate', 'approve');
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const r = store.getSupervisorRun('run-gate');
      if (r && r.state === 'done') break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(store.getSupervisorRun('run-gate')!.state).toBe('done');
    expect(store.getSupervisorRun('run-gate')!.report).toContain('恢复后的报告');
  });
});

describe('工具注册表', () => {
  const ctx: ToolContext = {
    runId: 'r',
    cwd: '/tmp',
    launchAndWait: async () => ({ taskId: 't1', state: 'done', exitCode: 0, output: '产出' }),
    queryEvents: () => [],
    memory: { read: () => '', append: () => undefined },
  };

  it('validateArgs:必填缺失/类型错误/非法枚举', () => {
    const dispatch = findTool('dispatch_task')!;
    expect(validateArgs(dispatch, { prompt: 'x' })).toContain('缺失');
    expect(validateArgs(dispatch, { agent: 'claude', prompt: 123 })).toContain('类型错误');
    expect(validateArgs(dispatch, { agent: 'supervisor', prompt: 'x' })).toContain('取值');
    expect(validateArgs(dispatch, { agent: 'claude', prompt: 'x' })).toBeNull();
  });

  it('executeTool:未知工具与非法入参返回 error(不 throw),模型可自纠', async () => {
    const r1 = await executeTool('nope', {}, ctx);
    expect(r1.ok).toBe(false);
    expect(r1.output).toContain('未知工具');
    const r2 = await executeTool('dispatch_task', { agent: 'bad' }, ctx);
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain('入参校验失败');
  });

  it('dispatch_task:done → ok;error → 不 ok,输出含状态与产出', async () => {
    const failCtx: ToolContext = { ...ctx, launchAndWait: async () => ({ taskId: 't2', state: 'error', exitCode: 1, output: '炸了' }) };
    const ok = await executeTool('dispatch_task', { agent: 'claude', prompt: 'p' }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('state=done');
    const fail = await executeTool('dispatch_task', { agent: 'claude', prompt: 'p' }, failCtx);
    expect(fail.ok).toBe(false);
    expect(fail.output).toContain('state=error');
    expect(fail.output).toContain('炸了');
  });

  it('memory_write + memory_read 闭环', async () => {
    const mem: string[] = [];
    const mctx: ToolContext = { ...ctx, memory: { read: () => mem.join('\n'), append: (t) => mem.push(t) } };
    await executeTool('memory_write', { text: '经验:先读文档' }, mctx);
    const r = await executeTool('memory_read', {}, mctx);
    expect(r.output).toContain('经验:先读文档');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('请求体形状(system/tools/tool 回填)与响应解析(tool_calls)', async () => {
    const origFetch = globalThis.fetch;
    let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'submit_plan', arguments: '{"steps":[{"title":"a"}]}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-test', model: 'deepseek-chat' });
      const res = await p.complete({
        system: 'S',
        messages: [
          { role: 'user', content: 'U' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'query_events', args: { q: 'x' } }] },
          { role: 'tool', toolCallId: 'c1', content: '结果' },
        ],
        tools: [{ type: 'function', function: { name: 'submit_plan', description: 'd', parameters: { type: 'object' } } }],
      });
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0]!.name).toBe('submit_plan');
      expect(res.toolCalls[0]!.args.steps).toEqual([{ title: 'a' }]);
      expect(res.stopReason).toBe('tool_use');
      expect(res.usage).toEqual({ input: 11, output: 7 });
      expect(captured!.url).toBe('https://api.deepseek.com/v1/chat/completions'); // 尾斜杠归一
      expect(captured!.headers.authorization).toBe('Bearer sk-test');
      const body = captured!.body as { messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
      // wire 顺序:system 前置 → user / assistant(tool_calls) / tool 回填
      expect(body.messages[0]).toEqual({ role: 'system', content: 'S' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'U' });
      expect(body.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'query_events' } }] });
      expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' }); // 原生 tool 协议
      expect(body.tools[0]).toMatchObject({ type: 'function' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('非 200 抛错并带状态码与响应体摘录', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"bad key"}', { status: 401 })) as typeof fetch;
    try {
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
      await expect(p.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] })).rejects.toThrow('401');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('SupervisorConfigStore', () => {
  it('密钥零片段:getPublic 不回传 apiKey,update 空密钥不改', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'supcfg-'));
    try {
      const file = path.join(dir, 'supervisor.json');
      const cfg = new SupervisorConfigStore(file);
      expect(cfg.getPublic().configured).toBe(false);
      cfg.update({ apiKey: 'sk-secret-value-123', model: 'deepseek-chat' });
      const pub = cfg.getPublic();
      expect(pub.hasApiKey).toBe(true);
      expect(pub.configured).toBe(true);
      expect(JSON.stringify(pub)).not.toContain('sk-secret');
      // 空密钥不改
      cfg.update({ apiKey: '' });
      expect(cfg.resolved()!.apiKey).toBe('sk-secret-value-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
