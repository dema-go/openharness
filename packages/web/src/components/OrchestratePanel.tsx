/**
 * 编排 Tab:Supervisor 编排层的可视化驾驶舱。
 * 左栏:发起表单(目标/目录/模式/自主开关)+ run 列表;
 * 右栏:选中 run 的详情 —— 状态条、计划卡(人在环审批/修订/否决)、步骤看板、最终报告(MdBody)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanStep, SupervisorPlan, SupervisorRunRecord, SupervisorStepRecord } from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';
import { api } from '../lib/api';
import { AGENT_CHARACTER } from './ComicIcons';
import { MdBody } from './MdBody';

const RUN_STATE: Record<SupervisorRunRecord['state'], { label: string; cls: string }> = {
  planning: { label: '规划中', cls: 'bg-purple text-white' },
  awaiting_approval: { label: '等待审批', cls: 'bg-orange' },
  executing: { label: '执行中', cls: 'bg-red text-white' },
  verifying: { label: '验收中', cls: 'bg-blue' },
  reflecting: { label: '反思中', cls: 'bg-orange' },
  finalizing: { label: '汇总中', cls: 'bg-blue' },
  done: { label: '完成', cls: 'bg-green text-white' },
  failed: { label: '失败', cls: 'bg-red text-white' },
  stopped: { label: '已中止', cls: 'bg-faint text-white' },
};

const STEP_STATE: Record<SupervisorStepRecord['state'], { label: string; cls: string }> = {
  pending: { label: '待执行', cls: 'bg-faint text-white' },
  running: { label: '执行中', cls: 'bg-red text-white' },
  done: { label: '完成', cls: 'bg-green text-white' },
  failed: { label: '失败', cls: 'bg-red text-white' },
  skipped: { label: '跳过', cls: 'bg-faint text-white' },
};

function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
}

/** 计划步骤的编辑态(审批前可修订) */
function emptyDraft(steps: PlanStep[]): string {
  return steps
    .map((s) => `${s.title} | ${s.agent} | ${s.prompt} | ${s.acceptanceCheck} | autoCheck=${s.autoCheck}`)
    .join('\n');
}

function parseDraft(goal: string, draft: string): SupervisorPlan | null {
  const steps: PlanStep[] = [];
  for (const raw of draft.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [title, agent, prompt, acceptanceCheck, autoCell] = line.split('|').map((x) => x.trim());
    if (!title || !prompt || !agent) return null;
    if (!AGENT_DISPLAY[agent as keyof typeof AGENT_DISPLAY]) return null;
    steps.push({
      id: '',
      title,
      agent: agent as PlanStep['agent'],
      prompt,
      acceptanceCheck: acceptanceCheck ?? '',
      autoCheck: autoCell?.includes('true') ?? false,
    });
  }
  return steps.length > 0 ? { goal, steps } : null;
}

