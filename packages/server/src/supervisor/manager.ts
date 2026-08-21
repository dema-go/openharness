/**
 * SupervisorManager:平台自身的 Agent 循环(编排层核心)。
 *
 * 循环:planning(LLM 结构化规划,可先调 context 工具)
 *   → [hitl] awaiting_approval(人在环门禁,挂起可跨重启恢复)
 *   → executing(dispatch_task 派发 Worker,自动重试带失败反馈)
 *   → verifying(LLM 按 acceptanceCheck 验收;autoCheck 只看任务状态)
 *   → reflecting(重试耗尽后决定 replan / abort)
 *   → finalizing(LLM 汇总报告)
 *
 * 硬边界(代码层强制,不依赖 prompt 自觉):轮次/单步重试/重规划/Token 预算/步骤超时。
 * 全程事件化:plan-created / gate-waiting / verify-passed / verify-failed / replan /
 * run-finalized 进统一活动流,run/step 状态经 WS 实时推送。
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentId,
  HarnessEvent,
  PlanStep,
  SupervisorPlan,
  SupervisorRunRecord,
  SupervisorStepRecord,
  TaskInfo,
} from '@openharness/core';
import { AGENT_DISPLAY, WORKER_AGENT_IDS, truncate } from '@openharness/core';
import { broadcast, onMessage } from '../bus.js';
import { executeTool, toolSchemas, type ToolContext } from './tools.js';
import type { LlmMessage, LlmProvider, LlmResponse } from './provider.js';

export interface SupervisorLimits {
  maxSteps: number;
  maxToolTurns: number;
  maxRetriesPerStep: number;
  maxReplans: number;
  tokenBudget: number;
  stepTimeoutMs: number;
  maxParallel: number;
}

export const DEFAULT_LIMITS: SupervisorLimits = {
  maxSteps: 8,
  maxToolTurns: 40,
  maxRetriesPerStep: 2,
  maxReplans: 2,
  tokenBudget: 200_000,
  stepTimeoutMs: 30 * 60_000,
  maxParallel: 2,
};

/** manager 依赖的 Store 子集(生产 Store / 测试桩同构) */
export interface SupervisorStore {
  upsertSupervisorRun(r: SupervisorRunRecord): void;
  getSupervisorRun(id: string): SupervisorRunRecord | undefined;
  listSupervisorRuns(limit?: number): SupervisorRunRecord[];
  upsertSupervisorStep(s: SupervisorStepRecord): void;
  listSupervisorSteps(runId: string): SupervisorStepRecord[];
  /** 观察面查询(与 /api/events 同一数据面;测试桩可缺省) */
  events?(opts: { agent?: string; kinds?: string[]; q?: string; limit?: number }): HarnessEvent[];
}

/** manager 依赖的 TaskManager 子集 */
export interface SupervisorTasks {
  start(adapter: AgentAdapter, opts: {
    cwd: string;
    prompt: string;
    displayPrompt?: string;
    bypassPermissions?: boolean;
  }): Promise<TaskInfo>;
  stop(id: string): Promise<TaskInfo | null>;
}

export interface SupervisorDeps {
  store: SupervisorStore;
  /** 发起/恢复时解析 Provider;未配置返回 null */
  createProvider(): LlmProvider | null;
  getAdapter(agent: AgentId): AgentAdapter | undefined;
  tasks: SupervisorTasks;
  memory: { read(): string; append(text: string): void };
  /** 角色卡注入(与发射台/对话室同一条链) */
  roles: { inject(agent: AgentId, prompt: string): string };
  /** 事件出口 = 服务端统一流水线(入库 + 广播) */
  emitEvent(e: HarnessEvent): void;
  limits?: Partial<SupervisorLimits>;
}

interface ActiveRun {
  record: SupervisorRunRecord;
  steps: SupervisorStepRecord[];
  /** 计划落库轮次:第 1 轮 stepId 为 sN,重规划轮为 rK-sN(防冲突) */
  round: number;
  /** 人在环门禁:awaiting_approval 时挂起的决议(重启恢复的 run 无 gate,审批走续跑路径) */
  gate?: { resolve: (d: GateDecision) => void };
  /** stop() 请求:循环各 await 点检查后退出 */
  stopRequested?: string;
  currentTaskId?: string;
}

