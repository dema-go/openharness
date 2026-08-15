import { useEffect, useRef, useState } from 'react';
import type { AgentId, HarnessEvent } from '@openharness/core';
import { AGENT_DISPLAY, EVENT_KIND_LABEL } from '@openharness/core';
import { AGENT_CHARACTER } from './ComicIcons';

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
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="comic-card flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 面板头:标签页 + 过滤贴纸 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b-[3px] border-ink px-4">
          <h2 className="font-display text-[15px] text-ink">实时活动流</h2>
          <span className="sticker rotate-2 bg-red text-white">LIVE</span>
          <span className="font-mono text-[11px] text-faint tabular-nums">{visible.length}</span>
          <div className="ml-3 flex items-center gap-1.5">
            {(['all', 'claude', 'cursor', 'codex', 'dsh'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilter(f)}
                className={`rounded-md border-2 border-ink px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  filter === f ? 'bg-yellow text-ink' : 'bg-white text-dim hover:bg-panel2'
                }`}
                style={filter === f ? { boxShadow: '2px 2px 0 #221D15' } : undefined}
              >
                {f === 'all' ? '全部' : f}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            {!atBottom && !paused && <span className="font-mono text-[11px] text-red">有新活动 ↓</span>}
            <button
              type="button"
              onClick={onTogglePause}
              className={`font-mono text-[11px] ${paused ? 'text-red' : 'text-faint hover:text-dim'}`}
            >
              {paused ? '已暂停' : '自动跟随'}
            </button>
          </div>
        </div>

        <div ref={scroller} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <svg viewBox="0 0 100 100" width="72" height="72" aria-hidden>
                <circle cx="50" cy="50" r="46" fill="#fff" stroke="#221D15" strokeWidth="5" />
                <circle cx="36" cy="42" r="6" fill="#221D15" />
                <circle cx="64" cy="42" r="6" fill="#221D15" />
                <path d="M32 68 Q50 56 68 68" stroke="#221D15" strokeWidth="5" fill="none" strokeLinecap="round" />
                <path d="M14 22 L4 12 M86 22 L96 12" stroke="#221D15" strokeWidth="4" strokeLinecap="round" />
              </svg>
              <div className="bubble font-display text-[13px] text-ink">
                这里还空空的哦!发个任务,或去任意工具里开一局~
              </div>
            </div>
          ) : (
            <ul className="py-3">
              {visible.map((e, i) => (
                <li key={i} className="feed-in flex items-start gap-3 px-4 py-2">
                  <span
                    className={`sticker mt-0.5 w-[74px] shrink-0 -rotate-2 justify-center ${KIND_STICKER[e.kind]}`}
                  >
                    {EVENT_KIND_LABEL[e.kind]}
                  </span>
                  <span className="mt-1 w-[62px] shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                    {fmtTime(e.ts)}
                  </span>
                  <span
                    className="mt-1 w-[96px] shrink-0 truncate font-display text-[12px]"
                    style={{ color: AGENT_CHARACTER[e.agent].color }}
                    title={AGENT_DISPLAY[e.agent]}
                  >
                    {AGENT_CHARACTER[e.agent].name}
                  </span>
                  <span className="min-w-0 flex-1 break-words pt-1 text-[13px] leading-relaxed text-ink">
                    {e.summary}
                  </span>
                  <span className="mt-1 hidden shrink-0 font-mono text-[10.5px] text-faint lg:inline">
                    {basename(e.projectDir)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
