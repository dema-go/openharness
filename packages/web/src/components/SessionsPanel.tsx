import { useCallback, useEffect, useState } from 'react';
import type { AgentId, HarnessEvent, SessionSummary } from '@openharness/core';
import { EVENT_KIND_LABEL } from '@openharness/core';
import { api } from '../lib/api';
import { AGENT_CHARACTER, AgentAvatar } from './ComicIcons';

const KIND_STICKER: Record<HarnessEvent['kind'], string> = {
  'session-start': 'bg-orange',
  'session-end': 'bg-faint text-white',
  'user-message': 'bg-white',
  'assistant-message': 'bg-blue text-white',
  'tool-call': 'bg-yellow',
  'file-edit': 'bg-cyan text-white',
  'error': 'bg-red text-white',
  'mode-change': 'bg-purple text-white',
  'task-start': 'bg-red text-white',
  'task-end': 'bg-green text-white',
};

function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ts);
}

function basename(p: string | null): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

export function SessionsPanel(props: {
  onResume: (agent: AgentId, sessionId: string, cwd: string | null, title: string) => void;
}): React.JSX.Element {
  const { onResume } = props;
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [agentFilter, setAgentFilter] = useState<AgentId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  const fetchPage = useCallback(async (q: string, agent: AgentId | 'all', empty: boolean) => {
    const opts: Parameters<typeof api.sessions>[0] = { limit: 100 };
    if (agent !== 'all') opts.agent = agent;
    if (q.trim()) opts.q = q.trim();
    if (empty) opts.includeEmpty = true;
    try {
      const res = await api.sessions(opts);
      setSessions(res.sessions);
      setTotal(res.total);
    } catch {
      setSessions([]);
      setTotal(0);
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!sessions || sessions.length === 0 || loadingOlder) return;
    const oldest = Math.min(...sessions.map((s) => s.lastTs));
    setLoadingOlder(true);
    try {
      const res = await api.sessions({
        agent: agentFilter === 'all' ? undefined : agentFilter,
        q: query.trim() || undefined,
        includeEmpty: includeEmpty || undefined,
        before: oldest,
        limit: 100,
      });
      setSessions((prev) => {
        const seen = new Set((prev ?? []).map((s) => `${s.agent}:${s.sessionId}`));
        return [...(prev ?? []), ...res.sessions.filter((s) => !seen.has(`${s.agent}:${s.sessionId}`))];
      });
      setTotal(res.total);
    } catch {
      /* 忽略 */
    } finally {
      setLoadingOlder(false);
    }
  }, [sessions, loadingOlder, agentFilter, query, includeEmpty]);

  // 筛选/搜索/空会话开关变化:重置为第一页(搜索防抖 300ms)
  useEffect(() => {
    const t = setTimeout(() => {
      setSessions(null);
      void fetchPage(query, agentFilter, includeEmpty);
    }, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchPage, query, agentFilter, includeEmpty]);

  const hasMore = sessions !== null && sessions.length < total;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="comic-card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b-[3px] border-ink px-4">
          <h2 className="font-display text-[15px] text-ink">会话档案</h2>
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {sessions === null ? '…' : `已加载 ${sessions.length} / 共 ${total}`}
          </span>
          <div className="ml-3 flex flex-wrap items-center gap-1.5">
            {(['all', 'claude', 'codex', 'cursor', 'dsh'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setAgentFilter(f)}
                className={`rounded-md border-2 border-ink px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  agentFilter === f ? 'bg-yellow text-ink' : 'bg-white text-dim hover:bg-panel2'
                }`}
                style={agentFilter === f ? { boxShadow: '2px 2px 0 #221D15' } : undefined}
              >
                {f === 'all' ? '全部' : f}
              </button>
            ))}
          </div>
          <label className="ml-1 flex cursor-pointer items-center gap-1" title="默认隐藏消息数为 0 的空会话(多为残留的空 rollout 文件)">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
              className="h-3.5 w-3.5 accent-red"
            />
            <span className="font-mono text-[10px] text-dim">含空会话</span>
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜标题 / 项目 / 会话 ID(全量)"
            className="comic-input ml-auto w-64 py-1 text-[11px] max-sm:w-32"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions === null ? (
            <div className="flex h-full items-center justify-center">
              <p className="font-mono text-[12px] text-faint">翻档案中…</p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <div className="bubble font-display text-[13px] text-ink">
                档案柜空空的!换个筛选,或去特工那里开一段新会话~
              </div>
            </div>
          ) : (
            <>
              <ul className="p-3">
                {sessions.map((s) => (
                  <li key={`${s.agent}-${s.sessionId}`} className="mb-2 last:mb-0">
                    <button
                      type="button"
                      onClick={() => setSelected(s)}
                      className="flex w-full items-center gap-3 rounded-xl border-[3px] border-ink bg-white px-3 py-2.5 text-left transition-colors hover:bg-panel2"
                      style={{ boxShadow: '2px 2px 0 #221D15' }}
                    >
                      <AgentAvatar agent={s.agent} size={34} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-[13.5px] text-ink">{s.title}</span>
                        <span className="block truncate font-mono text-[10.5px] text-faint">
                          {AGENT_CHARACTER[s.agent].name} · {basename(s.projectDir) || '—'}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                        {s.messageCount} 条
                      </span>
                      <span className="w-[96px] shrink-0 text-right font-mono text-[10.5px] text-faint tabular-nums">
                        {fmtTime(s.lastTs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="block w-full border-t-2 border-dashed border-faint/50 py-1.5 text-center font-mono text-[11px] text-dim transition-colors hover:text-ink disabled:opacity-40"
                >
                  {loadingOlder ? '翻旧档中…' : '▼ 加载更早'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {selected && (
        <SessionDetail
          session={selected}
          onClose={() => setSelected(null)}
          onResume={onResume}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(selected.resumeCommand);
            } catch {
              /* 剪贴板不可用 */
            }
          }}
        />
      )}
    </div>
  );
}

function SessionDetail(props: {
  session: SessionSummary;
  onClose: () => void;
  onResume: (agent: AgentId, sessionId: string, cwd: string | null, title: string) => void;
  onCopy: () => Promise<void>;
}): React.JSX.Element {
  const { session } = props;
  const [events, setEvents] = useState<HarnessEvent[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .events({ agent: session.agent, session: session.sessionId, limit: 100 })
      .then((page) => {
        if (alive) setEvents(page.events);
      })
      .catch(() => {
        if (alive) setEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [session]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button type="button" aria-label="关闭" onClick={props.onClose} className="absolute inset-0 cursor-default bg-ink/40" />
      <aside className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-[580px] flex-col border-l-[3px] border-ink bg-page shadow-comic-lg">
        <div className="shrink-0 border-b-[3px] border-ink px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar agent={session.agent} size={44} />
              <div className="min-w-0">
                <p className="font-mono text-[10.5px] text-faint">
                  {AGENT_CHARACTER[session.agent].name} · {fmtTime(session.firstTs)} → {fmtTime(session.lastTs)}
                </p>
                <h2 className="mt-0.5 break-words font-display text-[17px] leading-tight text-ink">
                  {session.title}
                </h2>
                <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{session.projectDir ?? '—'}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="comic-btn shrink-0 bg-white px-2.5 py-1 font-mono text-[12px] text-ink"
            >
              ✕
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
            {[
              ['消息', String(session.messageCount)],
              ['输入 tokens', session.inputTokens.toLocaleString()],
              ['输出 tokens', session.outputTokens.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border-2 border-ink bg-white px-2 py-1.5 text-center">
                <dt className="text-faint">{label}</dt>
                <dd className="text-ink tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-2 font-display text-[12px] text-dim">时间线(最近 100 条)</p>
          {events === null ? (
            <p className="text-[13px] text-faint">翻档案中…</p>
          ) : events.length === 0 ? (
            <p className="text-[13px] text-faint">这段会话还没有已索引的事件。</p>
          ) : (
            <ul>
              {events.map((e, i) => (
                <li key={i} className="flex items-start gap-2.5 border-b-2 border-dashed border-faint/50 py-1.5">
                  <span className={`sticker mt-0.5 w-[64px] shrink-0 -rotate-2 justify-center ${KIND_STICKER[e.kind]}`}>
                    {EVENT_KIND_LABEL[e.kind]}
                  </span>
                  <span className="mt-1 w-[56px] shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                    {fmtTime(e.ts)}
                  </span>
                  <span className="min-w-0 flex-1 break-words pt-0.5 text-[12px] leading-relaxed text-ink">
                    {e.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t-[3px] border-ink px-5 py-4">
          <p className="mb-2 font-display text-[12px] text-dim">在原工具里继续这段会话:</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border-[3px] border-ink bg-white px-3 py-2 font-mono text-[12px] text-ink">
              {session.resumeCommand}
            </code>
            <button
              type="button"
              onClick={() => {
                void props.onCopy().then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="comic-btn shrink-0 bg-white px-3 py-2 font-display text-[12px] text-ink"
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpening(true);
                void api
                  .openInTerminal(session.agent, session.sessionId)
                  .catch(() => {
                    setOpenError(true);
                    setTimeout(() => setOpenError(false), 2500);
                  })
                  .finally(() => setOpening(false));
              }}
              disabled={opening}
              className="comic-btn shrink-0 bg-cyan px-3 py-2 font-display text-[12px] text-white disabled:opacity-40"
            >
              {openError ? '打开失败' : opening ? '打开中…' : '在终端打开'}
            </button>
            <button
              type="button"
              onClick={() => props.onResume(session.agent, session.sessionId, session.projectDir, session.title)}
              className="comic-btn shrink-0 bg-red px-3 py-2 font-display text-[12px] text-white"
              title="在对话室新建对话并接续这段原生会话,之后可随时切换特工"
            >
              对话室续聊
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
