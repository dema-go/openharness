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
import { openInTerminal } from './terminal.js';

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
    const session = c.req.query('session');
    const sinceSeq = c.req.query('sinceSeq');
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(
      store.events({
        agent,
        session,
        limit: Number.isFinite(limit) ? limit : 100,
        sinceSeq: sinceSeq ? Number(sinceSeq) : undefined,
      }),
    );
  });

  app.get('/api/tasks', (c) => c.json(tasks.list()));

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{ agent?: string; cwd?: string; prompt?: string; model?: string; queue?: boolean }>();
    const agent = body.agent as TaskInfo['agent'] | undefined;
    if (!agent || !AGENT_DISPLAY[agent]) return c.json({ error: '未知的 Agent' }, 400);
    if (!enabledAgents.has(agent)) return c.json({ error: `${AGENT_DISPLAY[agent]} 适配器尚未接入` }, 400);
    if (!body.cwd || !body.prompt?.trim()) return c.json({ error: 'cwd 与 prompt 为必填' }, 400);
    if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
      return c.json({ error: `目录不存在:${body.cwd}` }, 400);
    }
    const adapter = getAdapter(agent)!;
    const opts = { cwd: body.cwd, prompt: body.prompt.trim(), model: body.model };
    const info = body.queue
      ? await tasks.enqueue(adapter, opts)
      : await tasks.start(adapter, opts);
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

  app.get('/api/usage', (c) => c.json(store.usage()));

  // 配置只读摘要(结构化 + 密钥脱敏)
  app.get('/api/config', async (c) => {
    const agent = c.req.query('agent');
    const list = agent ? [getAdapter(agent as TaskInfo['agent'])] : [...enabledAgents].map((a) => getAdapter(a));
    const out = [];
    for (const adapter of list) {
      if (!adapter) continue;
      try {
        out.push(await adapter.describeConfig());
      } catch (err) {
        out.push({ agent: adapter.agentId, sections: [], notes: [`读取配置失败:${err instanceof Error ? err.message : String(err)}`] });
      }
    }
    return c.json(out);
  });

  // 深链:在新 Terminal 窗口中执行原生工具的恢复命令(仅本机,用户触发)
  app.post('/api/deeplink', async (c) => {
    const body = await c.req.json<{ agent?: string; sessionId?: string }>();
    const adapter = body.agent ? getAdapter(body.agent as TaskInfo['agent']) : undefined;
    if (!adapter || !body.sessionId) return c.json({ error: '参数无效' }, 400);
    const command = adapter.resumeCommand(body.sessionId);
    try {
      await openInTerminal(command);
      return c.json({ ok: true, command });
    } catch (err) {
      return c.json(
        { error: `无法打开终端:${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
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