type GateDecision = { type: 'approve'; plan?: SupervisorPlan } | { type: 'reject' };

/** 执行阶段控制流结果 */
type Flow = 'done' | 'failed' | 'stopped' | 'replan';

class RunFailure extends Error {}

const PLANNING_TURNS = 8;
const OUTPUT_TRUNC = 4000;

export class SupervisorManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly limits: SupervisorLimits;

  constructor(private readonly deps: SupervisorDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  // ---- 对外 API ----

  /** 发起一次编排:创建记录并异步驱动循环(立即返回 run) */
  async start(opts: {
    goal: string;
    cwd: string;
    mode: 'hitl' | 'auto';
    bypassPermissions?: boolean;
  }): Promise<SupervisorRunRecord> {
    const goal = opts.goal.trim();
    if (!goal) throw new Error('编排目标不能为空');
    if (!opts.cwd.trim()) throw new Error('工作目录为必填');
    const provider = this.deps.createProvider();
    if (!provider) throw new Error('Supervisor LLM 未配置:请先在配置页设置 API Key');

    const id = randomUUID();
    const record: SupervisorRunRecord = {
      id,
      goal,
      cwd: opts.cwd,
      mode: opts.mode,
      bypassPermissions: opts.bypassPermissions === true,
      state: 'planning',
      plan: null,
      report: null,
      error: null,
      usage: { input: 0, output: 0 },
      createdAt: Date.now(),
      endedAt: null,
    };
    this.deps.store.upsertSupervisorRun(record);
    this.active.set(id, { record, steps: [], round: 0 });
    this.broadcastRun(id);

    void this.mainLoop(id, provider).catch((err) => {
      this.failRun(id, err instanceof Error ? err.message : String(err));
    });
    return { ...record };
  }

  list(limit = 50): SupervisorRunRecord[] {
    return this.deps.store.listSupervisorRuns(limit);
  }

  get(id: string): { run: SupervisorRunRecord; steps: SupervisorStepRecord[] } | undefined {
    const act = this.active.get(id);
    if (act) return { run: { ...act.record }, steps: act.steps.map((s) => ({ ...s })) };
    const run = this.deps.store.getSupervisorRun(id);
    if (!run) return undefined;
    return { run, steps: this.deps.store.listSupervisorSteps(id) };
  }

  /** 人在环审批:approve(可携带修订计划)/ reject */
  async approve(id: string, action: 'approve' | 'reject', plan?: SupervisorPlan): Promise<SupervisorRunRecord> {
    const act = this.active.get(id);
    if (!act) throw new Error('编排不存在');
    if (act.record.state !== 'awaiting_approval') throw new Error(`当前状态 ${act.record.state} 不可审批`);

    if (action === 'reject') {
      if (act.gate) {
        act.gate.resolve({ type: 'reject' }); // 循环内的 waitGate 负责落账
      } else {
        this.failRun(id, act.stopRequested ?? '用户拒绝了计划'); // 重启恢复的挂起 run
      }
      return { ...act.record };
    }

    let merged: SupervisorPlan | undefined;
    if (plan?.steps?.length) {
      const revisedGoal = String(plan.goal ?? '').trim() || act.record.goal;
      merged = this.normalizePlan(plan, revisedGoal) ?? undefined;
      if (!merged) throw new Error('修订计划不合法:steps 为空或字段缺失');
      // 修订被采纳:goal 与 plan 同步落账,报告/后续阶段以修订后口径为准
      act.record.goal = revisedGoal;
      act.record.plan = merged;
      this.deps.store.upsertSupervisorRun(act.record);
      this.broadcastRun(id);
    }

    if (act.gate) {
      act.gate.resolve({ type: 'approve', plan: merged }); // 循环继续,由其 syncSteps
      return { ...act.record };
    }

    // 重启恢复的挂起 run:审批后由这里续跑
    const provider = this.deps.createProvider();
    if (!provider) throw new Error('Supervisor LLM 未配置');
    const finalPlan = merged ?? act.record.plan;
    if (!finalPlan) throw new Error('无待审批计划');
    this.syncSteps(id, finalPlan);
    void this.postGateLoop(id, provider).catch((err) => {
      this.failRun(id, err instanceof Error ? err.message : String(err));
    });
    return { ...act.record };
  }

  /** 中止:打断进行中的 Worker 任务,run 归 stopped */
  async stop(id: string): Promise<SupervisorRunRecord | undefined> {
    const act = this.active.get(id);
    if (!act) return this.deps.store.getSupervisorRun(id);
    act.stopRequested = '用户中止';
    if (act.currentTaskId) await this.deps.tasks.stop(act.currentTaskId).catch(() => null);
    if (act.gate) {
      act.gate.resolve({ type: 'reject' }); // 循环的 stop 检查点负责落账 stopped
    } else if (act.record.state === 'awaiting_approval') {
      this.settleRun(id, 'stopped', '用户中止'); // 恢复的挂起 run 无循环在跑
    }
    return await this.waitSettled(id);
  }

  /** 服务启动时恢复:进行中的 run 归位;awaiting_approval 的 run 重新可审批 */
  recover(): void {
    for (const run of this.deps.store.listSupervisorRuns(500)) {
      if (run.state === 'awaiting_approval') {
        const steps = this.deps.store.listSupervisorSteps(run.id);
        // 已同步过的轮数:从 stepId 前缀还原(rK-sN → K;纯 sN → 1;无步骤 → 0)
        const rounds = steps.map((s) => (/^r(\d+)-/.exec(s.stepId)?.[1] ? Number(/^r(\d+)-/.exec(s.stepId)![1]) : s.stepId ? 1 : 0));
        this.active.set(run.id, { record: run, steps, round: Math.max(0, ...rounds) });
        continue;
      }
      if (!['done', 'failed', 'stopped'].includes(run.state)) {
        this.settleStored(run, 'stopped', '服务重启,编排中止');
      }
    }
  }

  // ---- 主循环 ----

  private async mainLoop(id: string, provider: LlmProvider): Promise<void> {
    this.setState(id, 'planning');
    const plan = await this.planPhase(id, provider, '');
    if (!plan) return; // 失败已在 planPhase 内落账
    if (this.isStopped(id)) {
      this.settleRun(id, 'stopped', this.active.get(id)?.stopRequested ?? '用户中止');
      return;
    }

    if (this.active.get(id)?.record.mode === 'hitl') {
      this.setState(id, 'awaiting_approval');
      this.emit(id, 'gate-waiting', `等待审批:${plan.steps.length} 步计划`);
      const decision = await this.waitGate(id);
      const act = this.active.get(id);
      if (!act) return;
      if (act.stopRequested) {
        this.settleRun(id, 'stopped', act.stopRequested);
        return;
      }
      if (decision.type === 'reject') {
        this.failRun(id, '用户拒绝了计划');
        return;
      }
      this.syncSteps(id, decision.plan ?? plan);
    } else {
      this.syncSteps(id, plan);
    }

    await this.postGateLoop(id, provider);
  }

  /** 计划已批准后的续跑:执行 → (replan → 重新规划/过门禁)* → 收尾 */
  private async postGateLoop(id: string, provider: LlmProvider): Promise<void> {
    let replans = 0;
    while (true) {
      const flow = await this.executePhase(id, provider);
      if (flow === 'done') break;
      if (flow === 'stopped') {
        this.settleRun(id, 'stopped', this.active.get(id)?.stopRequested ?? '用户中止');
        return;
      }
      if (flow === 'failed') return; // executePhase 内已落账

      replans++;
      if (replans > this.limits.maxReplans) {
        this.failRun(id, `重规划次数超限(${this.limits.maxReplans})`);
        return;
      }
      const failedStep = this.active.get(id)?.steps.find((s) => s.verifyResult === 'fail' && s.state !== 'done');
      const extraContext = this.replanContext(id, failedStep);
      this.emit(id, 'replan', `验收未通过,重新规划(第 ${replans} 次)`);

      this.setState(id, 'planning');
      const plan = await this.planPhase(id, provider, extraContext);
      if (!plan) return;
      if (this.isStopped(id)) {
        this.settleRun(id, 'stopped', this.active.get(id)?.stopRequested ?? '用户中止');
        return;
      }

      if (this.active.get(id)?.record.mode === 'hitl') {
        this.setState(id, 'awaiting_approval');
        this.emit(id, 'gate-waiting', `等待审批(重规划):${plan.steps.length} 步计划`);
        const decision = await this.waitGate(id);
        const act = this.active.get(id);
        if (!act) return;
        if (act.stopRequested) {
          this.settleRun(id, 'stopped', act.stopRequested);
          return;
        }
        if (decision.type === 'reject') {
          this.failRun(id, '用户拒绝了重规划');
          return;
        }
        this.syncSteps(id, decision.plan ?? plan);
      } else {
        this.syncSteps(id, plan);
      }
    }

    const report = await this.finalizePhase(id, provider);
    if (report === null) return;
    const act = this.active.get(id);
    if (!act) return;
    act.record.report = report;
    this.emit(id, 'run-finalized', `编排完成:${truncate(report, 160)}`);
    this.settleRun(id, 'done');
  }

  // ---- 阶段实现 ----

  /** 规划:LLM 可先调 query_events / memory_read 收集背景,再 submit_plan */
  private async planPhase(id: string, provider: LlmProvider, extraContext: string): Promise<SupervisorPlan | null> {
    const act = this.active.get(id);
    if (!act) return null;
    const { goal, cwd } = act.record;

    const submitPlanSchema = {
      type: 'function' as const,
      function: {
        name: 'submit_plan',
        description: '提交编排计划(唯一出口)。步骤串行执行,按顺序拆分,每步有明确验收标准。',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: `步骤列表(1-${this.limits.maxSteps} 步,串行)`,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '步骤短标题' },
                  agent: { type: 'string', description: '执行者', enum: [...WORKER_AGENT_IDS] },
                  prompt: { type: 'string', description: '给 Worker 的完整任务指令(自包含:目标/边界/产出物)' },
                  acceptanceCheck: { type: 'string', description: '可判定的验收标准(完成后如何检查)' },
                  autoCheck: { type: 'boolean', description: '纯执行类步骤可 true:跳过 LLM 验收,只看任务状态' },
                },
                required: ['title', 'agent', 'prompt', 'acceptanceCheck'],
              },
            },
          },
          required: ['steps'],
        },
      },
    };

    const system = [
      '你是 OpenHarness 的 Supervisor(编排指挥官),负责把一个总目标拆解为可执行的 Worker 任务计划。',
      `可用 Worker:${[...WORKER_AGENT_IDS].map((a) => `${AGENT_DISPLAY[a]}(${a})`).join('、')}。`,
      'Worker 特长:claude=多步编排/CLI 工程;codex=沙箱实验;dsh=多 provider/MCP;cursor=IDE 内多文件重构。',
      `约束:1-${this.limits.maxSteps} 步;步骤串行;prompt 必须自包含(Worker 看不到本对话);acceptanceCheck 必须可判定。`,
      '规划前可调用 query_events / memory_read 了解背景;准备好后调用 submit_plan 提交计划。',
      '用中文;直接开始,不要寒暄。',
    ].join('\n');

    const userParts = [`[目标] ${goal}`, `[工作目录] ${cwd}`];
    const mem = this.deps.memory.read().trim();
    if (mem) userParts.push(`[团队记忆]\n${truncate(mem, 1500)}`);
    if (extraContext) userParts.push(extraContext);
    userParts.push('请规划。');

    const messages: LlmMessage[] = [{ role: 'user', content: userParts.join('\n\n') }];
    const ctxTools = toolSchemas(['query_events', 'memory_read']);

    for (let turn = 0; turn < PLANNING_TURNS; turn++) {
      const res = await this.llm(id, provider, {
        system,
        messages,
        tools: [...ctxTools, submitPlanSchema],
      });
      const submit = res.toolCalls.find((tc) => tc.name === 'submit_plan');
      if (submit) {
        const plan = this.normalizePlan({ goal, steps: (submit.args.steps as PlanStep[]) ?? [] }, goal);
        if (!plan) {
          this.failRun(id, '计划不合法:steps 为空或字段缺失');
          return null;
        }
        act.record.plan = plan;
        this.emit(id, 'plan-created', `计划生成:${plan.steps.length} 步 —— ${plan.steps.map((s) => s.title).join(' → ')}`);
        return plan;
      }
      if (!res.toolCalls.length) {
        // 纯文本回复:推一把
        messages.push({ role: 'assistant', content: res.text ?? '' });
        messages.push({ role: 'user', content: '请调用 submit_plan 提交计划。' });
        continue;
      }
      // 上下文工具调用:执行后按原生 tool 协议回填
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const r = await executeTool(tc.name, tc.args, this.toolContext(id));
        messages.push({ role: 'tool', toolCallId: tc.id, content: truncate(r.output, 3000) });
      }
    }
    this.failRun(id, `规划未在轮次内提交计划(上限 ${PLANNING_TURNS} 轮)`);
    return null;
  }

  /** 执行:逐步派发 → 验收 → 自动重试(带失败反馈)→ 反思(replan/abort) */
  private async executePhase(id: string, provider: LlmProvider): Promise<Flow> {
    const act = this.active.get(id);
    if (!act) return 'failed';
    for (const step of act.steps) {
      if (this.isStopped(id)) return 'stopped';
      if (step.state !== 'pending') continue;

      let failureNote = '';
      for (let attempt = 1; attempt <= this.limits.maxRetriesPerStep + 1; attempt++) {
        if (this.isStopped(id)) return 'stopped';
        step.state = 'running';
        step.attempt = attempt;
        this.persistStep(id, step);
        this.setState(id, 'executing');

        const prompt = failureNote
          ? `${step.prompt}\n\n[上次尝试未通过验收]\n${failureNote}\n请修正后重试。`
          : step.prompt;
        const r = await this.dispatchAndWait(id, step.agent, prompt, this.limits.stepTimeoutMs);
        step.taskId = r.taskId || null;
        step.output = truncate(r.output, OUTPUT_TRUNC) || null;
        if (this.isStopped(id)) return 'stopped';

        // 验收
        this.setState(id, 'verifying');
        const verdict = step.autoCheck
          ? { pass: r.state === 'done', reason: `任务状态 ${r.state}` }
          : await this.verifyPhase(id, provider, step, r.state, step.output ?? '');
        if (this.isStopped(id)) return 'stopped';

        if (verdict.pass) {
          step.state = 'done';
          step.verifyResult = 'pass';
          step.verifyReason = verdict.reason;
          this.persistStep(id, step);
          this.emit(id, 'verify-passed', `步骤「${step.title}」验收通过:${truncate(verdict.reason, 120)}`);
          failureNote = '';
          break;
        }

        step.verifyResult = 'fail';
        step.verifyReason = verdict.reason;
        this.persistStep(id, step);
        this.emit(id, 'verify-failed', `步骤「${step.title}」验收失败:${truncate(verdict.reason, 160)}`);
        failureNote = verdict.reason;

        if (attempt > this.limits.maxRetriesPerStep) {
          // 重试耗尽 → 反思:replan / abort
          this.setState(id, 'reflecting');
          const decision = await this.reflectPhase(id, provider, step);
          if (this.isStopped(id)) return 'stopped';
          if (decision.action === 'replan') {
            step.state = 'failed';
            this.persistStep(id, step);
            return 'replan';
          }
          this.failRun(id, `步骤「${step.title}」验收失败并放弃:${decision.reason}`);
          return 'failed';
        }
        // 自动重试(下一轮 attempt,带失败反馈)
      }
    }
    return 'done';
  }

  /** 验收:LLM 按 acceptanceCheck 给结构化结论 */
  private async verifyPhase(
    id: string,
    provider: LlmProvider,
    step: SupervisorStepRecord,
    taskState: string,
    output: string,
  ): Promise<{ pass: boolean; reason: string }> {
    const schema = {
      type: 'function' as const,
      function: {
        name: 'submit_verdict',
        description: '提交验收结论(唯一出口)。',
        parameters: {
          type: 'object',
          properties: {
            pass: { type: 'boolean', description: '是否通过验收' },
            reason: { type: 'string', description: '判定依据(未通过时给出具体缺失)' },
          },
          required: ['pass', 'reason'],
        },
      },
    };
    const system = [
      '你是严格的验收官。对照验收标准检查 Worker 产出,只依据给定材料判定,不臆测。',
      '产出可能被截断;若材料明显不足以判定且任务失败,判不通过。',
    ].join('\n');
    const user = [
      `[步骤] ${step.title}`,
      `[执行者] ${AGENT_DISPLAY[step.agent]}`,
      `[任务指令] ${step.prompt}`,
      `[验收标准] ${step.acceptanceCheck}`,
      `[任务状态] ${taskState}`,
      `[产出]\n${output || '(无文本产出)'}`,
    ].join('\n\n');

    const messages: LlmMessage[] = [{ role: 'user', content: user }];
    for (let turn = 0; turn < 2; turn++) {
      const res = await this.llm(id, provider, { system, messages, tools: [schema], temperature: 0 });
      const verdict = res.toolCalls.find((tc) => tc.name === 'submit_verdict');
      if (verdict) {
        const pass = verdict.args.pass === true || verdict.args.pass === 'true';
        return { pass, reason: String(verdict.args.reason ?? '') || (pass ? '符合验收标准' : '未说明原因') };
      }
      messages.push({ role: 'assistant', content: res.text ?? '' });
      messages.push({ role: 'user', content: '请调用 submit_verdict 给出结论。' });
    }
    return { pass: false, reason: '验收未返回结构化结论' };
  }

  /** 反思:重试耗尽后决定 replan / abort */
  private async reflectPhase(
    id: string,
    provider: LlmProvider,
    step: SupervisorStepRecord,
  ): Promise<{ action: 'replan' | 'abort'; reason: string }> {
    const schema = {
      type: 'function' as const,
      function: {
        name: 'decide_next',
        description: '提交反思决定(唯一出口)。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'replan=重新规划整体方案;abort=放弃该目标', enum: ['replan', 'abort'] },
            reason: { type: 'string', description: '决定理由' },
          },
          required: ['action', 'reason'],
        },
      },
    };
    const system = [
      '你是编排反思官。某步骤多次尝试均未通过验收,请判断整体方案是否有救。',
      '可换思路/换步骤拆分/换 Worker → replan;目标本身不可达或代价过高 → abort。',
    ].join('\n');
    const user = [
      `[目标] ${this.active.get(id)?.record.goal ?? ''}`,
      `[失败步骤] ${step.title}(执行者 ${AGENT_DISPLAY[step.agent]})`,
      `[已尝试] ${step.attempt} 次`,
      `[验收失败原因] ${step.verifyReason ?? ''}`,
      `[最后产出]\n${step.output ?? '(无)'}`,
    ].join('\n\n');

    const res = await this.llm(id, provider, {
      system,
      messages: [{ role: 'user', content: user }],
      tools: [schema],
      temperature: 0,
    });
    const decision = res.toolCalls.find((tc) => tc.name === 'decide_next');
    if (decision && (decision.args.action === 'replan' || decision.args.action === 'abort')) {
      return { action: decision.args.action, reason: String(decision.args.reason ?? '') };
    }
    return { action: 'abort', reason: '反思未返回有效决定,默认放弃' };
  }

  /** 收尾:汇总各步产出为最终报告 */
  private async finalizePhase(id: string, provider: LlmProvider): Promise<string | null> {
    const act = this.active.get(id);
    if (!act) return null;
    const system = [
      '你是编排收官官。根据各步骤的执行与验收结果,写一份给用户的最终报告(Markdown)。',
      '结构:## 结果摘要 / ## 各步骤交付(每步:做了什么、验收结论)/ ## 后续建议(如有)。用中文,克制,不编造。',
    ].join('\n');
    const user = [
      `[目标] ${act.record.goal}`,
      ...act.steps
        .filter((s) => s.state === 'done' || s.state === 'failed')
        .map(
          (s) =>
            `- 步骤「${s.title}」(${AGENT_DISPLAY[s.agent]},${s.state === 'done' ? '验收通过' : '失败'}):${truncate(s.output ?? s.verifyReason ?? '', 800)}`,
        ),
    ].join('\n');
    const res = await this.llm(id, provider, { system, messages: [{ role: 'user', content: user }], maxTokens: 2048 });
    const text = res.text?.trim();
    if (!text) {
      this.failRun(id, '报告生成为空');
      return null;
    }
    return text;
  }

  // ---- 派发与等待 ----

  /** 经 TaskManager 派发 Worker 任务并等待收尾:bus 观察任务状态与 assistant 产出,超时打断 */
  private async dispatchAndWait(
    id: string,
    agent: AgentId,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ taskId: string; state: string; exitCode: number | null; output: string }> {
    const act = this.active.get(id);
    if (!act) return { taskId: '', state: 'error', exitCode: null, output: 'run 不存在' };
    const adapter = this.deps.getAdapter(agent);
    if (!adapter) {
      return { taskId: '', state: 'error', exitCode: null, output: `${AGENT_DISPLAY[agent]} 适配器未接入` };
    }
    const info = await this.deps.tasks.start(adapter, {
      cwd: act.record.cwd,
      prompt: this.deps.roles.inject(agent, prompt),
      displayPrompt: prompt,
      bypassPermissions: act.record.bypassPermissions === true,
    });
    act.currentTaskId = info.id;

    return await new Promise((resolve) => {
      const parts: string[] = [];
      let settled = false;
      const off = onMessage((msg) => {
        if (settled) return;
        if (msg.type === 'event' && msg.data.meta?.taskId === info.id && msg.data.kind === 'assistant-message') {
          const full = typeof msg.data.meta.fullText === 'string' ? msg.data.meta.fullText : msg.data.summary;
          parts.push(full);
        }
        if (msg.type === 'task' && msg.data.id === info.id) {
          const t = msg.data;
          if (t.state === 'done' || t.state === 'error' || t.state === 'stopped') {
            settled = true;
            cleanup();
            act.currentTaskId = undefined;
            resolve({ taskId: info.id, state: t.state, exitCode: t.exitCode ?? null, output: parts.join('\n\n').trim() });
          }
        }
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        void this.deps.tasks
          .stop(info.id)
          .catch(() => null)
          .then(() => {
            act.currentTaskId = undefined;
            resolve({
              taskId: info.id,
              state: 'stopped',
              exitCode: null,
              output: `${parts.join('\n\n').trim()}\n[步骤超时,已打断]`.trim(),
            });
          });
      }, timeoutMs);
      function cleanup(): void {
        off();
        clearTimeout(timer);
      }
    });
  }

  // ---- 基础设施 ----

  private toolContext(id: string): ToolContext {
    const act = this.active.get(id)!;
    return {
      runId: id,
      cwd: act.record.cwd,
      launchAndWait: (agent, prompt, timeoutMs) => this.dispatchAndWait(id, agent, prompt, timeoutMs),
      queryEvents: (filter) => {
        const events = this.deps.store.events;
        if (!events) return [];
        return events.call(this.deps.store, {
          agent: filter.agent,
          kinds: filter.kind ? [filter.kind] : undefined,
          q: filter.q,
          limit: filter.limit ?? 20,
        });
      },
      memory: this.deps.memory,
    };
  }

  /** LLM 调用统一出口:记账 + 预算边界 */
  private async llm(id: string, provider: LlmProvider, req: Parameters<LlmProvider['complete']>[0]): Promise<LlmResponse> {
    const act = this.active.get(id);
    if (!act) throw new RunFailure('run 不存在');
    const res = await provider.complete(req);
    act.record.usage.input += res.usage.input;
    act.record.usage.output += res.usage.output;
    this.deps.store.upsertSupervisorRun(act.record);
    if (act.record.usage.input + act.record.usage.output > this.limits.tokenBudget) {
      this.failRun(id, `Token 预算耗尽(上限 ${this.limits.tokenBudget})`);
      throw new RunFailure(`Token 预算耗尽(上限 ${this.limits.tokenBudget})`);
    }
    return res;
  }

  /** 计划归一化:裁剪步骤数、补 id、校验 Worker 合法性;不合法返回 null */
  private normalizePlan(plan: SupervisorPlan, goal: string): SupervisorPlan | null {
    if (!plan.steps?.length) return null;
    const steps: PlanStep[] = [];
    for (const raw of plan.steps.slice(0, this.limits.maxSteps)) {
      const agent = raw.agent as AgentId;
      if (!WORKER_AGENT_IDS.includes(agent)) return null;
      const title = String(raw.title ?? '').trim();
      const prompt = String(raw.prompt ?? '').trim();
      if (!title || !prompt) return null;
      const acceptanceCheck = String(raw.acceptanceCheck ?? '').trim();
      steps.push({
        id: raw.id ?? '',
        title,
        agent,
        prompt,
        acceptanceCheck: acceptanceCheck || '任务以 done 状态收尾',
        autoCheck: raw.autoCheck === true || !acceptanceCheck,
      });
    }
    return { goal, steps };
  }

  /** 计划落为 step 记录:旧 pending/running 归 skipped(重规划场景),新步骤追加 */
  private syncSteps(id: string, plan: SupervisorPlan): void {
    const act = this.active.get(id);
    if (!act) return;
    act.round += 1;
    for (const s of act.steps) {
      if (s.state === 'pending' || s.state === 'running') {
        s.state = 'skipped';
        this.persistStep(id, s);
      }
    }
    plan.steps.forEach((step, i) => {
      const stepId = act.round === 1 ? `s${i + 1}` : `r${act.round}-s${i + 1}`;
      const rec: SupervisorStepRecord = {
        runId: id,
        stepId,
        title: step.title,
        agent: step.agent,
        prompt: step.prompt,
        acceptanceCheck: step.acceptanceCheck,
        autoCheck: step.autoCheck === true,
        state: 'pending',
        taskId: null,
        attempt: 0,
        output: null,
        verifyResult: null,
        verifyReason: null,
      };
      act.steps.push(rec);
      this.persistStep(id, rec);
    });
    act.record.plan = plan;
    this.deps.store.upsertSupervisorRun(act.record);
    this.broadcastRun(id);
  }

  private replanContext(id: string, failedStep?: SupervisorStepRecord): string {
    const act = this.active.get(id);
    if (!act) return '';
    const done = act.steps.filter((s) => s.state === 'done');
    return [
      '[重规划背景]',
      done.length
        ? `已完成步骤:${done.map((s) => `「${s.title}」(${AGENT_DISPLAY[s.agent]})`).join('、')}——结果可直接复用,不要重做。`
        : '尚无已完成步骤。',
      failedStep
        ? `失败步骤:「${failedStep.title}」(${AGENT_DISPLAY[failedStep.agent]}),验收失败原因:${failedStep.verifyReason ?? '未知'}。请换思路、换拆分或换 Worker。`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private waitGate(id: string): Promise<GateDecision> {
    return new Promise((resolve) => {
      const act = this.active.get(id);
      if (!act) return resolve({ type: 'reject' });
      act.gate = { resolve };
      this.broadcastRun(id);
    });
  }

  private isStopped(id: string): boolean {
    return Boolean(this.active.get(id)?.stopRequested);
  }

  private setState(id: string, state: SupervisorRunRecord['state']): void {
    const act = this.active.get(id);
    if (!act) return;
    act.record.state = state;
    this.deps.store.upsertSupervisorRun(act.record);
    this.broadcastRun(id);
  }

  private persistStep(id: string, step: SupervisorStepRecord): void {
    this.deps.store.upsertSupervisorStep({ ...step });
    this.broadcastRun(id);
  }

  private failRun(id: string, reason: string): void {
    this.settleRun(id, 'failed', reason);
  }

  private settleRun(id: string, state: 'done' | 'failed' | 'stopped', reason?: string): void {
    const act = this.active.get(id);
    if (!act) return;
    act.record.state = state;
    act.record.endedAt = Date.now();
    if (state !== 'done') act.record.error = reason ?? state;
    this.deps.store.upsertSupervisorRun(act.record);
    this.broadcastRun(id);
    this.active.delete(id);
  }

  /** 恢复场景:对无 ActiveRun 的历史记录直接落账 */
  private settleStored(run: SupervisorRunRecord, state: 'stopped', reason: string): void {
    run.state = state;
    run.endedAt = Date.now();
    run.error = reason;
    this.deps.store.upsertSupervisorRun(run);
  }

  private async waitSettled(id: string, timeoutMs = 5000): Promise<SupervisorRunRecord | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = this.deps.store.getSupervisorRun(id);
      if (r && ['done', 'failed', 'stopped'].includes(r.state)) return r;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    return this.deps.store.getSupervisorRun(id);
  }

  private emit(id: string, kind: HarnessEvent['kind'], summary: string): void {
    const act = this.active.get(id);
    if (!act) return;
    this.deps.emitEvent({
      ts: Date.now(),
      agent: 'supervisor',
      projectDir: act.record.cwd,
      sessionId: id,
      kind,
      summary,
      meta: { supervisorRunId: id },
    });
  }

  private broadcastRun(id: string): void {
    const act = this.active.get(id);
    if (act) {
      broadcast({
        type: 'supervisor',
        data: { run: { ...act.record }, steps: act.steps.map((s) => ({ ...s })) },
      });
      return;
    }
    const run = this.deps.store.getSupervisorRun(id);
    if (run) broadcast({ type: 'supervisor', data: { run } });
  }
}
