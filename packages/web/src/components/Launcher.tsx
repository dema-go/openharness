import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentStatus, TaskInfo } from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { api } from '../lib/api';

interface Suggestion {
  agent: string;
  display: string;
  score: number;
  reasons: string[];
  capability: string;
  enabled: boolean;
}

export function Launcher(props: {
  open: boolean;
  statuses: AgentStatus[];
  projectDirs: string[];
  tasks: TaskInfo[];
  onClose: () => void;
  onTask: (t: TaskInfo) => void;
}): React.JSX.Element | null {
  const { open, statuses, projectDirs, tasks } = props;
  const enabled = statuses.filter((s) => s.enabled);
  const [agent, setAgent] = useState<AgentId>('claude');
  const [cwd, setCwd] = useState(projectDirs[0] ?? '');
  const [prompt, setPrompt] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (open && enabled.length > 0 && !enabled.some((s) => s.agent === agent)) {
      setAgent(enabled[0]!.agent);
    }
  }, [open, enabled, agent]);

  useEffect(() => {
    if (prompt.trim().length < 4) {
      setSuggestions([]);
      return;
    }
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    suggestTimer.current = setTimeout(() => {
      api
        .suggest(prompt)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 300);
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
    };
  }, [prompt]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    // 首次发任务时请求桌面通知权限(任务收尾提醒)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    try {
      const t = await api.startTask({ agent, cwd: cwd.trim(), prompt: prompt.trim() });
      props.onTask(t);
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    try {
      props.onTask(await api.stopTask(id));
    } catch {
      /* 任务可能已结束 */
    }
  };

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭"
        onClick={props.onClose}
        className="absolute inset-0 cursor-default bg-ink/60"
      />
      <aside className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-panel shadow-2xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="font-display text-[15px] font-500 text-paper">发起任务</h2>
          <button
            type="button"
            onClick={props.onClose}
            className="font-mono text-[12px] text-faint transition-colors hover:text-paper"
          >
            ESC ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="space-y-4">
            <div>
              <label className="mb-2 block font-mono text-[11px] text-faint">交给谁</label>
              <div className="grid gap-2">
                {enabled.map((s) => (
                  <button
                    key={s.agent}
                    type="button"
                    onClick={() => setAgent(s.agent)}
                    className={`rounded-sm border px-3 py-2.5 text-left transition-colors ${
                      agent === s.agent
                        ? 'border-amber/60 bg-amber/5'
                        : 'border-line hover:border-faint'
                    }`}
                  >
                    <span className="font-display text-[14px] text-paper">
                      {AGENT_DISPLAY[s.agent]}
                    </span>
                    <span className={`ml-2 font-mono text-[10px] ${agent === s.agent ? 'text-amber' : 'text-faint'}`}>
                      {s.state === 'running' ? '运行中' : '可用'}
                    </span>
                  </button>
                ))}
                {enabled.length === 0 && (
                  <p className="text-[13px] text-faint">暂无已接入的 Agent(v0.1 仅 Claude Code)。</p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="task-cwd" className="mb-2 block font-mono text-[11px] text-faint">
                工作目录
              </label>
              <input
                id="task-cwd"
                list="project-dirs"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/liuziying/Projects/…"
                className="w-full rounded-sm border border-line bg-ink px-3 py-2 font-mono text-[13px] text-paper placeholder:text-faint focus:border-amber/60"
              />
              <datalist id="project-dirs">
                {projectDirs.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>

            <div>
              <label htmlFor="task-prompt" className="mb-2 block font-mono text-[11px] text-faint">
                任务描述
              </label>
              <textarea
                id="task-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                placeholder="例如:给这个项目的 API 加上分页,并补上单元测试"
                className="w-full resize-y rounded-sm border border-line bg-ink px-3 py-2 text-[13px] leading-relaxed text-paper placeholder:text-faint focus:border-amber/60"
              />

              {suggestions.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="font-mono text-[11px] text-faint">建议(按特色匹配,你来拍板)</p>
                  {suggestions.map((s) => (
                    <div
                      key={s.agent}
                      className={`rounded-sm border px-3 py-2 ${
                        s.enabled ? 'border-line' : 'border-line opacity-50'
                      }`}
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="font-display text-[13px] text-paper">{s.display}</span>
                        <span className="font-mono text-[10px] text-faint">
                          {s.score > 0 ? `匹配 ${s.score}` : '—'}
                          {!s.enabled ? ' · 未接入' : ''}
                        </span>
                      </div>
                      {s.reasons.length > 0 ? (
                        <p className="mt-1 text-[12px] text-dim">{s.reasons.join(';')}</p>
                      ) : (
                        <p className="mt-1 text-[12px] text-faint">{s.capability}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p className="rounded-sm border border-brick/50 bg-brick/10 px-3 py-2 text-[13px] text-brick">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || enabled.length === 0 || !cwd.trim() || !prompt.trim()}
              className="w-full rounded-sm border border-amber/60 bg-amber/10 px-4 py-2.5 font-display text-[14px] font-500 text-amber transition-colors hover:bg-amber/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? '启动中…' : '启动任务'}
            </button>

            {tasks.length > 0 && (
              <div>
                <p className="mb-2 font-mono text-[11px] text-faint">本次会话的任务</p>
                <ul className="space-y-2">
                  {tasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 rounded-sm border border-line px-3 py-2"
                    >
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          t.state === 'running'
                            ? 'orb-running bg-amber'
                            : t.state === 'done'
                              ? 'bg-jade'
                              : t.state === 'stopped'
                                ? 'bg-faint'
                                : 'bg-brick'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{t.prompt}</span>
                      <span className="shrink-0 font-mono text-[10px] text-faint">
                        {AGENT_DISPLAY[t.agent]} · {t.state}
                      </span>
                      {t.state === 'running' && (
                        <button
                          type="button"
                          onClick={() => void stop(t.id)}
                          className="shrink-0 font-mono text-[11px] text-brick hover:text-paper"
                        >
                          打断
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
