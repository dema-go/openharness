export function TopBar(props: {
  connected: boolean;
  runningCount: number;
  onLaunch: () => void;
  clock: string;
}): React.JSX.Element {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-lg font-600 tracking-tight text-paper">
          OpenHarness
        </h1>
        <span className="cursor-blink -ml-1 inline-block h-4 w-[3px] bg-amber align-middle" aria-hidden />
        <span className="hidden font-mono text-[11px] text-faint sm:inline">个人 Agent 控制台</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden items-center gap-2 font-mono text-[11px] text-dim md:flex">
          <span
            className={`inline-block h-2 w-2 rounded-full ${props.connected ? 'bg-jade' : 'bg-brick'}`}
          />
          {props.connected ? '已连接' : '连接中…'}
        </span>
        {props.runningCount > 0 && (
          <span className="hidden font-mono text-[11px] text-amber sm:inline">
            ● {props.runningCount} 个任务运行中
          </span>
        )}
        <span className="font-mono text-[11px] text-faint tabular-nums">{props.clock}</span>
        <button
          type="button"
          onClick={props.onLaunch}
          className="rounded-sm border border-amber/60 bg-amber/10 px-3 py-1.5 font-display text-[13px] font-500 text-amber transition-colors hover:bg-amber/20"
        >
          ＋ 发任务
        </button>
      </div>
    </header>
  );
}
