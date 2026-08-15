import { useEffect, useState } from 'react';
import { AGENT_DISPLAY } from '@openharness/core';
import { api, type UsageReport } from '../lib/api';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

export function UsagePanel(): React.JSX.Element {
  const [report, setReport] = useState<UsageReport | null>(null);

  useEffect(() => {
    api
      .usage()
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  if (!report) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[12px] text-faint">加载用量数据…</p>
      </div>
    );
  }

  const { total, toolCalls, byAgent, byDay, byProject } = report;
  const agentMax = Math.max(1, ...byAgent.map((a) => a.input + a.output));
  const dayMax = Math.max(1, ...byDay.map((d) => d.input + d.output));
  const projectMax = Math.max(1, ...byProject.map((p) => p.input + p.output));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="累计输入 tokens" value={fmtTokens(total.input)} tone="text-amber" />
        <StatCard label="累计输出 tokens" value={fmtTokens(total.output)} tone="text-jade" />
        <StatCard label="工具调用次数" value={toolCalls.toLocaleString()} tone="text-paper" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* 按工具 */}
        <section className="rounded-sm border border-line bg-panel p-4">
          <h3 className="font-display text-[13px] font-500 text-paper">按工具</h3>
          <ul className="mt-3 space-y-2.5">
            {byAgent.length === 0 && <p className="text-[12px] text-faint">暂无数据</p>}
            {byAgent.map((a) => {
              const share = (a.input + a.output) / agentMax;
              return (
                <li key={a.agent}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-dim">{AGENT_DISPLAY[a.agent as keyof typeof AGENT_DISPLAY] ?? a.agent}</span>
                    <span className="font-mono text-[11px] text-faint tabular-nums">
                      <span className="text-amber">{fmtTokens(a.input)}</span>
                      {' / '}
                      <span className="text-jade">{fmtTokens(a.output)}</span>
                    </span>
                  </div>
                  <div className="mt-1 flex h-1.5 overflow-hidden rounded-[1px] bg-line">
                    <div className="bg-amber" style={{ width: `${(a.input / agentMax) * 100}%` }} />
                    <div className="bg-jade" style={{ width: `${(a.output / agentMax) * 100}%` }} />
                    <div style={{ width: `${(1 - share) * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* 按天 */}
        <section className="rounded-sm border border-line bg-panel p-4">
          <h3 className="font-display text-[13px] font-500 text-paper">近 14 天</h3>
          {byDay.length === 0 ? (
            <p className="mt-3 text-[12px] text-faint">暂无数据</p>
          ) : (
            <div className="mt-3 flex h-32 items-end gap-1">
              {byDay.map((d) => (
                <div key={d.day} className="group flex min-w-0 flex-1 flex-col items-stretch" title={`${d.day} · 入 ${fmtTokens(d.input)} · 出 ${fmtTokens(d.output)}`}>
                  <div className="flex h-24 items-end">
                    <div className="w-1/2 bg-amber/80" style={{ height: `${(d.input / dayMax) * 100}%` }} />
                    <div className="w-1/2 bg-jade/80" style={{ height: `${(d.output / dayMax) * 100}%` }} />
                  </div>
                  <span className="mt-1 text-center font-mono text-[9px] text-faint tabular-nums">
                    {d.day.slice(5)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 flex items-center gap-4 font-mono text-[10px] text-faint">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-3 bg-amber/80" /> 输入
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-3 bg-jade/80" /> 输出
            </span>
          </p>
        </section>
      </div>

      {/* 按项目 */}
      <section className="mt-5 rounded-sm border border-line bg-panel p-4">
        <h3 className="font-display text-[13px] font-500 text-paper">按项目(前 8)</h3>
        <ul className="mt-3 space-y-2.5">
          {byProject.length === 0 && <p className="text-[12px] text-faint">暂无数据</p>}
          {byProject.map((p) => (
            <li key={p.project} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate font-mono text-[11px] text-dim" title={p.project}>
                {basename(p.project)}
              </span>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[1px] bg-line">
                <div className="bg-amber" style={{ width: `${(p.input / projectMax) * 100}%` }} />
              </div>
              <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                <span className="text-amber">{fmtTokens(p.input)}</span>
                {' / '}
                <span className="text-jade">{fmtTokens(p.output)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
          token 数据来自各工具会话记录;Cursor 历史不含用量(显示为 0),Codex 依赖流式事件中的 usage 字段,部分会话可能缺省。
        </p>
      </section>
    </div>
  );
}

function StatCard(props: { label: string; value: string; tone: string }): React.JSX.Element {
  return (
    <div className="rounded-sm border border-line bg-panel p-4">
      <p className="font-mono text-[11px] text-faint">{props.label}</p>
      <p className={`mt-1 font-display text-[26px] font-500 tabular-nums ${props.tone}`}>{props.value}</p>
    </div>
  );
}
