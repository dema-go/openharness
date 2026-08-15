import { useEffect, useMemo, useState } from 'react';
import type { AgentId, HarnessEvent, SessionSummary } from '@openharness/core';
import { AGENT_DISPLAY, EVENT_KIND_LABEL } from '@openharness/core';
import { api } from '../lib/api';

const KIND_TONE: Record<HarnessEvent['kind'], string> = {
  'session-start': 'text-jade',
  'session-end': 'text-faint',
  'user-message': 'text-paper',
  'assistant-message': 'text-dim',
  'tool-call': 'text-amber',
  'file-edit': 'text-jade',
  'error': 'text-brick',
  'mode-change': 'text-faint',
  'task-start': 'text-amber',
  'task-end': 'text-jade',
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

export function SessionsPanel(props: { sessions: SessionSummary[] }): React.JSX.Element {
  const { sessions } = props;
  const [agentFilter, setAgentFilter] = useState<AgentId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  const visible = useMemo(
    () =>
      sessions
        .filter((s) => agentFilter === 'all' || s.agent === agentFilter)
        .filter((s) => {
          const q = query.trim().toLowerCase();
          if (!q) return true;
          return (
            s.title.toLowerCase().includes(q) ||
            (s.projectDir ?? '').toLowerCase().includes(q) ||
            s.sessionId.toLowerCase().includes(q)
          );
        })
        .slice(0, 200),
    [sessions, agentFilter, query],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="font-display text-[13px] font-500 text-paper">会话索引</h2>
        <span className="font-mono text-[11px] text-faint tabular-nums">{visible.length}</span>
        <div className="ml-3 flex items-center gap-1">
          {(['all', 'claude', 'codex', 'cursor', 'dsh'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setAgentFilter(f)}
              className={`rounded-sm px-2 py-0.5 font-mono text-[11px] transition-colors ${
                agentFilter === f ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              {f === 'all' ? '全部' : f}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题 / 项目 / 会话 ID"
          className="ml-auto w-64 rounded-sm border border-line bg-ink px-2.5 py-1 font-mono text-[11px] text-paper placeholder:text-faint focus:border-amber/60"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="font-display text-[15px] text-dim">没有匹配的会话</p>
            <p className="max-w-sm text-[13px] leading-relaxed text-faint">
              会话索引来自各工具本地的会话文件,只读、不迁移。换一个工具筛选,或在任意 Agent 工具里开始一段新会话。
            </p>
          </div>
        ) : (
          <ul>
            {visible.map((s) => (
              <li key={`${s.agent}-${s.sessionId}`}>
                <button
                  type="button"
                  onClick={() => setSelected(s)}
                  className="flex w-full items-center gap-3 border-b border-line/60 px-4 py-2.5 text-left transition-colors hover:bg-panel"
                >
                  <span className="w-[86px] shrink-0 font-mono text-[11px] text-dim">
                    {AGENT_DISPLAY[s.agent]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-paper">{s.title}</span>
                  <span className="hidden shrink-0 font-mono text-[11px] text-faint lg:inline">
                    {basename(s.projectDir)}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                    {s.messageCount} 条消息
                  </span>
                  <span className="w-[104px] shrink-0 text-right font-mono text-[11px] text-faint tabular-nums">
                    {fmtTime(s.lastTs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <SessionDetail
          session={selected}
          onClose={() => setSelected(null)}
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
  onCopy: () => Promise<void>;
}): React.JSX.Element {
  const { session } = props;
  const [events, setEvents] = useState<HarnessEvent[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .events({ agent: session.agent, session: session.sessionId, limit: 100 })
      .then((e) => {
        if (alive) setEvents(e);
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
      <button type="button" aria-label="关闭" onClick={props.onClose} className="absolute inset-0 cursor-default bg-ink/60" />
      <aside className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-[560px] flex-col border-l border-line bg-panel shadow-2xl">
        <div className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-faint">
                {AGENT_DISPLAY[session.agent]} · {fmtTime(session.firstTs)} → {fmtTime(session.lastTs)}
              </p>
              <h2 className="mt-1 break-words font-display text-[16px] font-500 text-paper">
                {session.title}
              </h2>
              <p className="mt-1 truncate font-mono text-[11px] text-faint">{session.projectDir ?? '—'}</p>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="shrink-0 font-mono text-[12px] text-faint transition-colors hover:text-paper"
            >
              ✕
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 font-mono text-[11px]">
            <div>
              <dt className="text-faint">消息</dt>
              <dd className="mt-0.5 text-dim tabular-nums">{session.messageCount}</dd>
            </div>
            <div>
              <dt className="text-faint">输入 tokens</dt>
              <dd className="mt-0.5 text-dim tabular-nums">{session.inputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-faint">输出 tokens</dt>
              <dd className="mt-0.5 text-dim tabular-nums">{session.outputTokens.toLocaleString()}</dd>
            </div>
          </dl>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-2 font-mono text-[11px] text-faint">时间线(最近 100 条)</p>
          {events === null ? (
            <p className="text-[13px] text-faint">加载中…</p>
          ) : events.length === 0 ? (
            <p className="text-[13px] text-faint">该会话暂无已索引的事件。</p>
          ) : (
            <ul>
              {events.map((e, i) => (
                <li key={i} className="flex items-start gap-3 border-b border-line/50 py-1.5">
                  <span className="w-[64px] shrink-0 font-mono text-[11px] text-faint tabular-nums">
                    {fmtTime(e.ts)}
                  </span>
                  <span className={`w-[60px] shrink-0 font-mono text-[11px] ${KIND_TONE[e.kind]}`}>
                    {EVENT_KIND_LABEL[e.kind]}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[12px] leading-relaxed text-dim">
                    {e.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-line px-5 py-4">
          <p className="mb-2 font-mono text-[11px] text-faint">在原生工具中恢复此会话</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink px-3 py-2 font-mono text-[12px] text-paper">
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
              className="shrink-0 rounded-sm border border-line px-3 py-2 font-mono text-[12px] text-dim transition-colors hover:border-amber/60 hover:text-amber"
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
