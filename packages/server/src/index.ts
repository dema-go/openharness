/**
 * OpenHarness Server 入口:索引启动、事件流水线、HTTP/WS 服务。
 * 监听 127.0.0.1:3900(仅本机)。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AgentAdapter, AgentId, AgentStatus, HarnessEvent } from '@openharness/core';
import { AGENT_DISPLAY, AGENT_IDS } from '@openharness/core';
import { ClaudeAdapter } from '@openharness/agents';
import { broadcast, onMessage } from './bus.js';
import { createApp } from './routes.js';
import { Store } from './store.js';
import { TaskManager } from './tasks.js';

const PORT = Number(process.env.OPENHARNESS_PORT ?? 3900);
const HOST = process.env.OPENHARNESS_HOST ?? '127.0.0.1';
const DB_PATH = process.env.OPENHARNESS_DB ?? path.join(os.homedir(), '.openharness', 'index.db');

async function main(): Promise<void> {
  const store = new Store(DB_PATH);

  // 事件流水线:所有归一化事件 → 入库 → 广播
  const pipeline = (e: HarnessEvent): void => {
    try {
      store.insertEvent(e);
    } catch (err) {
      console.error('[pipeline] 入库失败:', err);
    }
    broadcast({ type: 'event', data: e });
  };

  // 适配器注册表(v0.1 仅 Claude Code;其余显示为未接入)
  const adapters = new Map<AgentId, AgentAdapter>();
  adapters.set('claude', new ClaudeAdapter(store));
  const enabledAgents = new Set<AgentId>(['claude']);

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
      disabledReason: `${AGENT_DISPLAY[agent]} 适配器尚未接入(v0.1 仅 Claude Code)`,
      activeTasks: 0,
      sessionsCount: 0,
    };
  }

  function storeLastSeen(agent: AgentId): number | undefined {
    const events = store.events({ agent, limit: 1 });
    return events[0]?.ts;
  }

  const tasks = new TaskManager(
    (agent) => adapters.get(agent),
    pipeline,
  );

  // ---- 启动索引 + 实时监听 ----
  console.log('[openharness] 开始索引 Claude Code 会话…');
  const claude = adapters.get('claude')!;
  await claude.indexEvents({
    onEvent: pipeline,
    onSummary: (s) => {
      try {
        store.upsertSession(s);
      } catch (err) {
        console.error('[pipeline] 会话汇总入库失败:', err);
      }
    },
  });
  const stopWatch = await claude.watch(pipeline);
  console.log('[openharness] 索引完成,已开始实时监听。');

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
    await stopWatch();
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
