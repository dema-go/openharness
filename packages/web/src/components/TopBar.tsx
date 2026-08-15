import { Burst } from './ComicIcons';

export function TopBar(props: {
  connected: boolean;
  runningCount: number;
  onLaunch: () => void;
  clock: string;
}): React.JSX.Element {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b-[3px] border-ink px-3 sm:px-5">
      <div className="flex items-center gap-3">
        <Burst size={44} className="-rotate-6" />
        <div className="-ml-2">
          <h1
            className="font-comic text-[18px] leading-none tracking-wide text-red sm:text-[22px]"
            style={{ WebkitTextStroke: '1px #221D15', textShadow: '2px 2px 0 #fff' }}
          >
            OPENHARNESS
          </h1>
          <p className="mt-0.5 hidden font-display text-[11px] text-dim sm:block">个人 Agent 特工小队 · 控制台</p>
        </div>
        <span className="sticker -rotate-3 bg-yellow max-sm:hidden">BETA!</span>
      </div>

      <div className="flex items-center gap-3">
        {props.runningCount > 0 && (
          <span className="sticker rotate-2 bg-cyan text-white">
            特工出动 ×{props.runningCount}
          </span>
        )}
        <span className="hidden items-center gap-2 rounded-lg border-2 border-ink bg-white px-2.5 py-1 font-mono text-[11px] sm:flex">
          <span className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-ink ${props.connected ? 'bg-green' : 'bg-red'}`} />
          {props.connected ? '连线中' : '断线啦'}
        </span>
        <span className="hidden rounded-lg border-2 border-ink bg-white px-2.5 py-1 font-mono text-[11px] tabular-nums md:inline">
          {props.clock}
        </span>
        <button
          type="button"
          onClick={props.onLaunch}
          className="comic-btn flex items-center gap-2 bg-red px-4 py-2 text-[15px] text-white hover:bg-red/90"
        >
          <Bolt color="#FFC531" size={16} />
          发任务!
        </button>
      </div>
    </header>
  );
}

function Bolt(props: { color?: string; size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" width={props.size ?? 16} height={props.size ?? 16} aria-hidden>
      <path
        fill={props.color ?? '#FFC531'}
        stroke="#221D15"
        strokeWidth="6"
        strokeLinejoin="round"
        d="M13.5 2 L5 13.5 L11 13.5 L9.5 22 L19 10 L13 10 Z"
      />
    </svg>
  );
}
