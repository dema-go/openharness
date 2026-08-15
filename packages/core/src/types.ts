/**
 * OpenHarness 核心类型:统一事件模型与各 Agent 的通用契约。
 * 所有适配器把工具原生记录归一化为 HarnessEvent,前端只消费统一模型。
 */

export type AgentId = 'cursor' | 'claude' | 'codex' | 'dsh';

export const AGENT_IDS: AgentId[] = ['cursor', 'claude', 'codex', 'dsh'];

export const AGENT_DISPLAY: Record<AgentId, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
};

export type EventKind =
  | 'session-start'
  | 'session-end'
  | 'user-message'
  | 'assistant-message'
  | 'tool-call'
  | 'file-edit'
  | 'error'
  | 'mode-change'
  | 'task-start'
  | 'task-end';

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  'session-start': '会话开始',
  'session-end': '会话结束',
  'user-message': '用户消息',
  'assistant-message': '助手消息',
  'tool-call': '工具调用',
  'file-edit': '文件修改',
  'error': '错误',
  'mode-change': '模式切换',
  'task-start': '任务启动',
  'task-end': '任务结束',
};

/** 归一化事件:所有 Agent 的实时活动都表达为这个结构。 */
export interface HarnessEvent {
  ts: number;
  agent: AgentId;
  projectDir: string | null;
  sessionId: string;
  kind: EventKind;
  /** 人可读摘要,截断到 ~200 字符 */
  summary: string;
  usage?: { input: number; output: number };
  meta?: Record<string, unknown>;
}

/** 会话索引条目(来自各工具本地会话文件,只读)。 */
export interface SessionSummary {
  agent: AgentId;
  sessionId: string;
  projectDir: string | null;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  /** 深链命令:在原生工具中恢复该会话 */
  resumeCommand: string;
}

export type AgentState = 'running' | 'idle' | 'unknown' | 'disabled';

export interface AgentStatus {
  agent: AgentId;
  state: AgentState;
  enabled: boolean;
  disabledReason?: string;
  /** 由本控制台发起的活动任务数 */
  activeTasks: number;
  /** 排队等待执行的任务数 */
  queuedTasks: number;
  /** 已索引会话数 */
  sessionsCount: number;
  lastSeen?: number;
}

export type TaskState = 'queued' | 'running' | 'stopped' | 'error' | 'done';

export interface TaskInfo {
  id: string;
  agent: AgentId;
  cwd: string;
  prompt: string;
  sessionId: string | null;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

export interface LaunchOptions {
  cwd: string;
  prompt: string;
  model?: string;
  /** 控制台任务 ID:适配器在事件 meta 中回传,供任务状态归因 */
  taskId: string;
}

export interface TaskHandle {
  id: string;
  pid?: number;
  stop(): Promise<void>;
}
