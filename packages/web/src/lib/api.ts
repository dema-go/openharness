import type {
  AgentPresetPublic,
  AgentStatus,
  ConfigFieldDef,
  ConversationMessage,
  ConversationSummary,
  EventKind,
  HarnessEvent,
  SessionSummary,
  TaskInfo,
} from '@openharness/core';

const BASE = '/api';

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败(${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface UsageReport {
  total: { input: number; output: number };
  toolCalls: number;
  byAgent: Array<{ agent: string; input: number; output: number }>;
  byModel: Array<{ model: string; agent: string; input: number; output: number }>;
  byDay: Array<{ day: string; input: number; output: number }>;
  byProject: Array<{ project: string; input: number; output: number }>;
}

export interface AgentConfigInfo {
  agent: string;
  sections: Array<{ title: string; items: Array<{ key: string; value: string; masked?: boolean }> }>;
  notes?: string[];
}

export const api = {
  agents: () => j<AgentStatus[]>('/agents'),
  sessions: (agent?: string) => j<SessionSummary[]>(`/sessions${agent ? `?agent=${agent}` : ''}`),
  events: (opts: {
    agent?: string;
    session?: string;
    sinceSeq?: number;
    beforeSeq?: number;
    kinds?: EventKind[];
    q?: string;
    limit?: number;
  } = {}) => {
    const p = new URLSearchParams();
    if (opts.agent) p.set('agent', opts.agent);
    if (opts.session) p.set('session', opts.session);
    if (opts.sinceSeq !== undefined) p.set('sinceSeq', String(opts.sinceSeq));
    if (opts.beforeSeq !== undefined) p.set('beforeSeq', String(opts.beforeSeq));
    if (opts.kinds && opts.kinds.length > 0) p.set('kind', opts.kinds.join(','));
    if (opts.q) p.set('q', opts.q);
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    const q = p.toString();
    return j<{ events: HarnessEvent[]; hasMore: boolean }>(`/events${q ? `?${q}` : ''}`);
  },
  tasks: () => j<TaskInfo[]>('/tasks'),
  startTask: (body: {
    agent: string;
    cwd: string;
    prompt: string;
    model?: string;
    queue?: boolean;
    bypassPermissions?: boolean;
  }) =>
    j<TaskInfo>('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  stopTask: (id: string) => j<TaskInfo>(`/tasks/${id}/stop`, { method: 'POST' }),
  suggest: (prompt: string) =>
    j<Array<{ agent: string; display: string; score: number; reasons: string[]; capability: string; enabled: boolean }>>(
      `/suggest?prompt=${encodeURIComponent(prompt)}`,
    ),
  usage: (range?: { days?: number; from?: number; to?: number }) => {
    const p = new URLSearchParams();
    if (range?.days) p.set('days', String(range.days));
    if (range?.from !== undefined) p.set('from', String(range.from));
    if (range?.to !== undefined) p.set('to', String(range.to));
    const q = p.toString();
    return j<UsageReport>(`/usage${q ? `?${q}` : ''}`);
  },
  config: () => j<AgentConfigInfo[]>('/config'),
  configSchema: (agent: string) => j<ConfigFieldDef[]>(`/config/${agent}/schema`),
  updateConfig: (agent: string, values: Record<string, string>) =>
    j<{ ok: boolean; applied: string[] }>(`/config/${agent}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  presets: (agent?: string) => j<AgentPresetPublic[]>(`/presets${agent ? `?agent=${agent}` : ''}`),
  savePreset: (body: { name: string; agent: string; values?: Record<string, string> }) =>
    j<AgentPresetPublic>('/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  applyPreset: (id: string) =>
    j<{ ok: boolean; preset: string; applied: string[] }>(`/presets/${id}/apply`, { method: 'POST' }),
  deletePreset: (id: string) => j<{ ok: boolean }>(`/presets/${id}`, { method: 'DELETE' }),
  openInTerminal: (agent: string, sessionId: string) =>
    j<{ ok: boolean; command: string }>('/deeplink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, sessionId }),
    }),
  conversations: () => j<ConversationSummary[]>('/conversations'),
  createConversation: (body: { title?: string; agent?: string; sessionId?: string; cwd?: string }) =>
    j<ConversationSummary>('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  conversationMessages: (id: string, opts: { beforeSeq?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.beforeSeq !== undefined) p.set('beforeSeq', String(opts.beforeSeq));
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    const q = p.toString();
    return j<{ messages: ConversationMessage[]; hasMore: boolean }>(`/conversations/${id}/messages${q ? `?${q}` : ''}`);
  },
  sendConversationMessage: (id: string, body: { content: string; agent: string; cwd: string; bypassPermissions?: boolean }) =>
    j<{ message: ConversationMessage; task: TaskInfo }>(`/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  stopConversationTask: (id: string) =>
    j<{ ok: boolean }>(`/conversations/${id}/stop`, { method: 'POST' }),
  deleteConversation: (id: string) =>
    j<{ ok: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),
};