export function OrchestratePanel(props: {
  projectDirs: string[];
  runs: SupervisorRunRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStarted: (run: SupervisorRunRecord) => void;
}): React.JSX.Element {
  const { projectDirs, runs, selectedId } = props;
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState(projectDirs[0] ?? '');
  const [mode, setMode] = useState<'hitl' | 'auto'>('hitl');
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmReady, setLlmReady] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<{ run: SupervisorRunRecord; steps: SupervisorStepRecord[] } | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const detailRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // LLM 配置状态(未配置时引导)
  useEffect(() => {
    void api
      .supervisorConfig()
      .then((c) => setLlmReady(c.configured))
      .catch(() => setLlmReady(false));
  }, []);

  // 拉取选中 run 详情(轮询兜底;WS 推送由父层触发 refresh)
  const loadDetail = useCallback((id: string) => {
    void api
      .supervisorRun(id)
      .then(setDetail)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (detailRef.current) clearInterval(detailRef.current);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId);
    const r = runs.find((x) => x.id === selectedId);
    const live = !r || !['done', 'failed', 'stopped'].includes(r.state);
    if (live) {
      detailRef.current = setInterval(() => loadDetail(selectedId), 2500);
    }
    return () => {
      if (detailRef.current) clearInterval(detailRef.current);
    };
  }, [selectedId, runs, loadDetail]);

  // 进入审批态时初始化修订草稿
  useEffect(() => {
    if (detail?.run.state === 'awaiting_approval' && detail.run.plan) {
      setDraft(emptyDraft(detail.run.plan.steps));
      setEditing(false);
    }
  }, [detail?.run.state, detail?.run.id]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.startSupervisorRun({
        goal: goal.trim(),
        cwd: cwd.trim(),
        mode,
        bypassPermissions: mode === 'auto' && bypass,
      });
      props.onStarted(run);
      setGoal('');
      props.onSelect(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起失败');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (action: 'approve' | 'reject', plan?: SupervisorPlan) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveSupervisorRun(detail.run.id, { action, plan });
      setEditing(false);
      loadDetail(detail.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批失败');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!detail) return;
    try {
      await api.stopSupervisorRun(detail.run.id);
      loadDetail(detail.run.id);
    } catch {
      /* run 可能已终态 */
    }
  };

  const run = detail?.run;
  const steps = detail?.steps ?? [];
  const gated = run?.state === 'awaiting_approval';

  return (
    <div className="flex min-h-0 w-full">
      {/* 左栏:发起 + run 列表 */}
      <div className="halftone w-[335px] shrink-0 space-y-4 overflow-y-auto border-r-[3px] border-ink p-4">
        <div>
          <h2 className="font-display text-[16px] text-ink">指挥官驾驶舱</h2>
          <p className="mt-0.5 text-[11px] text-dim">
            给目标,指挥官自己规划、派工、验收、复盘 —— 四特工变成它的工具。
          </p>
        </div>

        {llmReady === false && (
          <div className="rounded-xl border-[3px] border-red bg-red/10 px-3 py-2.5 text-[12px] leading-relaxed text-ink">
            <p className="font-display text-red">编排大脑未配置</p>
            <p className="mt-0.5 text-dim">在配置速览 → 编排大脑 里填 API Key(OpenAI 兼容,DeepSeek/Qwen/GLM 等)。</p>
          </div>
        )}

        <div className="space-y-3 rounded-xl border-[3px] border-ink bg-white p-3.5" style={{ boxShadow: '3px 3px 0 #221D15' }}>
          <div>
            <label className="mb-1.5 block font-display text-[12.5px] text-ink">目标</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="例如:分析这个仓库的测试覆盖,补齐 supervisor 工具模块的单测,跑绿后总结"
              className="comic-input resize-y text-[12.5px]"
            />
          </div>
          <div>
            <label className="mb-1.5 block font-display text-[12.5px] text-ink">工作目录</label>
            <div className="flex items-center gap-1.5">
              <input
                list="orch-dirs"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/you/Projects/…"
                className="comic-input min-w-0 flex-1 text-[12px]"
              />
              <button
                type="button"
                onClick={() =>
                  void api
                    .pickDir('open')
                    .then((res) => {
                      if (res.path) setCwd(res.path);
                    })
                    .catch(() => undefined)
                }
                className="comic-btn shrink-0 bg-white px-2 py-1.5 font-mono text-[11px] text-ink"
              >
                浏览…
              </button>
            </div>
            <datalist id="orch-dirs">
              {projectDirs.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>

          <div>
            <span className="mb-1.5 block font-display text-[12.5px] text-ink">执行模式</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('hitl')}
                className={`rounded-lg border-[3px] border-ink px-2.5 py-2 text-left font-display text-[12.5px] transition-colors ${
                  mode === 'hitl' ? 'bg-green text-white' : 'bg-white text-ink hover:bg-panel2'
                }`}
              >
                人在环
                <span className={`mt-0.5 block text-[10px] font-normal ${mode === 'hitl' ? 'text-white/85' : 'text-dim'}`}>
                  计划先过你批准
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode('auto')}
                className={`rounded-lg border-[3px] px-2.5 py-2 text-left font-display text-[12.5px] transition-colors ${
                  mode === 'auto' ? 'border-red bg-red text-white' : 'border-ink bg-white text-ink hover:bg-panel2'
                }`}
              >
                全自动
                <span className={`mt-0.5 block text-[10px] font-normal ${mode === 'auto' ? 'text-white/85' : 'text-dim'}`}>
                  免批直跑(慎用)
                </span>
              </button>
            </div>
          </div>

          {mode === 'auto' && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border-[3px] border-red bg-red/10 px-2.5 py-2">
              <input
                type="checkbox"
                checked={bypass}
                onChange={(e) => setBypass(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-red"
              />
              <span className="text-[11.5px] leading-snug text-ink">
                <span className="font-display text-red">完全自主(Worker 跳过权限确认)</span>
                <span className="ml-1 text-dim">写文件类任务需要勾选,否则会被权限墙拦截。</span>
              </span>
            </label>
          )}

          {error && (
            <p className="rounded-lg border-[3px] border-ink bg-red/15 px-2.5 py-1.5 text-[12px] text-ink">💥 {error}</p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !goal.trim() || !cwd.trim()}
            className="comic-btn w-full bg-red px-3 py-2.5 text-[14px] text-white disabled:opacity-40"
          >
            {busy ? '发起中…' : mode === 'hitl' ? '发起编排(先审批)' : '发起编排(全自动)'}
          </button>
        </div>

        <div>
          <p className="mb-2 font-display text-[12.5px] text-dim">编排记录(最近 {runs.length} 次):</p>
          <ul className="space-y-2">
            {runs.map((r) => {
              const st = RUN_STATE[r.state];
              const active = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => props.onSelect(r.id)}
                    className={`w-full rounded-xl border-[3px] border-ink px-3 py-2 text-left transition-colors ${
                      active ? 'bg-yellow' : 'bg-white hover:bg-panel2'
                    }`}
                    style={{ boxShadow: active ? '3px 3px 0 #221D15' : '2px 2px 0 #221D15' }}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`sticker shrink-0 ${st.cls}`}>{st.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">{fmtTime(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-ink">{r.goal}</p>
                  </button>
                </li>
              );
            })}
            {runs.length === 0 && <li className="text-[12px] text-dim">还没有编排记录,发起第一个吧。</li>}
          </ul>
        </div>
      </div>

      {/* 右栏:run 详情 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {!run && (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-dim">← 发起一个编排,或从记录里选一条查看全程。</p>
          </div>
        )}

        {run && (
          <div className="mx-auto max-w-[860px] space-y-4">
            {/* 状态条 */}
            <div
              className="rounded-xl border-[3px] border-ink bg-white p-4"
              style={{ boxShadow: '3px 3px 0 #221D15' }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`sticker ${RUN_STATE[run.state].cls}`}>{RUN_STATE[run.state].label}</span>
                <span className="rounded-lg border-2 border-ink bg-panel2/60 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                  {run.mode === 'hitl' ? '人在环' : '全自动'}
                </span>
                {run.bypassPermissions && (
                  <span className="rounded-lg border-2 border-red bg-red/10 px-2 py-0.5 font-mono text-[10.5px] text-red">
                    完全自主
                  </span>
                )}
                <span className="ml-auto font-mono text-[10.5px] text-faint">
                  tokens {run.usage.input}+{run.usage.output}
                </span>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink">{run.goal}</p>
              <p className="mt-1 font-mono text-[10.5px] text-faint">{run.cwd}</p>
              {run.error && (
                <p className="mt-2 rounded-lg border-[3px] border-ink bg-red/15 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                  {run.error}
                </p>
              )}
              {!['done', 'failed', 'stopped'].includes(run.state) && (
                <button
                  type="button"
                  onClick={() => void stop()}
                  className="comic-btn mt-3 bg-white px-3 py-1.5 font-display text-[12px] text-red"
                >
                  中止编排
                </button>
              )}
            </div>

            {/* 计划卡 */}
            {run.plan && (
              <div
                className={`rounded-xl border-[3px] bg-white p-4 ${gated ? 'border-orange' : 'border-ink'}`}
                style={{ boxShadow: '3px 3px 0 #221D15' }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-[14.5px] text-ink">作战计划({run.plan.steps.length} 步)</h3>
                  {gated && <span className="font-display text-[12px] text-orange">🟠 等你拍板</span>}
                </div>

                {!editing ? (
                  <ol className="mt-3 space-y-2.5">
                    {run.plan.steps.map((s, i) => (
                      <li
                        key={s.id || i}
                        className="rounded-lg border-2 border-ink bg-panel2/40 px-3 py-2"
                        style={{ borderColor: AGENT_CHARACTER[s.agent]?.color ?? '#221D15' }}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display text-[13px] text-ink">
                            {i + 1}. {s.title}
                          </span>
                          <span className="rounded border-2 border-ink bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink">
                            {AGENT_CHARACTER[s.agent]?.name ?? s.agent}
                          </span>
                          {s.autoCheck && (
                            <span className="rounded border border-ink bg-white px-1.5 font-mono text-[9.5px] text-dim">
                              状态验收
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-dim">{s.prompt}</p>
                        <p className="mt-1 text-[11px] text-faint">✓ 验收:{s.acceptanceCheck}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mt-3 space-y-2">
                    <p className="text-[11px] text-dim">每行一步:title | agent | prompt | 验收标准 | autoCheck=true/false</p>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={Math.min(10, draft.split('\n').length + 1)}
                      className="comic-input w-full resize-y font-mono text-[11.5px]"
                    />
                  </div>
                )}

                {gated && !editing && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void approve('approve')}
                      disabled={busy}
                      className="comic-btn bg-green px-4 py-2 font-display text-[13px] text-white disabled:opacity-40"
                    >
                      批准执行!
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(true)}
                      className="comic-btn bg-white px-3 py-2 font-display text-[13px] text-ink"
                    >
                      修订计划…
                    </button>
                    <button
                      type="button"
                      onClick={() => void approve('reject')}
                      disabled={busy}
                      className="comic-btn bg-white px-3 py-2 font-display text-[13px] text-red"
                    >
                      否决
                    </button>
                  </div>
                )}
                {gated && editing && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const p = parseDraft(run.goal, draft);
                        if (!p) {
                          setError('修订格式不合法:每行需 title | agent | prompt | 验收 | autoCheck(可选)');
                          return;
                        }
                        void approve('approve', p);
                      }}
                      disabled={busy}
                      className="comic-btn bg-green px-4 py-2 font-display text-[13px] text-white disabled:opacity-40"
                    >
                      按修订批准!
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="comic-btn bg-white px-3 py-2 font-display text-[13px] text-ink"
                    >
                      取消修订
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 步骤看板 */}
            {steps.length > 0 && (
              <div className="rounded-xl border-[3px] border-ink bg-white p-4" style={{ boxShadow: '3px 3px 0 #221D15' }}>
                <h3 className="font-display text-[14.5px] text-ink">步骤看板</h3>
                <ol className="mt-3 space-y-2.5">
                  {steps.map((s) => {
                    const st = STEP_STATE[s.state];
                    return (
                      <li key={s.stepId} className="rounded-lg border-2 border-ink bg-panel2/40 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`sticker shrink-0 ${st.cls}`}>{st.label}</span>
                          <span className="font-display text-[13px] text-ink">
                            {s.stepId} · {s.title}
                          </span>
                          <span className="rounded border-2 border-ink bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink">
                            {AGENT_CHARACTER[s.agent]?.name ?? s.agent}
                          </span>
                          {s.attempt > 1 && (
                            <span className="rounded border border-ink bg-white px-1.5 font-mono text-[9.5px] text-orange">
                              第 {s.attempt} 次尝试
                            </span>
                          )}
                          {s.verifyResult && (
                            <span
                              className={`sticker shrink-0 ${
                                s.verifyResult === 'pass' ? 'bg-green text-white' : 'bg-red text-white'
                              }`}
                            >
                              {s.verifyResult === 'pass' ? '验收✓' : '验收✗'}
                            </span>
                          )}
                        </div>
                        {s.verifyReason && <p className="mt-1 text-[11.5px] leading-relaxed text-dim">{s.verifyReason}</p>}
                        {s.output && (
                          <details className="mt-1.5">
                            <summary className="cursor-pointer font-mono text-[10.5px] text-blue">产出原文</summary>
                            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border-2 border-ink bg-ink/5 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink">
                              {s.output}
                            </pre>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            {/* 最终报告 */}
            {run.report && (
              <div className="rounded-xl border-[3px] border-ink bg-white p-4" style={{ boxShadow: '3px 3px 0 #221D15' }}>
                <h3 className="font-display text-[14.5px] text-ink">最终报告</h3>
                <div className="orch-report mt-2">
                  <MdBody text={run.report} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
