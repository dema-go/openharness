/**
 * HTTP/WebSocket 路由:控制台 API。
 * REST:状态、会话、事件、任务、建议;WS:/ws 推送实时消息。
 */
import { existsSync, statSync } from 'node:fs';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AgentAdapter, AgentStatus, HarnessEvent, TaskInfo } from '@openharness/core';
import { AGENT_DISPLAY, EVENT_KIND_LABEL } from '@openharness/core';
import { onMessage, type BusMessage } from './bus.js';
import type { ConversationManager } from './conversations.js';
import type { PresetStore } from './presets.js';
import type { Store } from './store.js';
import { suggest, type Suggestion } from './suggest.js';
import type { TaskManager } from './tasks.js';
import { openInTerminal } from './terminal.js';

export interface AppDeps {
  store: Store;
  tasks: TaskManager;
  presets: PresetStore;
  conversations: ConversationManager;
  getAdapter: (agent: TaskInfo['agent']) => AgentAdapter | undefined;
  getStatuses: () => AgentStatus[];
  enabledAgents: Set<TaskInfo['agent']>;
}

export function createApp(deps: AppDeps): { app: Hono; nodeWs: NodeWebSocket } {
  const { store, tasks, presets, conversations, getAdapter, getStatuses, enabledAgents } = deps;
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
    const beforeSeq = c.req.query('beforeSeq');
    const kindParam = c.req.query('kind');
    const q = c.req.query('q')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 100);
    const kinds =
      kindParam
        ?.split(',')
        .map((k) => k.trim())
        .filter((k): k is HarnessEvent['kind'] => k in EVENT_KIND_LABEL) ?? undefined;
    return c.json(
      store.eventsPage({
        agent,
        session,
        limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
        sinceSeq: sinceSeq ? Number(sinceSeq) : undefined,
        beforeSeq: beforeSeq ? Number(beforeSeq) : undefined,
        kinds,
        q,
      }),
    );
  });

  app.get('/api/tasks', (c) => c.json(tasks.list()));

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{
      agent?: string;
      cwd?: string;
      prompt?: string;
      model?: string;
      queue?: boolean;
      bypassPermissions?: boolean;
      conversationId?: string;
    }>();
    const agent = body.agent as TaskInfo['agent'] | undefined;
    if (!agent || !AGENT_DISPLAY[agent]) return c.json({ error: '未知的 Agent' }, 400);
    if (!enabledAgents.has(agent)) return c.json({ error: `${AGENT_DISPLAY[agent]} 适配器尚未接入` }, 400);
    if (!body.cwd || !body.prompt?.trim()) return c.json({ error: 'cwd 与 prompt 为必填' }, 400);
    if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
      return c.json({ error: `目录不存在:${body.cwd}` }, 400);
    }
    const adapter = getAdapter(agent)!;
    const opts = {
      cwd: body.cwd,
      prompt: body.prompt.trim(),
      model: body.model,
      bypassPermissions: body.bypassPermissions === true,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
    };
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

  // 用量聚合:days=7|14|30|90|0(0/缺省=全部),或 from/to(ms)自定义起止
  app.get('/api/usage', (c) => {
    const days = Number(c.req.query('days') ?? '0');
    const fromQ = c.req.query('from');
    const toQ = c.req.query('to');
    const now = Date.now();
    let from: number | undefined;
    let to: number | undefined;
    if (fromQ || toQ) {
      from = fromQ && Number.isFinite(Number(fromQ)) ? Number(fromQ) : undefined;
      to = toQ && Number.isFinite(Number(toQ)) ? Number(toQ) : undefined;
    } else if (Number.isFinite(days) && days > 0) {
      from = now - days * 86400_000;
      to = now;
    }
    return c.json(store.usage({ from, to }));
  });

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

  // 可编辑字段 schema(secret 值已脱敏)
  app.get('/api/config/:agent/schema', async (c) => {
    const adapter = getAdapter(c.req.param('agent') as TaskInfo['agent']);
    if (!adapter) return c.json({ error: '未知的 Agent' }, 404);
    try {
      return c.json(await adapter.configSchema());
    } catch (err) {
      return c.json({ error: `读取配置失败:${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // 写入配置:secret 字段只接受"新值"(留空不改)
  app.put('/api/config/:agent', async (c) => {
    const adapter = getAdapter(c.req.param('agent') as TaskInfo['agent']);
    if (!adapter) return c.json({ error: '未知的 Agent' }, 404);
    const body = await c.req.json<{ values?: Record<string, string> }>();
    if (!body.values || Object.keys(body.values).length === 0) {
      return c.json({ error: 'values 为必填' }, 400);
    }
    try {
      const { applied } = await adapter.updateConfig(body.values);
      return c.json({ ok: true, applied });
    } catch (err) {
      return c.json({ error: `写入配置失败:${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // ---- 配置预设(cc switch 式) ----
  app.get('/api/presets', (c) => c.json(presets.list(c.req.query('agent'))));

  app.post('/api/presets', async (c) => {
    const body = await c.req.json<{ name?: string; agent?: string; values?: Record<string, string> }>();
    const adapter = body.agent ? getAdapter(body.agent as TaskInfo['agent']) : undefined;
    if (!adapter || !enabledAgents.has(adapter.agentId)) return c.json({ error: '未知的 Agent' }, 400);
    let values = body.values;
    if (!values) {
      // 未显式给值:对当前配置做快照
      try {
        values = await adapter.getConfigValues();
      } catch (err) {
        return c.json({ error: `快照失败:${err instanceof Error ? err.message : String(err)}` }, 500);
      }
    }
    return c.json(presets.create(body.name ?? '', adapter.agentId, values), 201);
  });

  app.post('/api/presets/:id/apply', async (c) => {
    const preset = presets.getPlain(c.req.param('id'));
    if (!preset) return c.json({ error: '预设不存在' }, 404);
    const adapter = getAdapter(preset.agent);
    if (!adapter) return c.json({ error: `${AGENT_DISPLAY[preset.agent]} 适配器未接入` }, 400);
    try {
      const { applied } = await adapter.updateConfig(preset.values);
      return c.json({ ok: true, preset: preset.name, applied });
    } catch (err) {
      return c.json({ error: `应用预设失败:${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.delete('/api/presets/:id', (c) => {
    if (!presets.delete(c.req.param('id'))) return c.json({ error: '预设不存在' }, 404);
    return c.json({ ok: true });
  });

  // ---- 对话室 ----
  app.get('/api/conversations', (c) => c.json(conversations.list()));

  app.post('/api/conversations', async (c) => {
    const body = await c.req.json<{ title?: string; agent?: string; sessionId?: string; cwd?: string }>();
    if (body.agent && !AGENT_DISPLAY[body.agent as TaskInfo['agent']]) {
      return c.json({ error: '未知的 Agent' }, 400);
    }
    try {
      return c.json(
        conversations.create({
          title: body.title,
          agent: body.agent as TaskInfo['agent'] | undefined,
          sessionId: body.sessionId,
          cwd: body.cwd,
        }),
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '创建失败' }, 500);
    }
  });

  app.get('/api/conversations/:id/messages', (c) => {
    const beforeSeq = c.req.query('beforeSeq');
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(
      conversations.messages(c.req.param('id'), {
        limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 300) : 100,
        beforeSeq: beforeSeq ? Number(beforeSeq) : undefined,
      }),
    );
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const body = await c.req.json<{
      content?: string;
      agent?: string;
      cwd?: string;
      bypassPermissions?: boolean;
    }>();
    const agent = body.agent as TaskInfo['agent'] | undefined;
    if (!agent || !AGENT_DISPLAY[agent]) return c.json({ error: '未知的 Agent' }, 400);
    try {
      const { message, task } = await conversations.send(
        c.req.param('id'),
        body.content ?? '',
        agent,
        body.cwd ?? '',
        { bypassPermissions: body.bypassPermissions === true },
      );
      return c.json({ message, task }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : '发送失败' }, 400);
    }
  });

  app.post('/api/conversations/:id/stop', async (c) => {
    const stopped = await conversations.stop(c.req.param('id'));
    if (!stopped) return c.json({ error: '对话中没有运行中的任务' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/conversations/:id', (c) => {
    if (!conversations.delete(c.req.param('id'))) return c.json({ error: '对话不存在' }, 404);
    return c.json({ ok: true });
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
