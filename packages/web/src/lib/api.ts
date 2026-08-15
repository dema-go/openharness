import type { AgentStatus, HarnessEvent, SessionSummary, TaskInfo } from '@openharness/core';

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
  events: (opts: { agent?: string; session?: string; sinceSeq?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.agent) p.set('agent', opts.agent);
    if (opts.session) p.set('session', opts.session);
    if (opts.sinceSeq !== undefined) p.set('sinceSeq', String(opts.sinceSeq));
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    const q = p.toString();
    return j<HarnessEvent[]>(`/events${q ? `?${q}` : ''}`);
  },
  tasks: () => j<TaskInfo[]>('/tasks'),
  startTask: (body: { agent: string; cwd: string; prompt: string; model?: string; queue?: boolean }) =>
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
  usage: () => j<UsageReport>('/usage'),
  config: () => j<AgentConfigInfo[]>('/config'),
  openInTerminal: (agent: string, sessionId: string) =>
    j<{ ok: boolean; command: string }>('/deeplink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, sessionId }),
    }),
};
