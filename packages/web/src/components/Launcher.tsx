import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentStatus, TaskInfo } from '@openharness/core';
import { api } from '../lib/api';
import { AGENT_CHARACTER, AgentAvatar, Squiggle } from './ComicIcons';

interface Suggestion {
  agent: string;
  display: string;
  score: number;
  reasons: string[];
  capability: string;
  enabled: boolean;
}

const TASK_STATE: Record<TaskInfo['state'], { label: string; cls: string }> = {
  running: { label: '干活中', cls: 'bg-red text-white' },
  queued: { label: '排队中', cls: 'bg-faint text-white' },
  done: { label: '完工!', cls: 'bg-green text-white' },
  stopped: { label: '已打断', cls: 'bg-faint text-white' },
  error: { label: '翻车了', cls: 'bg-red text-white' },
};

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
  const [queue, setQueue] = useState(false);
  const [bypass, setBypass] = useState(() => {
    try {
      return localStorage.getItem('oh-bypass-permissions') === '1';
    } catch {
      return false;
    }
  });
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
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    try {
      const t = await api.startTask({ agent, cwd: cwd.trim(), prompt: prompt.trim(), queue, bypassPermissions: bypass });
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
        className="absolute inset-0 cursor-default bg-ink/40"
      />
      <aside className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-[460px] flex-col border-l-[3px] border-ink bg-page shadow-comic-lg">
        <div className="flex h-16 shrink-0 items-center justify-between border-b-[3px] border-ink px-5">
          <div>
            <h2 className="font-display text-[19px] text-ink">发射任务!</h2>
            <Squiggle width={52} />
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="comic-btn bg-white px-2.5 py-1 font-mono text-[12px] text-ink"
          >
            ✕ ESC
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            <div>
              <label className="mb-2 block font-display text-[13px] text-ink">交给哪位特工?</label>
              <div className="grid gap-2.5">
                {enabled.map((s) => {
                  const c = AGENT_CHARACTER[s.agent];
                  const selected = agent === s.agent;
                  return (
                    <button
                      key={s.agent}
                      type="button"
                      onClick={() => setAgent(s.agent)}
                      className={`flex items-center gap-3 rounded-xl border-[3px] border-ink px-3 py-2.5 text-left transition-colors ${
                        selected ? 'bg-yellow' : 'bg-white hover:bg-panel2'
                      }`}
                      style={selected ? { boxShadow: '4px 4px 0 #221D15' } : { boxShadow: '2px 2px 0 #221D15' }}
                    >
                      <AgentAvatar agent={s.agent} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-[15px] leading-tight text-ink">
                          {c.name}
                          {selected && <span className="ml-2 text-[12px] text-red">★ 选中!</span>}
                        </span>
                        <span className="block text-[11px] text-dim">
                          {c.title} · {s.state === 'running' ? '正在干活' : '随时待命'}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {enabled.length === 0 && (
                  <p className="text-[13px] text-dim">暂无已接入的特工。</p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="task-cwd" className="mb-2 block font-display text-[13px] text-ink">
                工作目录
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="task-cwd"
                  list="project-dirs"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/Users/liuziying/Projects/…"
                  className="comic-input min-w-0 flex-1"
                />
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .pickDir('open')
                      .then((res) => {
                        if (res.path) setCwd(res.path);
                      })
                      .catch(() => undefined);
                  }}
                  className="comic-btn shrink-0 bg-white px-2.5 py-2 font-mono text-[11px] text-ink"
                  title="本机目录选择器"
                >
                  浏览…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .pickDir('new')
                      .then((res) => {
                        if (res.path) setCwd(res.path);
                      })
                      .catch(() => undefined);
                  }}
                  className="comic-btn shrink-0 bg-white px-2.5 py-2 font-mono text-[11px] text-ink"
                  title="新建文件夹作为工作区"
                >
                  ＋新建
                </button>
              </div>
              <datalist id="project-dirs">
                {projectDirs.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>

            <div>
              <label htmlFor="task-prompt" className="mb-2 block font-display text-[13px] text-ink">
                任务描述
              </label>
              <textarea
                id="task-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="例如:给这个项目的 API 加上分页,并补上单元测试"
                className="comic-input resize-y"
              />

              {suggestions.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="font-display text-[12px] text-dim">建议(按特长匹配,你来拍板):</p>
                  {suggestions.map((s) => (
                    <div
                      key={s.agent}
                      className={`rounded-xl border-[3px] border-ink bg-white px-3 py-2 ${s.enabled ? '' : 'opacity-50'}`}
                      style={{
                        boxShadow: '2px 2px 0 #221D15',
                        borderColor: AGENT_CHARACTER[s.agent as AgentId]?.color ?? '#221D15',
                      }}
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="font-display text-[13.5px] text-ink">{s.display}</span>
                        <span className="font-mono text-[10px] text-faint">
                          {s.score > 0 ? `匹配 ${s.score}` : '—'}
                          {!s.enabled ? ' · 未接入' : ''}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-dim">
                        {s.reasons.length > 0 ? s.reasons.join(';') : s.capability}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p className="rounded-lg border-[3px] border-ink bg-red/15 px-3 py-2 text-[13px] text-ink">
                💥 {error}
              </p>
            )}

            <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border-[3px] border-ink bg-white px-3 py-2.5">
              <input
                type="checkbox"
                checked={queue}
                onChange={(e) => setQueue(e.target.checked)}
                className="h-4 w-4 accent-red"
              />
              <span className="text-[12.5px] text-ink">
                排队执行
                <span className="ml-1.5 text-faint">特工忙时排进队伍,收工后自动接单</span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border-[3px] border-red bg-red/10 px-3 py-2.5">
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
                className="mt-0.5 h-4 w-4 accent-red"
              />
              <span className="text-[12.5px] leading-relaxed text-ink">
                <span className="font-display text-red">完全自主(跳过所有确认)</span>
                <span className="ml-1.5 text-dim">
                  特工将直接执行全部命令与文件写入,不会询问,可能误删文件——仅用于可信目录。
                  {agent === 'dsh' && ' DSH 不受此开关控制,权限取决于 ~/.dsh/settings.yaml(当前 defaultPreset=danger-full-access)。'}
                </span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || enabled.length === 0 || !cwd.trim() || !prompt.trim()}
              className="comic-btn w-full bg-red px-4 py-3 text-[16px] text-white disabled:opacity-40"
            >
              {busy ? '发射中…' : queue ? '加入队伍!' : '发射任务!'}
            </button>

            {tasks.length > 0 && (
              <div>
                <p className="mb-2 font-display text-[12px] text-dim">任务记录(重启保留):</p>
                <ul className="space-y-2">
                  {tasks.map((t) => {
                    const st = TASK_STATE[t.state];
                    return (
                      <li
                        key={t.id}
                        className="flex items-center gap-2.5 rounded-xl border-[3px] border-ink bg-white px-3 py-2"
                        style={{ boxShadow: '2px 2px 0 #221D15' }}
                      >
                        <span className={`sticker shrink-0 ${st.cls}`}>{st.label}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{t.prompt}</span>
                        <span className="shrink-0 font-mono text-[10px] text-faint">
                          {AGENT_CHARACTER[t.agent].name}
                        </span>
                        {(t.state === 'running' || t.state === 'queued') && (
                          <button
                            type="button"
                            onClick={() => void stop(t.id)}
                            className="shrink-0 font-display text-[11px] text-red"
                          >
                            {t.state === 'queued' ? '移除' : '打断'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
