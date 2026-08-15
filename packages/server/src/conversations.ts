/**
 * ConversationManager:对话室的核心状态机。
 * - 每个对话记录 user/assistant/task/system 消息,经 WS 实时推送;
 * - 每个 Agent 在对话内维护自己的 resume 链:同 Agent 后续消息经原生
 *   --resume 续接(claude/codex/cursor);
 * - dsh headless 不支持 resume:每条消息注入最近对话摘要兜底;
 * - 切换到其他 Agent 时,注入最近对话摘要作为新 Agent 的背景上下文;
 * - 任务事件(assistant-message / session-start / task-end)回填为对话消息。
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentId,
  ConversationMessage,
  ConversationRole,
  ConversationSummary,
  HarnessEvent,
  TaskInfo,
} from '@openharness/core';
import { AGENT_DISPLAY, truncate } from '@openharness/core';
import { broadcast } from './bus.js';
import type { Store } from './store.js';
import type { TaskManager } from './tasks.js';

/** 不支持 headless resume 的 Agent:退化为摘要注入 */
const NO_RESUME: readonly AgentId[] = ['dsh'];

const SUMMARY_WINDOW = 6;
const SUMMARY_CHARS = 150;

export class ConversationManager {
  /** convId → 当前运行中的任务 id */
  private readonly convTask = new Map<string, string>();
  /** taskId → convId(事件归因兜底) */
  private readonly taskConv = new Map<string, string>();
  /** taskId → 是否已收到过助手输出(收尾时若无输出则补反馈气泡) */
  private readonly taskAssistantSeen = new Map<string, boolean>();

  constructor(
    private readonly store: Store,
    private readonly tasks: TaskManager,
    private readonly getAdapter: (agent: AgentId) => AgentAdapter | undefined,
  ) {}

  /** 新建对话;可选从某原生会话接续(会话档案「对话室续聊」) */
  create(opts: { title?: string; agent?: AgentId; sessionId?: string; cwd?: string } = {}): ConversationSummary {
    const id = randomUUID();
    const now = Date.now();
    const title =
      opts.title?.trim() ||
      `对话 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now)}`;
    this.store.createConversation(id, title, now);
    if (opts.agent && opts.sessionId) {
      this.store.setConversationAgent(id, opts.agent, opts.sessionId, opts.cwd ?? null);
      this.pushMessage(id, {
        agent: opts.agent,
        role: 'system',
        content: `已接续 ${AGENT_DISPLAY[opts.agent]} 原生会话(${opts.sessionId}):后续消息经原生 resume 保持上下文。`,
      });
    } else {
      this.pushMessage(id, { agent: null, role: 'system', content: '新对话已创建:选择一位特工,开始连续问答。' });
    }
    return this.store.getConversation(id)!;
  }

  list(): ConversationSummary[] {
    return this.store.listConversations();
  }

  delete(convId: string): boolean {
    this.convTask.delete(convId);
    for (const [taskId, cid] of [...this.taskConv]) {
      if (cid === convId) this.taskConv.delete(taskId);
    }
    return this.store.deleteConversation(convId);
  }

  messages(convId: string, opts: { limit?: number; beforeSeq?: number } = {}): { messages: ConversationMessage[]; hasMore: boolean } {
    return this.store.conversationMessages(convId, opts);
  }

  /** 当前运行中的任务(供打断) */
  currentTask(convId: string): TaskInfo | undefined {
    const taskId = this.convTask.get(convId);
    if (!taskId) return undefined;
    return this.tasks.list().find((t) => t.id === taskId);
  }

  /** 发送一条用户消息并启动对应 Agent 的任务 */
  async send(
    convId: string,
    content: string,
    agent: AgentId,
    cwd: string,
    opts: { bypassPermissions?: boolean } = {},
  ): Promise<{ message: ConversationMessage; task: TaskInfo }> {
    const adapter = this.getAdapter(agent);
    if (!adapter) throw new Error(`${AGENT_DISPLAY[agent]} 适配器未接入`);
    if (!this.store.getConversation(convId)) throw new Error('对话不存在');
    const text = content.trim();
    if (!text) throw new Error('消息不能为空');
    if (!cwd.trim()) throw new Error('工作目录为必填');

    const state = this.store.conversationAgents(convId).find((s) => s.agent === agent);
    const canResume = !NO_RESUME.includes(agent);
    const resumeSessionId = canResume ? (state?.sessionId ?? undefined) : undefined;

    // 最近一条消息的发言者:判断是否切换了 Agent
    const recent = this.store.conversationMessages(convId, { limit: 1 }).messages[0];
    const switching = (recent?.agent ?? null) !== null && recent?.agent !== agent;

    let prompt = text;
    if ((switching || !canResume) && this.store.conversationMessagesCount(convId) > 0) {
      const summary = this.injectSummary(convId);
      if (summary) prompt = `${summary}\n\n[本轮消息] ${text}`;
    }

    const userMsg = this.pushMessage(convId, { agent, role: 'user', content: text });
    const task = await this.tasks.start(adapter, {
      cwd: cwd.trim(),
      prompt,
      displayPrompt: text,
      conversationId: convId,
      resumeSessionId,
      bypassPermissions: opts.bypassPermissions === true,
    });
    this.taskConv.set(task.id, convId);
    this.convTask.set(convId, task.id);
    this.taskAssistantSeen.set(task.id, false);
    this.store.setConversationAgent(convId, agent, state?.sessionId ?? null, cwd.trim());
    // task-start 事件可能已先行建过气泡,防重复
    if (!this.store.hasConversationTaskMessage(convId, task.id)) {
      this.pushMessage(convId, {
        agent,
        role: 'task',
        content: `任务已发起(${AGENT_DISPLAY[agent]}):${truncate(text, 80)}`,
        taskId: task.id,
      });
    }
    return { message: userMsg, task };
  }

