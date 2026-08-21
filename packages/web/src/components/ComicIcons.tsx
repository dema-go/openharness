/**
 * 漫画图标库:四个特工 Q 版头像与贴纸图形。
 * 由 Open Design 生成的 design/cartoon-mockup.html 导出,工程师内联移植。
 */
import type { AgentId } from '@openharness/core';

/** 特工档案(supervisor=指挥官:编排层 Agent,无 CLI 运行时) */
export const AGENT_CHARACTER: Record<AgentId, { name: string; title: string; color: string }> = {
  cursor: { name: '光标侠', title: '编辑器内改文件', color: '#FF4433' },
  claude: { name: '小克', title: '工程编排担当', color: '#FF9F1C' },
  codex: { name: '码星人', title: '沙箱实验员', color: '#00C2DC' },
  dsh: { name: '鲸酱', title: '深度复盘担当', color: '#8B4DFF' },
  supervisor: { name: '指挥官', title: '编排与验收', color: '#1F7A4D' },
};

function Defs(): React.JSX.Element {
  return (
    <defs>
      <symbol id="burst" viewBox="0 0 100 100">
        <path
          fill="currentColor"
          stroke="#221D15"
          strokeWidth="5"
          strokeLinejoin="round"
          d="M50.0,2.0 57.8,21.0 74.0,8.4 71.2,28.8 91.6,26.0 79.0,42.2 98.0,50.0 79.0,57.8 91.6,74.0 71.2,71.2 74.0,91.6 57.8,79.0 50.0,98.0 42.2,79.0 26.0,91.6 28.8,71.2 8.4,74.0 21.0,57.8 2.0,50.0 21.0,42.2 8.4,26.0 28.8,28.8 26.0,8.4 42.2,21.0 Z"
        />
      </symbol>
      <symbol id="bolt" viewBox="0 0 100 100">
        <path
          fill="currentColor"
          stroke="#221D15"
          strokeWidth="6"
          strokeLinejoin="round"
          d="M13.5 2 L5 13.5 L11 13.5 L9.5 22 L19 10 L13 10 Z"
        />
      </symbol>
    </defs>
  );
}

/** Q 版特工头像。fill 由外层 CSS 变量 --agent 提供。 */
export function AgentAvatar(props: { agent: AgentId; size?: number; className?: string }): React.JSX.Element {
  const { agent, size = 44, className } = props;
  const color = AGENT_CHARACTER[agent].color;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={{ ['--agent' as string]: color }}
      aria-hidden
    >
      <Defs />
      {agent === 'cursor' && <CursorFace />}
      {agent === 'claude' && <ClaudeFace />}
      {agent === 'codex' && <CodexFace />}
      {agent === 'dsh' && <DshFace />}
    </svg>
  );
}

function CursorFace(): React.JSX.Element {
  return (
    <g>
      <rect x="5" y="14" width="90" height="82" rx="22" fill="var(--agent)" stroke="#221D15" strokeWidth="5" />
      <rect x="0" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <rect x="88" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <line x1="50" y1="14" x2="50" y2="3" stroke="#221D15" strokeWidth="5" />
      <circle cx="50" cy="3" r="8" fill="#FFC531" stroke="#221D15" strokeWidth="4" />
      <rect x="20" y="30" width="60" height="46" rx="13" fill="#fff" stroke="#221D15" strokeWidth="4" />
      <rect x="30" y="44" width="12" height="14" rx="2.5" fill="#221D15" />
      <rect x="58" y="44" width="12" height="14" rx="2.5" fill="#221D15" />
      <path d="M42 66 Q50 72 58 66" stroke="#221D15" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="26" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
      <circle cx="74" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
      <path
        d="M86 2 L97 16 L88 18 L83 25 L77 21 L85 16 Z"
        fill="#fff"
        stroke="#221D15"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </g>
  );
}

function ClaudeFace(): React.JSX.Element {
  return (
    <g>
      <rect x="5" y="14" width="90" height="82" rx="22" fill="var(--agent)" stroke="#221D15" strokeWidth="5" />
      <rect x="0" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <rect x="88" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <line x1="50" y1="14" x2="50" y2="6" stroke="#221D15" strokeWidth="5" />
      <use href="#burst" x="35" y="-9" width="30" height="30" color="#FFC531" />
      <rect x="20" y="30" width="60" height="46" rx="13" fill="#fff" stroke="#221D15" strokeWidth="4" />
      <circle cx="36" cy="51" r="7.5" fill="#221D15" />
      <circle cx="64" cy="51" r="7.5" fill="#221D15" />
      <circle cx="38.5" cy="48.5" r="2.6" fill="#fff" />
      <circle cx="66.5" cy="48.5" r="2.6" fill="#fff" />
      <path d="M40 66 Q50 74 60 66" stroke="#221D15" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="25" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
      <circle cx="75" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
    </g>
  );
}

