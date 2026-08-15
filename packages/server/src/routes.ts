/**
 * HTTP/WebSocket 路由:控制台 API。
 * REST:状态、会话、事件、任务、建议;WS:/ws 推送实时消息。
 */
import { existsSync, statSync } from 'node:fs';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AgentAdapter, AgentStatus, TaskInfo } from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { onMessage, type BusMessage } from './bus.js';
import type { Store } from './store.js';
import { suggest, type Suggestion } from './suggest.js';
import type { TaskManager } from './tasks.js';

export interface AppDeps {
  store: Store;
  tasks: TaskManager;
  getAdapter: (agent: TaskInfo['agent']) => AgentAdapter | undefined;
  getStatuses: () => AgentStatus[];
  enabledAgents: Set<TaskInfo['agent']>;
}

export function createApp(deps: AppDeps): { app: Hono; nodeWs: NodeWebSocket } {
  const { store, tasks, getAdapter, getStatuses, enabledAgents } = deps;
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });

  app.get('/api/health', (c) => c.json({ ok: true, time: Date.now() }));

  app.get('/api/agents', (c) => c.json(getStatuses()));

  app.get('/api/sessions', (c) => {
    const agent = c.req.query('agent');
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(store.sessions({ agent, limit: Number.isFinite(limit) ? limit : 100 }));
  });

  app.get('/api/events', (c) => {
    const agent = c.req.query('agent');
    const sinceSeq = c.req.query('sinceSeq');
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(
      store.events({
        agent,
        limit: Number.isFinite(limit) ? limit : 100,
        sinceSeq: sinceSeq ? Number(sinceSeq) : undefined,
      }),
    );
  });

  app.get('/api/tasks', (c) => c.json(tasks.list()));

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{ agent?: string; cwd?: string; prompt?: string; model?: string }>();
    const agent = body.agent as TaskInfo['agent'] | undefined;
    if (!agent || !AGENT_DISPLAY[agent]) return c.json({ error: '未知的 Agent' }, 400);
    if (!enabledAgents.has(agent)) return c.json({ error: `${AGENT_DISPLAY[agent]} 适配器尚未接入(v0.1 仅 Claude Code)` }, 400);
    if (!body.cwd || !body.prompt?.trim()) return c.json({ error: 'cwd 与 prompt 为必填' }, 400);
    if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
      return c.json({ error: `目录不存在:${body.cwd}` }, 400);
    }
    const info = await tasks.start(getAdapter(agent)!, {
      cwd: body.cwd,
      prompt: body.prompt.trim(),
      model: body.model,
    });
    return c.json(info, 201);
  });

  app.post('/api/tasks/:id/stop', async (c) => {
    const info = await tasks.stop(c.req.param('id'));
    if (!info) return c.json({ error: '任务不存在' }, 404);
    return c.json(info);
  });

  app.get('/api/suggest', (c) => {
    const prompt = c.req.query('prompt') ?? '';
    const result: Suggestion[] = suggest(prompt, enabledAgents);
    return c.json(result);
  });
  const { upgradeWebSocket } = nodeWs;
  const disposers = new WeakMap<WSContext, () => void>();

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen: (_evt, wsCtx) => {
        // 先补发最近 30 条历史,再接实时流
        for (const e of store.events({ limit: 30 })) {
          wsCtx.send(JSON.stringify({ type: 'event', data: e } satisfies BusMessage));
        }
        wsCtx.send(JSON.stringify({ type: 'status', data: getStatuses() } satisfies BusMessage));
        const off = onMessage((msg: BusMessage) => {
          try {
            wsCtx.send(JSON.stringify(msg));
          } catch {
            /* 连接已断开 */
          }
        });
        disposers.set(wsCtx, off);
      },
      onClose: (_evt, wsCtx) => {
        disposers.get(wsCtx)?.();
        disposers.delete(wsCtx);
      },
    })),
  );

  return { app, nodeWs };
}
