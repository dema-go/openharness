import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId, AgentStatus, HarnessEvent, SessionSummary, TaskInfo } from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentCard } from './components/AgentCard';
import { ConfigPanel } from './components/ConfigPanel';
import { Launcher } from './components/Launcher';
import { SessionsPanel } from './components/SessionsPanel';
import { TopBar } from './components/TopBar';
import { UsagePanel } from './components/UsagePanel';
import { api } from './lib/api';
import { useBus } from './lib/useBus';

const MAX_EVENTS = 500;
const ORDER: AgentId[] = ['claude', 'cursor', 'codex', 'dsh'];

export function App(): React.JSX.Element {
  const [statuses, setStatuses] = useState<AgentStatus[]>([]);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [filter, setFilter] = useState<AgentId | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [tab, setTab] = useState<'feed' | 'sessions' | 'usage' | 'config'>('feed');
  const [clock, setClock] = useState('');
  const pulses = useRef<Record<string, number>>({});

  const refreshSessions = useCallback(() => {
    void api
      .sessions()
      .then((s) => {
        setSessions(s);
        const dirs = [...new Set(s.map((x) => x.projectDir).filter(Boolean))] as string[];
        setProjectDirs(dirs.slice(0, 12));
      })
      .catch(() => undefined);
  }, []);

  // 初始数据
  useEffect(() => {
    void api.agents().then(setStatuses).catch(() => undefined);
    void api.events({ limit: 100 }).then(setEvents).catch(() => undefined);
    void api.tasks().then(setTasks).catch(() => undefined);
    refreshSessions();
  }, [refreshSessions]);

  // 时钟
  useEffect(() => {
    const fmt = () =>
      new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(
        new Date(),
      );
    setClock(fmt());
    const t = setInterval(() => setClock(fmt()), 10_000);
    return () => clearInterval(t);
  }, []);

  const onEvent = useCallback((e: HarnessEvent) => {
    pulses.current[e.agent] = (pulses.current[e.agent] ?? 0) + 1;
    setEvents((prev) => {
      const next = [...prev, e];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }, []);

  const onTask = useCallback((t: TaskInfo) => {
    setTasks((prev) => {
      const rest = prev.filter((x) => x.id !== t.id);
      return [t, ...rest];
    });
    if (t.state !== 'running') {
      refreshSessions();
      // 桌面通知:任务收尾时提醒(页面打开期间)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const label =
          t.state === 'done'
            ? '任务完成'
            : t.state === 'stopped'
              ? '任务已打断'
              : '任务失败';
        try {
          new Notification(`${label} · ${AGENT_DISPLAY[t.agent]}`, { body: t.prompt.slice(0, 120) });
        } catch {
          /* 通知不可用 */
        }
      }
    }
  }, [refreshSessions]);

  const onStatus = useCallback((s: AgentStatus[]) => setStatuses(s), []);
  const connected = useBus({ onEvent, onStatus, onTask });

  const runningCount = tasks.filter((t) => t.state === 'running').length;

  const sorted = [...statuses].sort((a, b) => ORDER.indexOf(a.agent) - ORDER.indexOf(b.agent));

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        connected={connected}
        runningCount={runningCount}
        onLaunch={() => setLauncherOpen(true)}
        clock={clock}
      />

      {/* 窄屏:横向 Agent 状态条 */}
      <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-line p-3 md:hidden">
        {sorted.map((s) => (
          <div key={s.agent} className="flex shrink-0 items-center gap-2 rounded-sm border border-line bg-panel px-3 py-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                s.state === 'running' ? 'bg-amber' : s.state === 'idle' ? 'bg-jade' : 'bg-faint'
              }`}
            />
            <span className="font-display text-[12px] text-paper">{AGENT_DISPLAY[s.agent]}</span>
            <span className="font-mono text-[10px] text-faint">
              {s.state === 'running' ? '运行中' : s.state === 'idle' ? '待命' : '未接入'}
            </span>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[300px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4 md:block">
          {sorted.map((s) => (
            <AgentCard key={s.agent} status={s} pulse={pulses.current[s.agent] ?? 0} />
          ))}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
            <button
              type="button"
              onClick={() => setTab('feed')}
              className={`rounded-sm px-2.5 py-1 font-display text-[13px] transition-colors ${
                tab === 'feed' ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              活动流
            </button>
            <button
              type="button"
              onClick={() => setTab('sessions')}
              className={`rounded-sm px-2.5 py-1 font-display text-[13px] transition-colors ${
                tab === 'sessions' ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              会话索引
            </button>
            <button
              type="button"
              onClick={() => setTab('usage')}
              className={`rounded-sm px-2.5 py-1 font-display text-[13px] transition-colors ${
                tab === 'usage' ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              用量
            </button>
            <button
              type="button"
              onClick={() => setTab('config')}
              className={`rounded-sm px-2.5 py-1 font-display text-[13px] transition-colors ${
                tab === 'config' ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              配置
            </button>
          </div>
          {tab === 'feed' ? (
            <ActivityFeed
              events={events}
              filter={filter}
              onFilter={setFilter}
              paused={paused}
              onTogglePause={() => setPaused((p) => !p)}
            />
          ) : tab === 'sessions' ? (
            <SessionsPanel sessions={sessions} />
          ) : tab === 'usage' ? (
            <UsagePanel />
          ) : (
            <ConfigPanel />
          )}
        </main>
      </div>

      <Launcher
        open={launcherOpen}
        statuses={statuses}
        projectDirs={projectDirs}
        tasks={tasks}
        onClose={() => setLauncherOpen(false)}
        onTask={onTask}
      />
    </div>
  );
}
