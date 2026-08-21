import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, EventKind, HarnessEvent } from '@openharness/core';
import { AGENT_DISPLAY, EVENT_KIND_LABEL } from '@openharness/core';
import { api } from '../lib/api';
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
  'plan-created': 'bg-purple text-white',
  'gate-waiting': 'bg-orange',
  'verify-passed': 'bg-green text-white',
  'verify-failed': 'bg-red text-white',
  'replan': 'bg-yellow',
  'run-finalized': 'bg-green text-white',
};

const PAGE_SIZES = [50, 100, 200];
const ALL_KINDS = Object.keys(EVENT_KIND_LABEL) as EventKind[];

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

function matchEvent(
  e: HarnessEvent,
  filter: AgentId | 'all',
  kinds: EventKind[],
  q: string,
): boolean {
  if (filter !== 'all' && e.agent !== filter) return false;
  if (kinds.length > 0 && !kinds.includes(e.kind)) return false;
  if (q && !e.summary.toLowerCase().includes(q)) return false;
  return true;
}

export function ActivityFeed(props: {
  liveEvents: HarnessEvent[];
  paused: boolean;
  onTogglePause: () => void;
}): React.JSX.Element {
  const { liveEvents, paused, onTogglePause } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);

  // 服务端分页历史(时间正序);实时事件由父级 WS 累积后传入
  const [history, setHistory] = useState<HarnessEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filter, setFilter] = useState<AgentId | 'all'>('all');
  const [kinds, setKinds] = useState<EventKind[]>([]);
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState(100);

  const fetchPage = useCallback(
    async (beforeSeq: number | undefined, reset: boolean) => {
      try {
        const page = await api.events({
          agent: filter === 'all' ? undefined : filter,
          kinds: kinds.length > 0 ? kinds : undefined,
          q: query.trim() || undefined,
          limit: pageSize,
          beforeSeq,
        });
        setHasMore(page.hasMore);
        setHistory((prev) => {
          if (reset) return page.events;
          const seen = new Set(prev.map((e) => e.seq));
          return [...page.events.filter((e) => !seen.has(e.seq)), ...prev];
        });
      } catch {
        setHasMore(false);
      } finally {
        setLoading(false);
        setLoadingOlder(false);
      }
    },
    [filter, kinds, query, pageSize],
  );

  // 筛选 / 每页条数变化:重置为最新一页
  useEffect(() => {
    setLoading(true);
    void fetchPage(undefined, true);
  }, [fetchPage]);

  const loadOlder = () => {
    if (loadingOlder || loading || !hasMore) return;
    setLoadingOlder(true);
    const oldest = history.length
      ? Math.min(...history.map((e) => e.seq ?? Number.MAX_SAFE_INTEGER))
      : undefined;
    void fetchPage(oldest === Number.MAX_SAFE_INTEGER ? undefined : oldest, false);
  };

  // 最新在前:停在顶部时新事件自动置顶跟随
  useEffect(() => {
    const el = scroller.current;
    if (el && atTop && !paused) el.scrollTop = 0;
  }, [liveEvents.length, history.length, atTop, paused]);

  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setAtTop(el.scrollTop < 48);
  };

  const scrollToTop = () => {
    const el = scroller.current;
    if (el) {
      el.scrollTop = 0;
      setAtTop(true);
    }
  };

  const visible = useMemo(() => {
    const seen = new Set(history.map((e) => e.seq));
    const extra = liveEvents.filter((e) => e.seq === undefined || !seen.has(e.seq));
    return [...history, ...extra].filter((e) => matchEvent(e, filter, kinds, query.trim().toLowerCase()));
  }, [history, liveEvents, filter, kinds, query]);

  // 展示顺序:最新在前
  const shown = useMemo(() => [...visible].reverse(), [visible]);

  const toggleKind = (k: EventKind) => {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const filtering = kinds.length > 0 || query.trim() !== '' || filter !== 'all';

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="comic-card flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 面板头:标签页 + 过滤贴纸 */}
        <div className="shrink-0 border-b-[3px] border-ink px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[15px] text-ink">实时活动流</h2>
            <span className="sticker rotate-2 bg-red text-white">LIVE</span>
            <span className="font-mono text-[11px] text-faint tabular-nums">
              {loading ? '…' : `已加载 ${visible.length} 条`}
            </span>
            <div className="ml-3 flex items-center gap-1.5">
              {(['all', 'claude', 'cursor', 'codex', 'dsh'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
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
              {!atTop && !paused && <span className="font-mono text-[11px] text-red">有新活动 ↑</span>}
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="comic-input w-auto py-0.5 font-mono text-[11px]"
                title="每页条数"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    每页 {n} 条
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onTogglePause}
                className={`font-mono text-[11px] ${paused ? 'text-red' : 'text-faint hover:text-dim'}`}
              >
                {paused ? '已暂停' : '自动跟随'}
              </button>
            </div>
          </div>

          {/* 筛选行:事件类型 + 关键词 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ALL_KINDS.map((k) => {
              const on = kinds.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleKind(k)}
                  className={`rounded-md border-2 border-ink px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${
                    on ? KIND_STICKER[k] : 'bg-white text-dim hover:bg-panel2'
                  }`}
                  style={on ? { boxShadow: '1.5px 1.5px 0 #221D15' } : undefined}
                >
                  {EVENT_KIND_LABEL[k]}
                </button>
              );
            })}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜关键词…"
              className="comic-input ml-auto w-52 py-0.5 text-[11px]"
            />
            {filtering && (
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setKinds([]);
                  setQuery('');
                }}
                className="font-mono text-[10.5px] text-red hover:underline"
              >
                清除筛选
              </button>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={handleScroll} className="h-full overflow-y-auto">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-[12px] text-faint">翻活动流中…</p>
              </div>
            ) : shown.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                <svg viewBox="0 0 100 100" width="72" height="72" aria-hidden>
                  <circle cx="50" cy="50" r="46" fill="#fff" stroke="#221D15" strokeWidth="5" />
                  <circle cx="36" cy="42" r="6" fill="#221D15" />
                  <circle cx="64" cy="42" r="6" fill="#221D15" />
                  <path d="M32 68 Q50 56 68 68" stroke="#221D15" strokeWidth="5" fill="none" strokeLinecap="round" />
                  <path d="M14 22 L4 12 M86 22 L96 12" stroke="#221D15" strokeWidth="4" strokeLinecap="round" />
                </svg>
                <div className="bubble font-display text-[13px] text-ink">
                  {filtering ? '没有匹配的消息,换个筛选试试~' : '这里还空空的哦!发个任务,或去任意工具里开一局~'}
                </div>
              </div>
            ) : (
              <>
                <ul className="py-3">
                  {shown.map((e, i) => (
                    <li key={e.seq ?? `live-${i}`} className="feed-in flex items-start gap-3 px-4 py-2">
                      <span
                        className={`sticker mt-0.5 w-[74px] shrink-0 -rotate-2 justify-center ${KIND_STICKER[e.kind]}`}
                      >
                        {EVENT_KIND_LABEL[e.kind]}
                      </span>
                      <span className="mt-1 w-[62px] shrink-0 font-mono text-[10.5px] text-faint tabular-nums max-sm:hidden">
                        {fmtTime(e.ts)}
                      </span>
                      <span
                        className="mt-1 w-[96px] shrink-0 truncate font-display text-[12px] max-sm:w-16"
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
                {hasMore && (
                  <button
                    type="button"
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="block w-full border-t-2 border-dashed border-faint/50 py-1.5 text-center font-mono text-[11px] text-dim transition-colors hover:text-ink disabled:opacity-40"
                  >
                    {loadingOlder ? '翻旧账中…' : '▼ 加载更早'}
                  </button>
                )}
              </>
            )}
          </div>
          {!atTop && shown.length > 0 && (
            <button
              type="button"
              onClick={scrollToTop}
              className="sticker absolute top-3 right-5 z-10 bg-red text-white"
              style={{ boxShadow: '3px 3px 0 #221D15' }}
            >
              ↑ 最新
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