  async stop(convId: string): Promise<boolean> {
    const taskId = this.convTask.get(convId);
    if (!taskId) return false;
    await this.tasks.stop(taskId);
    return true;
  }

  /**
   * 事件流水线钩子:把任务事件回填为对话消息。
   * 只归因带 taskId 的发射路径事件(避免与 watch 路径重复回填)。
   */
  handleEvent(e: HarnessEvent): void {
    const taskId = typeof e.meta?.taskId === 'string' ? e.meta.taskId : undefined;
    if (!taskId) return;
    const convId = typeof e.meta?.conversationId === 'string' ? e.meta.conversationId : this.taskConv.get(taskId);
    if (!convId) return;

    if (e.kind === 'assistant-message') {
      this.taskAssistantSeen.set(taskId, true);
      this.pushMessage(convId, { agent: e.agent, role: 'assistant', content: e.summary, taskId });
    } else if (e.kind === 'error') {
      // 任务过程中的错误必须可见,否则"任务完成"却无输出无从解释
      this.pushMessage(convId, { agent: e.agent, role: 'system', content: `⚠️ ${e.summary}`, taskId });
    } else if (e.kind === 'task-start') {
      // 外部派活(带 conversationId 的任务)也进对话气泡;
      // 注意:事件可能早于 send() 登记 taskConv,以库中是否已有气泡为准防重复
      if (!this.taskConv.has(taskId) && !this.store.hasConversationTaskMessage(convId, taskId)) {
        this.taskConv.set(taskId, convId);
        this.taskAssistantSeen.set(taskId, false);
        this.pushMessage(convId, { agent: e.agent, role: 'task', content: `任务已发起(${AGENT_DISPLAY[e.agent]}):${truncate(e.summary.replace(/^发起任务:/, ''), 80)}`, taskId });
      }
    } else if (e.kind === 'session-start') {
      this.store.setConversationAgent(convId, e.agent, e.sessionId, e.projectDir);
    } else if (e.kind === 'task-end') {
      const label = e.meta?.state === 'done' ? '完成' : e.meta?.state === 'stopped' ? '已打断' : '失败';
      const detail = e.summary === '任务完成' || e.summary === '任务已打断' ? '' : `:${truncate(e.summary, 80)}`;
      this.store.updateConversationTaskMessage(taskId, `任务${label}${detail}`, e.ts);
      this.store.touchConversation(convId, e.ts);
      // 收尾必反馈:无助手输出(网络/权限中断)时补一条系统气泡
      if (this.taskAssistantSeen.get(taskId) === false && label !== '已打断') {
        this.pushMessage(convId, {
          agent: e.agent,
          role: 'system',
          content: `任务${label}但未收到助手输出(可能因网络/权限中断,详见上方错误提示)。可勾选「完全自主」后重试。`,
          taskId,
        });
      }
      this.taskConv.delete(taskId);
      this.taskAssistantSeen.delete(taskId);
      if (this.convTask.get(convId) === taskId) this.convTask.delete(convId);
    }
  }

  // ---- 内部 ----

  private pushMessage(
    convId: string,
    m: { agent?: AgentId | null; role: ConversationRole; content: string; taskId?: string | null },
  ): ConversationMessage {
    const message = this.store.addConversationMessage(convId, m);
    broadcast({ type: 'conversation', data: { convId, message } });
    return message;
  }

  /** 最近若干轮对话摘要,注入给切换后的 Agent / 无 resume 能力的 Agent */
  private injectSummary(convId: string): string {
    const history = this.store
      .conversationMessages(convId, { limit: 60 })
      .messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-SUMMARY_WINDOW);
    if (history.length === 0) return '';
    const lines = history.map((m) => {
      const who = m.role === 'user' ? '用户' : AGENT_DISPLAY[m.agent ?? 'dsh'] ?? '助手';
      return `[${who}] ${truncate(m.content, SUMMARY_CHARS)}`;
    });
    // 跨 Agent 派活约定:走本机 OpenHarness API 且带上 conversationId,结果才能回流本对话
    const delegation = `\n[协作约定] 如需给其他特工派活,请调用本机 API:POST http://127.0.0.1:3900/api/tasks,body 为 {"agent":"claude|codex|cursor|dsh","cwd":"<工作目录>","prompt":"<任务>","bypassPermissions":true,"conversationId":"${convId}"}(conversationId 必带,任务结果才能回到本对话)。`;
    return `[对话背景] 以下是本对话此前的交流摘要,请基于它继续回答,不要复述背景:\n${lines.join('\n')}${delegation}`;
  }
}
