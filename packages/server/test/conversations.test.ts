import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationManager } from '../src/conversations.js';
import { MemoryStore } from '../src/memory.js';
import { RoleStore } from '../src/roles.js';
import type { AgentAdapter, HarnessEvent, LaunchOptions, TaskInfo } from '@openharness/core';

// ---- 内存版 Store / TaskManager 桩(与生产接口同构) ----
interface ConvMsg { seq: number; convId: string; agent: string | null; role: string; content: string; taskId: string | null; createdAt: number }

class FakeStore {
  convs = new Map<string, { id: string; title: string; createdAt: number; updatedAt: number }>();
  msgs: ConvMsg[] = [];
  agents = new Map<string, Map<string, { sessionId: string | null; cwd: string | null }>>();
  seq = 0;
  createConversation(id: string, title: string, now: number) { this.convs.set(id, { id, title, createdAt: now, updatedAt: now }); }
  touchConversation(id: string, now: number) { this.convs.get(id)!.updatedAt = now; }
  getConversation(id: string) { const c = this.convs.get(id); return c && { ...c, messageCount: this.msgs.filter((m) => m.convId === id).length }; }
  listConversations() { return [...this.convs.values()].map((c) => ({ ...c, messageCount: this.msgs.filter((m) => m.convId === c.id).length })); }
  addConversationMessage(convId: string, m: { agent?: string | null; role: string; content: string; taskId?: string | null; createdAt?: number }) {
    this.msgs.push({ seq: ++this.seq, convId, agent: m.agent ?? null, role: m.role, content: m.content, taskId: m.taskId ?? null, createdAt: m.createdAt ?? Date.now() });
    this.touchConversation(convId, Date.now());
    return this.msgs[this.msgs.length - 1] as ConvMsg;
  }
  conversationMessages(convId: string, opts: { limit?: number; beforeSeq?: number } = {}) {
    let list = this.msgs.filter((m) => m.convId === convId);
    if (opts.beforeSeq !== undefined) list = list.filter((m) => m.seq < opts.beforeSeq!);
    const limit = opts.limit ?? 100;
    const page = list.slice(-limit);
    return { messages: page, hasMore: list.length > limit };
  }
  conversationMessagesCount(convId: string) { return this.msgs.filter((m) => m.convId === convId).length; }
  hasConversationTaskMessage(convId: string, taskId: string) { return this.msgs.some((m) => m.convId === convId && m.taskId === taskId && m.role === 'task'); }
  setConversationAgent(convId: string, agent: string, sessionId: string | null, cwd: string | null) {
    if (!this.agents.has(convId)) this.agents.set(convId, new Map());
    this.agents.get(convId)!.set(agent, { sessionId, cwd });
  }
  conversationAgents(convId: string) { return [...(this.agents.get(convId) ?? new Map()).entries()].map(([agent, s]) => ({ convId, agent, ...s })); }
  findConversationBySession() { return undefined; }
  updateConversationTaskMessage(taskId: string, content: string, now: number) { const m = this.msgs.find((x) => x.taskId === taskId); if (m) { m.content = content; m.createdAt = now; } }
  deleteConversation() { return true; }
}

class FakeTasks {
  launched: LaunchOptions[] = [];
  infos: TaskInfo[] = [];
  async start(_adapter: unknown, opts: LaunchOptions) {
    this.launched.push(opts);
    const info = { id: `t${this.launched.length}`, state: 'running' } as TaskInfo;
    this.infos.push(info);
    return info;
  }
  async stop() { return null; }
  list() { return this.infos; }
}

function mgr() {
  const store = new FakeStore();
  const tasks = new FakeTasks();
  const adapter = (agent: string) => ({ agentId: agent } as AgentAdapter);
  const roles = { inject: (_a: string, p: string) => p } as never;
  const memory = { recent: () => [] as string[] } as never;
  return { store, tasks, mgr: new ConversationManager(store as never, tasks as never, adapter as never, roles, memory) };
}

function ev(taskId: string, convId: string, kind: HarnessEvent['kind'], summary: string, extra: Record<string, unknown> = {}): HarnessEvent {
  return { ts: Date.now(), agent: 'claude', projectDir: '/tmp', sessionId: 's1', kind, summary, meta: { taskId, conversationId: convId, ...extra } };
}

