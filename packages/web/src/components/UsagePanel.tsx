import { useEffect, useState } from 'react';
import { AGENT_DISPLAY, type AgentId } from '@openharness/core';
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
      <div className="flex h-full items-center justify-center p-4">
        <p className="font-mono text-[12px] text-faint">翻账本中…</p>
      </div>
    );
  }

  const { total, toolCalls, byAgent, byModel, byDay, byProject } = report;
  const agentMax = Math.max(1, ...byAgent.map((a) => a.input + a.output));
  const dayMax = Math.max(1, ...byDay.map((d) => d.input + d.output));
  const projectMax = Math.max(1, ...byProject.map((p) => p.input + p.output));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="累计输入 tokens" value={fmtTokens(total.input)} color="#FF4433" />
        <StatCard label="累计输出 tokens" value={fmtTokens(total.output)} color="#3D8BFF" />
        <StatCard label="工具调用次数" value={toolCalls.toLocaleString()} color="#8B4DFF" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 按工具 */}
        <section className="comic-card p-4">
          <h3 className="font-display text-[14px] text-ink">按工具</h3>
          <ul className="mt-3 space-y-3">
            {byAgent.length === 0 && <p className="text-[12px] text-faint">暂无数据</p>}
            {byAgent.map((a) => (
              <li key={a.agent}>
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-[13px] text-ink">
                    {AGENT_DISPLAY[a.agent as AgentId] ?? a.agent}
                  </span>
                  <span className="font-mono text-[10.5px] text-faint tabular-nums">
                    <span className="text-red">{fmtTokens(a.input)}</span>
                    {' / '}
                    <span className="text-blue">{fmtTokens(a.output)}</span>
                  </span>
                </div>
                <div className="mt-1.5 flex h-4 overflow-hidden rounded-md border-2 border-ink bg-page">
                  <div className="bg-red" style={{ width: `${(a.input / agentMax) * 100}%` }} />
                  <div className="bg-blue" style={{ width: `${(a.output / agentMax) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* 按天 */}
        <section className="comic-card p-4">
          <h3 className="font-display text-[14px] text-ink">近 14 天</h3>
          {byDay.length === 0 ? (
            <p className="mt-3 text-[12px] text-faint">暂无数据</p>
          ) : (
            <div className="mt-3 flex h-32 items-end gap-1">
              {byDay.map((d) => (
                <div
                  key={d.day}
                  className="group flex min-w-0 flex-1 flex-col items-stretch"
                  title={`${d.day} · 入 ${fmtTokens(d.input)} · 出 ${fmtTokens(d.output)}`}
                >
                  <div className="flex h-24 items-end gap-px">
                    <div className="halftone w-1/2 rounded-t-sm border-2 border-b-0 border-ink bg-red" style={{ height: `${(d.input / dayMax) * 100}%` }} />
                    <div className="halftone w-1/2 rounded-t-sm border-2 border-b-0 border-ink bg-blue" style={{ height: `${(d.output / dayMax) * 100}%` }} />
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
              <span className="inline-block h-3 w-3 rounded-sm border-2 border-ink bg-red" /> 输入
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm border-2 border-ink bg-blue" /> 输出
            </span>
          </p>
        </section>
      </div>

      {/* 按项目 */}
      <section className="comic-card mt-4 p-4">
        <h3 className="font-display text-[14px] text-ink">按项目(前 8)</h3>
        <ul className="mt-3 space-y-3">
          {byProject.length === 0 && <p className="text-[12px] text-faint">暂无数据</p>}
          {byProject.map((p) => (
            <li key={p.project} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate font-mono text-[11px] text-dim" title={p.project}>
                {basename(p.project)}
              </span>
              <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-md border-2 border-ink bg-page">
                <div className="halftone h-full bg-red" style={{ width: `${(p.input / projectMax) * 100}%` }} />
              </div>
              <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                <span className="text-red">{fmtTokens(p.input)}</span>
                {' / '}
                <span className="text-blue">{fmtTokens(p.output)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* 按模型 */}
      <section className="comic-card mt-4 p-4">
        <h3 className="font-display text-[14px] text-ink">按模型</h3>
        <ul className="mt-3 space-y-3">
          {byModel.length === 0 && <p className="text-[12px] text-faint">暂无数据</p>}
          {byModel.map((m) => (
            <li key={`${m.agent}-${m.model}`} className="flex items-center gap-3">
              <span className="w-52 shrink-0 truncate font-mono text-[11px] text-dim" title={m.model}>
                {m.model}
              </span>
              <span className="w-20 shrink-0 font-display text-[10.5px] text-faint">
                {AGENT_DISPLAY[m.agent as AgentId] ?? m.agent}
              </span>
              <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-md border-2 border-ink bg-page">
                <div className="halftone h-full bg-red" style={{ width: `${(m.input / agentMax) * 100}%` }} />
              </div>
              <span className="shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                <span className="text-red">{fmtTokens(m.input)}</span>
                {' / '}
                <span className="text-blue">{fmtTokens(m.output)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t-2 border-dashed border-faint/60 pt-2 text-[11px] leading-relaxed text-faint">
          token 数据来自各工具会话记录;Cursor 历史不含用量(显示为 0),Codex 依赖流式事件中的 usage 字段,部分会话可能缺省。DSH 会话不记录模型名(显示"未知"),其模型以配置页 profile 为准。
        </p>
      </section>
    </div>
  );
}

function StatCard(props: { label: string; value: string; color: string }): React.JSX.Element {
  return (
    <div className="comic-card p-4">
      <p className="font-mono text-[11px] text-faint">{props.label}</p>
      <p className="mt-1 font-display text-[26px] tabular-nums" style={{ color: props.color }}>
        {props.value}
      </p>
    </div>
  );
}
