import type { AgentStatus } from '@openharness/core';
import { AGENT_DISPLAY } from '@openharness/core';

const STATE_LABEL: Record<AgentStatus['state'], { text: string; cls: string }> = {
  running: { text: '运行中', cls: 'text-amber' },
  idle: { text: '待命', cls: 'text-jade' },
  unknown: { text: '未知', cls: 'text-faint' },
  disabled: { text: '未接入', cls: 'text-faint' },
};

function fmtAgo(ts?: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** Agent 卡:机架插槽。LED 信号表是整页的签名元素。 */
export function AgentCard(props: { status: AgentStatus; pulse: number }): React.JSX.Element {
  const { status, pulse } = props;
  const s = STATE_LABEL[status.state];
  const lit = status.state === 'running' ? (pulse % 12) + 1 : 0;

  return (
    <section
      className={`rounded-sm border bg-panel p-4 transition-colors ${
        status.state === 'running' ? 'border-amber/40' : 'border-line hover:border-faint'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              status.state === 'running'
                ? 'orb-running bg-amber'
                : status.state === 'idle'
                  ? 'bg-jade'
                  : 'bg-faint'
            }`}
          />
          <h2 className="font-display text-[15px] font-500 text-paper">
            {AGENT_DISPLAY[status.agent]}
          </h2>
        </div>
        <span className={`font-mono text-[11px] ${s.cls}`}>{s.text}</span>
      </div>

      {/* LED 信号表:每个事件点亮一盏灯 */}
      <div className="mt-3 flex gap-1" aria-hidden>
        {Array.from({ length: 12 }, (_, i) => (
          <span
            key={`${i}-${i === lit - 1 ? pulse : 'off'}`}
            className={`h-1.5 flex-1 rounded-[1px] ${
              i < lit ? (i === lit - 1 ? 'lamp-on bg-amber' : 'bg-amber/50') : 'bg-line'
            }`}
          />
        ))}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <div>
          <dt className="text-faint">会话</dt>
          <dd className="mt-0.5 text-dim tabular-nums">{status.sessionsCount}</dd>
        </div>
        <div>
          <dt className="text-faint">任务</dt>
          <dd className={`mt-0.5 tabular-nums ${status.activeTasks > 0 ? 'text-amber' : 'text-dim'}`}>
            {status.activeTasks}
          </dd>
        </div>
        <div>
          <dt className="text-faint">活跃</dt>
          <dd className="mt-0.5 text-dim">{fmtAgo(status.lastSeen)}</dd>
        </div>
      </dl>

      {status.disabledReason && (
        <p className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
          {status.disabledReason}
        </p>
      )}
    </section>
  );
}
