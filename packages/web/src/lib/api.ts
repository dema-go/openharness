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

export const api = {
  agents: () => j<AgentStatus[]>('/agents'),
  sessions: (agent?: string) => j<SessionSummary[]>(`/sessions${agent ? `?agent=${agent}` : ''}`),
  events: (opts: { agent?: string; sinceSeq?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.agent) p.set('agent', opts.agent);
    if (opts.sinceSeq !== undefined) p.set('sinceSeq', String(opts.sinceSeq));
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    const q = p.toString();
    return j<HarnessEvent[]>(`/events${q ? `?${q}` : ''}`);
  },
  tasks: () => j<TaskInfo[]>('/tasks'),
  startTask: (body: { agent: string; cwd: string; prompt: string; model?: string }) =>
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
};
