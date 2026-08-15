import { useEffect, useRef, useState } from 'react';
import type { AgentId, HarnessEvent } from '@openharness/core';
import { AGENT_DISPLAY, EVENT_KIND_LABEL } from '@openharness/core';

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
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ts);
}

function basename(p: string | null): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

export function ActivityFeed(props: {
  events: HarnessEvent[];
  filter: AgentId | 'all';
  onFilter: (f: AgentId | 'all') => void;
  paused: boolean;
  onTogglePause: () => void;
}): React.JSX.Element {
  const { events, filter, onFilter, paused, onTogglePause } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom && !paused) el.scrollTop = el.scrollHeight;
  }, [events, atBottom, paused]);

  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const visible = filter === 'all' ? events : events.filter((e) => e.agent === filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="font-display text-[13px] font-500 text-paper">活动流</h2>
        <span className="font-mono text-[11px] text-faint tabular-nums">{visible.length}</span>
        <div className="ml-3 flex items-center gap-1">
          {(['all', 'claude', 'cursor', 'codex', 'dsh'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFilter(f)}
              className={`rounded-sm px-2 py-0.5 font-mono text-[11px] transition-colors ${
                filter === f ? 'bg-panel2 text-paper' : 'text-faint hover:text-dim'
              }`}
            >
              {f === 'all' ? '全部' : f}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!atBottom && !paused && (
            <span className="font-mono text-[11px] text-amber">有新活动 ↓</span>
          )}
          <button
            type="button"
            onClick={onTogglePause}
            className={`font-mono text-[11px] transition-colors ${paused ? 'text-amber' : 'text-faint hover:text-dim'}`}
          >
            {paused ? '已暂停' : '自动跟随'}
          </button>
        </div>
      </div>

      <div ref={scroller} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="font-display text-[15px] text-dim">还没有活动</p>
            <p className="max-w-sm text-[13px] leading-relaxed text-faint">
              从右上角发起一个任务,或在任意 Agent 工具里打开一个会话 —— 这里就会出现实时活动。
            </p>
          </div>
        ) : (
          <ul className="py-2">
            {visible.map((e, i) => (
              <li
                key={i}
                className="feed-in flex items-start gap-3 px-4 py-1.5 hover:bg-panel"
              >
                <span className="mt-0.5 w-[68px] shrink-0 font-mono text-[11px] text-faint tabular-nums">
                  {fmtTime(e.ts)}
                </span>
                <span className="w-[86px] shrink-0 font-mono text-[11px] text-dim">
                  {AGENT_DISPLAY[e.agent]}
                </span>
                <span className={`w-[64px] shrink-0 font-mono text-[11px] ${KIND_TONE[e.kind]}`}>
                  {EVENT_KIND_LABEL[e.kind]}
                </span>
                <span className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-dim">
                  {e.summary}
                </span>
                <span className="hidden shrink-0 font-mono text-[11px] text-faint lg:inline">
                  {basename(e.projectDir)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