describe('ConversationManager 状态机', () => {
  it('首条消息不注入摘要、无 resume', async () => {
    const { tasks, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '第一条消息', 'claude', '/tmp');
    expect(tasks.launched[0]!.prompt).toBe('第一条消息');
    expect(tasks.launched[0]!.resumeSessionId).toBeUndefined();
  });

  it('同 Agent 续接:resumeSessionId 走会话链,不注入摘要', async () => {
    const { tasks, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '一', 'claude', '/tmp');
    m.handleEvent(ev('t1', conv.id, 'session-start', '会话开始'));
    m.handleEvent(ev('t1', conv.id, 'assistant-message', '收到', { fullText: '收到' }));
    m.handleEvent(ev('t1', conv.id, 'task-end', '任务完成', { state: 'done' }));
    await m.send(conv.id, '二', 'claude', '/tmp');
    expect(tasks.launched[1]!.resumeSessionId).toBe('s1');
    expect(tasks.launched[1]!.prompt).toBe('二');
  });

  it('切换 Agent:注入对话摘要且不带 resume', async () => {
    const { tasks, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '第一条消息', 'claude', '/tmp');
    m.handleEvent(ev('t1', conv.id, 'assistant-message', '收到', { fullText: '收到' }));
    m.handleEvent(ev('t1', conv.id, 'task-end', '任务完成', { state: 'done' }));
    await m.send(conv.id, '帮我看看', 'codex', '/tmp');
    expect(tasks.launched[1]!.prompt).toContain('[对话背景]');
    expect(tasks.launched[1]!.prompt).toContain('第一条消息');
    expect(tasks.launched[1]!.resumeSessionId).toBeUndefined();
  });

  it('dsh 无 resume 能力:每条消息注入摘要', async () => {
    const { tasks, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '一', 'dsh', '/tmp');
    expect(tasks.launched[0]!.prompt).toBe('一'); // 首条无历史
    await m.send(conv.id, '二', 'dsh', '/tmp');
    expect(tasks.launched[1]!.prompt).toContain('[对话背景]');
    expect(tasks.launched[1]!.resumeSessionId).toBeUndefined();
  });

  it('事件回填:助手全文入气泡、错误入气泡、无输出补收尾反馈', async () => {
    const { store, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '一', 'codex', '/tmp');
    m.handleEvent(ev('t1', conv.id, 'error', 'Reconnecting... 2/5'));
    m.handleEvent(ev('t1', conv.id, 'task-end', '任务完成', { state: 'done' }));
    const roles = store.msgs.map((x) => x.role);
    expect(roles).toContain('system');
    expect(store.msgs.some((x) => x.content.includes('⚠️ Reconnecting'))).toBe(true);
    // 无助手输出 → 补收尾反馈
    expect(store.msgs.some((x) => x.content.includes('未收到助手输出'))).toBe(true);
  });

  it('助手气泡优先全文(meta.fullText)', async () => {
    const { store, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '一', 'claude', '/tmp');
    m.handleEvent(ev('t1', conv.id, 'assistant-message', '截断'.repeat(50), { fullText: '完整回复'.repeat(50) }));
    const bubble = store.msgs.find((x) => x.role === 'assistant');
    expect(bubble!.content).toBe('完整回复'.repeat(50));
  });

  it('角色卡注入最前置;切换时附团队记忆', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-conv-roles-'));
    try {
      const store = new FakeStore();
      const tasks = new FakeTasks();
      const adapter = (agent: string) => ({ agentId: agent } as AgentAdapter);
      const roles = new RoleStore(path.join(dir, 'roles.json'));
      const memory = new MemoryStore(path.join(dir, 'memory.md'));
      memory.append('跨会话经验:提交前必须跑 typecheck');
      const m = new ConversationManager(store as never, tasks as never, adapter as never, roles, memory);
      const conv = m.create({});
      await m.send(conv.id, '第一条消息', 'claude', '/tmp');
      expect(tasks.launched[0]!.prompt).toContain('[角色设定] 你是「小克」');
      // 切到 dsh:注入摘要应含团队记忆
      await m.send(conv.id, '换个思路', 'dsh', '/tmp');
      expect(tasks.launched[1]!.prompt).toContain('[团队记忆(最近)]');
      expect(tasks.launched[1]!.prompt).toContain('提交前必须跑 typecheck');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('task-start 早于登记时不产生重复气泡', async () => {
    const { store, mgr: m } = mgr();
    const conv = m.create({});
    await m.send(conv.id, '一', 'claude', '/tmp');
    const taskBubbles = store.msgs.filter((x) => x.role === 'task');
    expect(taskBubbles).toHaveLength(1);
  });
});
