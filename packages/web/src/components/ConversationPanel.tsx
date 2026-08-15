import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentId,
  ConversationMessage,
  ConversationSummary,
  TaskInfo,
} from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { api } from '../lib/api';
import { AGENT_CHARACTER, AgentAvatar, Squiggle } from './ComicIcons';

const NO_RESUME_AGENTS: AgentId[] = ['dsh'];

function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ts);
}

export function ConversationPanel(props: {
  liveMessages: Array<{ convId: string; message: ConversationMessage }>;
  projectDirs: string[];
  tasks: TaskInfo[];
  initialConvId: string | null;
  onTask: (t: TaskInfo) => void;
}): React.JSX.Element {
  const { liveMessages, projectDirs, tasks, initialConvId, onTask } = props;
  const [convs, setConvs] = useState<ConversationSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ConversationMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [agent, setAgent] = useState<AgentId>('claude');
  const [cwd, setCwd] = useState(projectDirs[0] ?? '');
  const [input, setInput] = useState('');
  const [bypass, setBypass] = useState(() => {
    try {
      return localStorage.getItem('oh-bypass-permissions') === '1';
    } catch {
      return false;
    }
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const seenSeqs = useRef(new Set<number>());

  const loadConversations = useCallback(async () => {
    const list = await api.conversations();
    setConvs(list);
    return list;
  }, []);

  const openConv = useCallback(async (id: string) => {
    setActiveId(id);
    setMsgs([]);
    setError(null);
    seenSeqs.current = new Set();
    try {
      const page = await api.conversationMessages(id, { limit: 100 });
      setHasMore(page.hasMore);
      page.messages.forEach((m) => seenSeqs.current.add(m.seq));
      setMsgs(page.messages);
    } catch {
      setMsgs([]);
    }
  }, []);

  // 初始:载入列表,选中 initialConvId(会话档案续聊)或最近一个对话
  useEffect(() => {
    void (async () => {
      const list = await loadConversations();
      const target = initialConvId && list.some((c) => c.id === initialConvId) ? initialConvId : list[0]?.id;
      if (target) await openConv(target);
    })();
  }, [loadConversations, openConv, initialConvId]);

  const addMessage = useCallback((m: ConversationMessage) => {
    if (seenSeqs.current.has(m.seq)) return;
    seenSeqs.current.add(m.seq);
    setMsgs((prev) => [...prev, m].sort((a, b) => a.seq - b.seq));
  }, []);

  // WS 实时消息(只消费当前对话)
  useEffect(() => {
    for (const { convId, message } of liveMessages) {
      if (convId !== activeId) continue;
      addMessage(message);
    }
    // 列表预览同步更新
    if (liveMessages.length > 0) {
      const last = liveMessages[liveMessages.length - 1];
      if (last) {
        setConvs((prev) =>
          prev
            ? prev.map((c) =>
                c.id === last.convId
                  ? { ...c, lastMessage: last.message.content.slice(0, 60), updatedAt: last.message.createdAt, messageCount: c.messageCount + 1 }
                  : c,
              )
            : prev,
        );
      }
    }
  }, [liveMessages, activeId, addMessage]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  useEffect(() => {
    if (projectDirs[0] && !cwd) setCwd(projectDirs[0]);
  }, [projectDirs, cwd]);

  const running = useMemo(() => {
    const taskIds = new Set(msgs.filter((m) => m.taskId).map((m) => m.taskId as string));
    return tasks.find((t) => taskIds.has(t.id) && (t.state === 'running' || t.state === 'queued'));
  }, [msgs, tasks]);

  const createNew = async () => {
    try {
      const conv = await api.createConversation({});
      setConvs((prev) => [conv, ...(prev ?? [])]);
      await openConv(conv.id);
      setCwd(projectDirs[0] ?? cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  };

  const loadOlder = async () => {
    if (!activeId || !hasMore || msgs.length === 0) return;
    const oldest = Math.min(...msgs.map((m) => m.seq));
    try {
      const page = await api.conversationMessages(activeId, { limit: 100, beforeSeq: oldest });
      setHasMore(page.hasMore);
      page.messages.forEach((m) => seenSeqs.current.add(m.seq));
      setMsgs((prev) => {
        const seen = new Set(prev.map((m) => m.seq));
        return [...page.messages.filter((m) => !seen.has(m.seq)), ...prev];
      });
    } catch {
      /* 忽略 */
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!activeId || !text || !cwd.trim() || sending || running) return;
    setSending(true);
    setError(null);
    try {
      const { message, task } = await api.sendConversationMessage(activeId, {
        content: text,
        agent,
        cwd: cwd.trim(),
        bypassPermissions: bypass,
      });
      addMessage(message);
      onTask(task);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeId) return;
    try {
      await api.stopConversationTask(activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '打断失败');
    }
  };

  const active = convs?.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 p-4">
      {/* 对话列表 */}
      <aside className="mr-4 flex w-[240px] shrink-0 flex-col overflow-hidden rounded-xl border-[3px] border-ink bg-white" style={{ boxShadow: '3px 3px 0 #221D15' }}>
        <div className="flex shrink-0 items-center justify-between border-b-[3px] border-ink px-3 py-2">
          <span className="font-display text-[13px] text-ink">对话记录</span>
          <button type="button" onClick={() => void createNew()} className="comic-btn bg-yellow px-2 py-0.5 font-display text-[11px] text-ink">
            ＋ 新对话
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {convs === null ? (
            <p className="p-2 font-mono text-[11px] text-faint">加载中…</p>
          ) : convs.length === 0 ? (
            <div className="p-3 text-center">
              <p className="text-[11.5px] text-faint">还没有对话</p>
              <button type="button" onClick={() => void createNew()} className="mt-2 font-display text-[12px] text-red hover:underline">
                开一场新的 →
              </button>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {convs.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void openConv(c.id)}
                    className={`w-full rounded-lg border-2 border-ink px-2.5 py-2 text-left transition-colors ${
                      activeId === c.id ? 'bg-yellow' : 'bg-page hover:bg-panel2'
                    }`}
                    style={{ boxShadow: activeId === c.id ? '2px 2px 0 #221D15' : undefined }}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-display text-[12px] text-ink">{c.title}</span>
                      <span className="shrink-0 font-mono text-[9px] text-faint">{c.messageCount}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-dim">
                      {c.lastMessage ?? '新对话'}
                    </span>
                    <span className="mt-0.5 block font-mono text-[9px] text-faint">{fmtTime(c.updatedAt)}</span>
                  </button>
                  {activeId === c.id && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`删除对话「${c.title}」?`)) return;
                        void api
                          .deleteConversation(c.id)
                          .then(() => {
                            void loadConversations();
                            setActiveId(null);
                            setMsgs([]);
                          })
                          .catch(() => undefined);
                      }}
                      className="mt-1 block w-full text-right font-mono text-[9px] text-red hover:underline"
                    >
                      删除此对话
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* 聊天区 */}
      <section className="comic-card flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b-[3px] border-ink px-4">
          <h2 className="font-display text-[15px] text-ink">对话室</h2>
          {active && <span className="min-w-0 truncate font-mono text-[11px] text-faint">{active.title}</span>}
          <div className="ml-auto flex items-center gap-2">
            {running && (
              <span className="sticker bg-red text-white">
                {AGENT_CHARACTER[running.agent].name} 干活中…
              </span>
            )}
            {running && (
              <button type="button" onClick={() => void stop()} className="font-display text-[11.5px] text-red hover:underline">
                打断
              </button>
            )}
          </div>
        </div>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {hasMore && (
            <button type="button" onClick={() => void loadOlder()} className="mb-2 block w-full text-center font-mono text-[10.5px] text-faint hover:text-dim">
              ▲ 加载更早
            </button>
          )}
          {msgs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <AgentAvatar agent={agent} size={56} />
              <p className="bubble font-display text-[13px] text-ink">
                选择一个对话开始;选好特工,像聊天一样持续问答——上下文一直带着!
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {msgs.map((m) => (
                <MessageBubble key={m.seq} m={m} />
              ))}
              {sending && (
                <li className="flex items-center gap-2">
                  <AgentAvatar agent={agent} size={26} />
                  <span className="font-mono text-[11px] text-faint animate-pulse">{AGENT_CHARACTER[agent].name} 思考中…</span>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t-[3px] border-ink p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {(['claude', 'cursor', 'codex', 'dsh'] as const).map((a) => {
              const selected = agent === a;
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgent(a)}
                  title={NO_RESUME_AGENTS.includes(a) ? 'DSH headless 不支持续接,将注入最近对话摘要保持上下文' : `连续对话经原生 resume 续接`}
                  className={`flex items-center gap-1.5 rounded-md border-2 border-ink px-2 py-0.5 text-[11px] transition-colors ${
                    selected ? 'bg-yellow' : 'bg-white hover:bg-panel2'
                  }`}
                  style={selected ? { boxShadow: '2px 2px 0 #221D15' } : undefined}
                >
                  <span className="font-display" style={{ color: AGENT_CHARACTER[a].color }}>
                    {AGENT_CHARACTER[a].name}
                  </span>
                  {selected && <span className="font-mono text-[9px] text-red">★</span>}
                </button>
              );
            })}
            <input
              list="conv-dirs"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="工作目录"
              className="comic-input ml-auto w-64 py-0.5 text-[11px]"
            />
            <datalist id="conv-dirs">
              {projectDirs.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          {error && <p className="mb-2 text-[11.5px] text-red">💥 {error}</p>}
          <label className="mb-2 flex cursor-pointer items-center gap-2" title="跳过所有权限确认:特工直接执行命令与文件写入,可能误删文件,仅用于可信目录">
            <input
              type="checkbox"
              checked={bypass}
              onChange={(e) => {
                setBypass(e.target.checked);
                try {
                  localStorage.setItem('oh-bypass-permissions', e.target.checked ? '1' : '0');
                } catch {
                  /* 忽略 */
                }
              }}
              className="h-3.5 w-3.5 accent-red"
            />
            <span className="font-mono text-[10.5px] text-red">完全自主(跳过所有确认,危险)</span>
            {agent === 'dsh' && <span className="font-mono text-[9.5px] text-faint">DSH 由 settings.yaml 权限预设控制</span>}
          </label>
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={`问 ${AGENT_CHARACTER[agent].name} 点什么…(Enter 发送,Shift+Enter 换行)`}
              className="comic-input min-w-0 flex-1 resize-y"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || !activeId || !input.trim() || !cwd.trim() || Boolean(running)}
              className="comic-btn shrink-0 bg-red px-4 py-2.5 font-display text-[14px] text-white disabled:opacity-40"
            >
              {sending ? '发射中…' : '发送!'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function MessageBubble(props: { m: ConversationMessage }): React.JSX.Element {
  const { m } = props;
  if (m.role === 'system' || m.role === 'task') {
    return (
      <li className="flex justify-center">
        <span className="max-w-[85%] rounded-full border-2 border-ink bg-panel2 px-3 py-1 text-center font-mono text-[10.5px] text-dim">
          {m.content}
        </span>
      </li>
    );
  }
  if (m.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[78%] rounded-xl rounded-br-sm border-[3px] border-ink bg-yellow px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{m.content}</p>
          <p className="mt-1 text-right font-mono text-[9px] text-faint">{fmtTime(m.createdAt)}</p>
        </div>
      </li>
    );
  }
  const agent = m.agent ?? 'dsh';
  return (
    <li className="flex items-start gap-2">
      <AgentAvatar agent={agent} size={30} />
      <div className="min-w-0 max-w-[80%] rounded-xl rounded-bl-sm border-[3px] border-ink bg-white px-3 py-2">
        <p className="font-display text-[11px]" style={{ color: AGENT_CHARACTER[agent].color }}>
          {AGENT_CHARACTER[agent].name}
          <span className="ml-1.5 font-mono text-[8.5px] text-faint">({AGENT_DISPLAY[agent]})</span>
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{m.content}</p>
        <p className="mt-1 text-right font-mono text-[9px] text-faint">{fmtTime(m.createdAt)}</p>
      </div>
    </li>
  );
}
