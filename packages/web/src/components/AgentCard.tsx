import type { AgentStatus } from '@openharness/core';
import { AGENT_CHARACTER, AgentAvatar, Spark } from './ComicIcons';

const STATE_BUBBLE: Record<AgentStatus['state'], { text: string; sticker: string; stickerCls: string }> = {
  running: { text: '正在干活,别催我啦!', sticker: 'RUN!', stickerCls: 'bg-red text-white' },
  idle: { text: '待命!有活喊我就行~', sticker: 'OK', stickerCls: 'bg-green text-white' },
  unknown: { text: '咦?我在哪…', sticker: '??', stickerCls: 'bg-faint text-white' },
  disabled: { text: '未接入…等我上线!', sticker: 'OFF', stickerCls: 'bg-faint text-white' },
};

const ROTATIONS = ['-rotate-[0.7deg]', 'rotate-[0.5deg]', '-rotate-[0.4deg]', 'rotate-[0.7deg]'];

function fmtAgo(ts?: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** Agent 卡:漫画格里的特工档案。火花条是签名元素。 */
export function AgentCard(props: { status: AgentStatus; pulse: number; index: number }): React.JSX.Element {
  const { status, pulse, index } = props;
  const s = STATE_BUBBLE[status.state];
  const character = AGENT_CHARACTER[status.agent];
  const litCount = status.state === 'running' ? (pulse % 6) + 1 : 0;

  return (
    <section className={`comic-card p-3.5 ${ROTATIONS[index % ROTATIONS.length]}`}>
      <div className="flex items-center gap-2.5">
        <AgentAvatar agent={status.agent} size={46} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="font-display text-[16px] leading-tight" style={{ color: character.color }}>
              {character.name}
            </h2>
            <span className="text-[10px] text-faint">{character.title}</span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-dim">{status.agent}</p>
        </div>
        <span className={`sticker -rotate-3 ${s.stickerCls}`}>{s.sticker}</span>
      </div>

      {/* 对话气泡 */}
      <div className="bubble mt-3 font-display text-[12.5px] text-ink">{s.text}</div>

      {/* 火花条:每个事件点亮一颗星 */}
      <div className="mt-3 flex items-center justify-between gap-1" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <Spark
            key={`${i}-${i < litCount ? pulse : 'off'}`}
            lit={i < litCount}
            color={character.color}
            size={16}
            className={i < litCount ? 'spark-pop' : undefined}
          />
        ))}
      </div>

      <dl className="mt-3 flex gap-2 font-mono text-[10.5px]">
        <div className="flex-1 rounded-lg border-2 border-ink bg-page px-2 py-1 text-center">
          <dt className="text-faint">会话</dt>
          <dd className="text-ink tabular-nums">{status.sessionsCount}</dd>
        </div>
        <div className="flex-1 rounded-lg border-2 border-ink bg-page px-2 py-1 text-center">
          <dt className="text-faint">任务</dt>
          <dd className="text-ink tabular-nums">
            {status.activeTasks}
            {status.queuedTasks > 0 && <span className="text-faint">·排{status.queuedTasks}</span>}
          </dd>
        </div>
        <div className="flex-1 rounded-lg border-2 border-ink bg-page px-2 py-1 text-center">
          <dt className="text-faint">活跃</dt>
          <dd className="text-ink">{fmtAgo(status.lastSeen)}</dd>
        </div>
      </dl>

      {status.disabledReason && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-faint">{status.disabledReason}</p>
      )}
    </section>
  );
}
