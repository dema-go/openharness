/**
 * OpenHarness Server 入口:索引启动、事件流水线、HTTP/WS 服务。
 * 监听 127.0.0.1:3900(仅本机)。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AgentAdapter, AgentId, AgentStatus, HarnessEvent } from '@openharness/core';
import { AGENT_DISPLAY, AGENT_IDS } from '@openharness/core';
import { ClaudeAdapter, CodexAdapter, DshAdapter, CursorAdapter } from '@openharness/agents';
import { broadcast, onMessage } from './bus.js';
import { ConversationManager } from './conversations.js';
import { PresetStore } from './presets.js';
import { createApp } from './routes.js';
import { Store } from './store.js';
import { TaskManager } from './tasks.js';

const PORT = Number(process.env.OPENHARNESS_PORT ?? 3900);
const HOST = process.env.OPENHARNESS_HOST ?? '127.0.0.1';
const DB_PATH = process.env.OPENHARNESS_DB ?? path.join(os.homedir(), '.openharness', 'index.db');

async function main(): Promise<void> {
  const store = new Store(DB_PATH);

  // 事件流水线:所有归一化事件 → 入库 → 广播 → 对话室回填
  // 同时维护 session → model 映射,用量统计按模型归属
  const modelBySession = new Map<string, string>();
  let conversations: ConversationManager | undefined;
  const pipeline = (e: HarnessEvent): void => {
    const key = `${e.agent}:${e.sessionId}`;
    if (typeof e.meta?.model === 'string') {
      modelBySession.set(key, e.meta.model as string);
    }
    const model = modelBySession.get(key);
    let seq: number | undefined;
    try {
      seq = store.insertEvent(model ? { ...e, model } : e);
    } catch (err) {
      console.error('[pipeline] 入库失败:', err);
    }
    // 对话室消息回填(带 taskId 的发射路径事件)
    try {
      conversations?.handleEvent(e);
    } catch (err) {
      console.error('[pipeline] 对话回填失败:', err);
    }
    // 广播时带上入库序号:前端历史分页与实时流共用同一游标,按 seq 去重
    broadcast({ type: 'event', data: { ...e, seq } });
  };

  // 适配器注册表(四个工具全部接入)
  const adapters = new Map<AgentId, AgentAdapter>();
  adapters.set('claude', new ClaudeAdapter(store));
  adapters.set('codex', new CodexAdapter(store));
  adapters.set('dsh', new DshAdapter(store));
  adapters.set('cursor', new CursorAdapter(store));
  const enabledAgents = new Set<AgentId>([...adapters.keys()]);

  // ---- 状态缓存与轮询 ----
  let statuses: AgentStatus[] = AGENT_IDS.map((agent) => disabledStatus(agent));
  async function refreshStatuses(): Promise<void> {
    const next: AgentStatus[] = [];
    for (const agent of AGENT_IDS) {
      const adapter = adapters.get(agent);
      if (!adapter) {
        next.push(disabledStatus(agent));
        continue;
      }
      const running = await adapter.probe().catch(() => false);
      const lastSeenRow = storeLastSeen(agent);
      next.push({
        agent,
        state: running ? 'running' : 'idle',
        enabled: true,
        activeTasks: tasks.activeCount(agent),
        queuedTasks: tasks.queuedCount(agent),
        sessionsCount: store.sessionsCount(agent),
        lastSeen: lastSeenRow,
      });
    }
    statuses = next;
    broadcast({ type: 'status', data: statuses });
  }

  function disabledStatus(agent: AgentId): AgentStatus {
    return {
      agent,
      state: 'disabled',
      enabled: false,
      disabledReason: `${AGENT_DISPLAY[agent]} 适配器尚未接入`,
      activeTasks: 0,
      queuedTasks: 0,
      sessionsCount: 0,
    };
  }

  function storeLastSeen(agent: AgentId): number | undefined {
    const events = store.events({ agent, limit: 1 });
    return events[0]?.ts;
  }

  // 本地设置(桌面通知开关等)
  let notifyEnabled = true;
  try {
    const settingsPath = path.join(os.homedir(), '.openharness', 'settings.json');
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { notifications?: boolean };
      notifyEnabled = s.notifications ?? true;
    }
  } catch {
    /* 缺省开启 */
  }

  const tasks = new TaskManager(pipeline, store, notifyEnabled);
  await tasks.recover();
  conversations = new ConversationManager(store, tasks, (a) => adapters.get(a));

  // ---- 一次性迁移:重建 codex/cursor 会话索引 ----
  // codex:response_item 记录不含 session_id(payload.id 为条目 ID),旧解析器
  // 导致消息事件散落/缺失、消费完的文件重启后把汇总覆盖为 0;
  // cursor:search-db 新增 FTS body 全文轨迹。
  if (!store.getMeta('reindex-v1.2')) {
    console.log('[openharness] 迁移:重建 codex/cursor 会话索引…');
    store.resetAgentIndex('codex', '%/.codex/sessions/%');
    store.resetAgentIndex('cursor', 'cursor-conv:%');
    store.setMeta('reindex-v1.2', String(Date.now()));
  }

  // ---- 启动索引 + 实时监听 ----
  const stopWatches: Array<() => Promise<void>> = [];
  for (const adapter of adapters.values()) {
    console.log(`[openharness] 开始索引 ${adapter.displayName} 会话…`);
    await adapter.indexEvents({
      onEvent: pipeline,
      onSummary: (s) => {
        try {
          store.upsertSession(s);
        } catch (err) {
          console.error('[pipeline] 会话汇总入库失败:', err);
        }
      },
    });
    stopWatches.push(await adapter.watch(pipeline));
    console.log(`[openharness] ${adapter.displayName} 索引完成(${store.sessionsCount(adapter.agentId)} 个会话)。`);
  }

  await refreshStatuses();
  const probeTimer = setInterval(() => void refreshStatuses(), 30_000);
  probeTimer.unref();

  // 任务状态变化时立即刷新状态卡
  onMessage((msg) => {
    if (msg.type === 'task') void refreshStatuses();
  });

  // ---- HTTP + WS ----
  const { app, nodeWs } = createApp({
    store,
    tasks,
    presets: new PresetStore(),
    conversations,
    getAdapter: (a) => adapters.get(a),
    getStatuses: () => statuses,
    enabledAgents,
  });

  // 生产模式:直接托管前端构建产物
  const webDist = path.resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use('*', serveStatic({ root: webDist }));
    app.get('*', serveStatic({ path: path.join(webDist, 'index.html') }));
  }

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[openharness] http://${info.address}:${info.port}  (hostname=${HOST})`);
  });
  nodeWs.injectWebSocket(server);

  const shutdown = async () => {
    console.log('[openharness] 关闭中…');
    clearInterval(probeTimer);
    await Promise.all(stopWatches.map((f) => f()));
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[openharness] 启动失败:', err);
  process.exit(1);
});