function CodexFace(): React.JSX.Element {
  return (
    <g>
      <rect x="5" y="14" width="90" height="82" rx="22" fill="var(--agent)" stroke="#221D15" strokeWidth="5" />
      <rect x="0" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <rect x="88" y="40" width="12" height="26" rx="5" fill="var(--agent)" stroke="#221D15" strokeWidth="4" />
      <line x1="50" y1="14" x2="50" y2="4" stroke="#221D15" strokeWidth="5" />
      <use href="#bolt" x="38" y="-7" width="24" height="24" color="#FFC531" />
      <rect x="20" y="30" width="60" height="46" rx="13" fill="#fff" stroke="#221D15" strokeWidth="4" />
      <rect x="27" y="44" width="46" height="17" rx="8.5" fill="#221D15" />
      <circle cx="40" cy="52.5" r="3" fill="#fff" />
      <circle cx="60" cy="52.5" r="3" fill="#fff" />
      <path d="M40 66 Q50 71 61 62" stroke="#221D15" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="25" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
      <circle cx="75" cy="61" r="5" fill="#FF8FB1" opacity=".85" />
    </g>
  );
}

function DshFace(): React.JSX.Element {
  return (
    <g>
      <circle cx="50" cy="4" r="6" fill="#00C2DC" stroke="#221D15" strokeWidth="3.5" />
      <circle cx="62" cy="1" r="4.5" fill="#00C2DC" stroke="#221D15" strokeWidth="3" />
      <circle cx="74" cy="5" r="3.2" fill="#00C2DC" stroke="#221D15" strokeWidth="3" />
      <path
        d="M18 60 L3 44 Q-2 58 3 62 L9 72 L17 70 Z"
        fill="var(--agent)"
        stroke="#221D15"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <ellipse cx="52" cy="58" rx="37" ry="27" fill="var(--agent)" stroke="#221D15" strokeWidth="5" />
      <ellipse cx="48" cy="69" rx="20" ry="10.5" fill="#fff" stroke="#221D15" strokeWidth="3" />
      <path d="M42 32 Q46 24 50 32 L58 32 Q62 24 66 32 Z" fill="var(--agent)" stroke="#221D15" strokeWidth="4" strokeLinejoin="round" />
      <circle cx="70" cy="50" r="5.5" fill="#221D15" />
      <circle cx="72" cy="48" r="2" fill="#fff" />
      <path d="M62 66 Q70 73 80 64" stroke="#221D15" strokeWidth="4" fill="none" strokeLinecap="round" />
      <circle cx="36" cy="56" r="5" fill="#FF8FB1" opacity=".8" />
    </g>
  );
}

/** 星形火花(火花条单元,可点亮) */
export function Spark(props: { lit: boolean; color?: string; size?: number; className?: string }): React.JSX.Element {
  const { lit, color = '#FFC531', size = 14, className } = props;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
      <path
        fill={lit ? color : 'transparent'}
        stroke="#221D15"
        strokeWidth="2"
        strokeLinejoin="round"
        d="M12.0,1.5 12.0,12.0 22.5,12.0 12.0,12.0 12.0,22.5 12.0,12.0 1.5,12.0 12.0,12.0 Z"
      />
    </svg>
  );
}

/** 爆炸星形徽章(标题/重点) */
export function Burst(props: { color?: string; size?: number; className?: string }): React.JSX.Element {
  const { color = '#FFC531', size = 40, className } = props;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      <path
        fill={color}
        stroke="#221D15"
        strokeWidth="5"
        strokeLinejoin="round"
        d="M50.0,2.0 57.8,21.0 74.0,8.4 71.2,28.8 91.6,26.0 79.0,42.2 98.0,50.0 79.0,57.8 91.6,74.0 71.2,71.2 74.0,91.6 57.8,79.0 50.0,98.0 42.2,79.0 26.0,91.6 28.8,71.2 8.4,74.0 21.0,57.8 2.0,50.0 21.0,42.2 8.4,26.0 28.8,28.8 26.0,8.4 42.2,21.0 Z"
      />
    </svg>
  );
}

/** 手绘波浪下划线 */
export function Squiggle(props: { color?: string; width?: number; className?: string }): React.JSX.Element {
  const { color = '#FF4433', width = 60, className } = props;
  return (
    <svg viewBox="0 0 120 12" width={width} height={10} className={className} aria-hidden>
      <path
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        d="M2 8 Q12 0 22 8 T42 8 T62 8 T82 8 T102 8 T118 8"
      />
    </svg>
  );
}
