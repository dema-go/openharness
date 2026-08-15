import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentId,
  AgentStatus,
  ConversationMessage,
  HarnessEvent,
  SessionSummary,
  TaskInfo,
} from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentCard } from './components/AgentCard';
import { ConfigPanel } from './components/ConfigPanel';
import { ConversationPanel } from './components/ConversationPanel';
import { Launcher } from './components/Launcher';
import { SessionsPanel } from './components/SessionsPanel';
import { TopBar } from './components/TopBar';
import { UsagePanel } from './components/UsagePanel';
import { api } from './lib/api';
import { useBus } from './lib/useBus';

const MAX_EVENTS = 500;
const MAX_CONV_LIVE = 300;
const ORDER: AgentId[] = ['claude', 'cursor', 'codex', 'dsh'];
const TABS = [
  { id: 'feed', label: '实时活动流' },
  { id: 'conversations', label: '对话室' },
  { id: 'sessions', label: '会话档案' },
  { id: 'usage', label: '用量账本' },
  { id: 'config', label: '配置速览' },
] as const;

export function App(): React.JSX.Element {
  const [statuses, setStatuses] = useState<AgentStatus[]>([]);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [tab, setTab] = useState<'feed' | 'conversations' | 'sessions' | 'usage' | 'config'>('feed');
  const [convLive, setConvLive] = useState<Array<{ convId: string; message: ConversationMessage }>>([]);
  const [pendingConvId, setPendingConvId] = useState<string | null>(null);
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

  // 初始数据(活动流历史由 ActivityFeed 自行分页拉取,这里只接实时流)
  useEffect(() => {
    void api.agents().then(setStatuses).catch(() => undefined);
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
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const label = t.state === 'done' ? '任务完成' : t.state === 'stopped' ? '任务已打断' : '任务失败';
        try {
          new Notification(`${label} · ${AGENT_DISPLAY[t.agent]}`, { body: t.prompt.slice(0, 120) });
        } catch {
          /* 通知不可用 */
        }
      }
    }
  }, [refreshSessions]);

  const onStatus = useCallback((s: AgentStatus[]) => setStatuses(s), []);

  const onConversation = useCallback((d: { convId: string; message: ConversationMessage }) => {
    setConvLive((prev) => {
      const next = [...prev, d];
      return next.length > MAX_CONV_LIVE ? next.slice(next.length - MAX_CONV_LIVE) : next;
    });
  }, []);

  const connected = useBus({ onEvent, onStatus, onTask, onConversation });

  /** 会话档案「对话室续聊」:创建/绑定对话并跳转 */
  const resumeInConversation = useCallback(
    async (agent: AgentId, sessionId: string, cwd: string | null, title: string) => {
      try {
        const conv = await api.createConversation({
          title: `续聊:${title.slice(0, 30)}`,
          agent,
          sessionId,
          cwd: cwd ?? undefined,
        });
        setPendingConvId(conv.id);
        setTab('conversations');
      } catch {
        setPendingConvId(null);
      }
    },
    [],
  );

  const runningCount = tasks.filter((t) => t.state === 'running').length;
  const sorted = [...statuses].sort((a, b) => ORDER.indexOf(a.agent) - ORDER.indexOf(b.agent));

  return (
    <div className="flex h-screen flex-col bg-page text-ink">
      <TopBar
        connected={connected}
        runningCount={runningCount}
        onLaunch={() => setLauncherOpen(true)}
        clock={clock}
      />

      {/* 窄屏:横向特工条 */}
      <div className="flex shrink-0 gap-2 overflow-x-auto border-b-[3px] border-ink px-3 py-2.5 md:hidden">
        {sorted.map((s) => (
          <div
            key={s.agent}
            className="flex shrink-0 items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 py-1.5"
            style={{ boxShadow: '2px 2px 0 #221D15' }}
          >
            <span
              className={`h-2.5 w-2.5 rounded-full border-2 border-ink ${
                s.state === 'running' ? 'bg-red' : s.state === 'idle' ? 'bg-green' : 'bg-faint'
              }`}
            />
            <span className="font-display text-[12px]">{AGENT_DISPLAY[s.agent]}</span>
            <span className="font-mono text-[9.5px] text-faint">
              {s.state === 'running' ? '干活中' : s.state === 'idle' ? '待命' : '未接入'}
            </span>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="halftone hidden w-[308px] shrink-0 space-y-3.5 overflow-y-auto border-r-[3px] border-ink p-4 md:block">
          <h2 className="font-display text-[16px] text-ink">特工小队</h2>
          {sorted.map((s, i) => (
            <AgentCard key={s.agent} status={s} pulse={pulses.current[s.agent] ?? 0} index={i} />
          ))}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-end gap-2 px-4 pt-3">
            {TABS.map((t, i) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded-t-xl border-[3px] border-b-0 border-ink px-4 py-1.5 font-display text-[13.5px] transition-colors ${
                    active ? 'bg-white' : 'bg-panel2/60 hover:bg-panel2'
                  } ${i % 2 === 1 ? 'translate-y-[3px]' : ''}`}
                  style={active ? { boxShadow: '0 -3px 0 #fff' } : undefined}
                >
                  {active && <span className="mr-1.5 text-red">★</span>}
                  {t.label}
                </button>
              );
            })}
          </div>
          {/* flex 容器必须加 flex:否则面板根节点(flex-1)无法被高度约束,长内容把整页撑爆 */}
          <div className="flex min-h-0 flex-1">
            {tab === 'feed' ? (
              <ActivityFeed
                liveEvents={events}
                paused={paused}
                onTogglePause={() => setPaused((p) => !p)}
              />
            ) : tab === 'conversations' ? (
              <ConversationPanel
                liveMessages={convLive}
                projectDirs={projectDirs}
                tasks={tasks}
                initialConvId={pendingConvId}
                onTask={onTask}
              />
            ) : tab === 'sessions' ? (
              <SessionsPanel sessions={sessions} onResume={resumeInConversation} />
            ) : tab === 'usage' ? (
              <UsagePanel />
            ) : (
              <ConfigPanel />
            )}
          </div>
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
