/**
 * OpenHarness 核心类型:统一事件模型与各 Agent 的通用契约。
 * 所有适配器把工具原生记录归一化为 HarnessEvent,前端只消费统一模型。
 */

/**
 * AgentId 包含四个 Worker(CLI 工具)与 Supervisor(编排层,平台自身实现的
 * Agent 循环)。AGENT_IDS 只列 Worker:状态卡/发射台面向被编排的工具;
 * Supervisor 经编排接口驱动,不经 /api/tasks 直接发射。
 */
export type AgentId = 'cursor' | 'claude' | 'codex' | 'dsh' | 'supervisor';

export const AGENT_IDS: AgentId[] = ['cursor', 'claude', 'codex', 'dsh'];

export const WORKER_AGENT_IDS: readonly AgentId[] = ['cursor', 'claude', 'codex', 'dsh'];

export const AGENT_DISPLAY: Record<AgentId, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  supervisor: 'Supervisor',
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
  | 'task-end'
  // ---- Supervisor 编排层(平台自身 Agent 循环的活动,meta.supervisorRunId 归因) ----
  | 'plan-created'
  | 'gate-waiting'
  | 'verify-passed'
  | 'verify-failed'
  | 'replan'
  | 'run-finalized';

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
  'plan-created': '计划生成',
  'gate-waiting': '等待审批',
  'verify-passed': '验收通过',
  'verify-failed': '验收失败',
  'replan': '重新规划',
  'run-finalized': '编排完成',
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
  /** 入库序号(服务端返回 / WS 推送携带):分页游标与去重的依据 */
  seq?: number;
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
  /** 展示用的原始任务文案(对话室注入摘要时,prompt 含背景,气泡/活动流用这个) */
  displayPrompt?: string;
  /** 控制台任务 ID:适配器在事件 meta 中回传,供任务状态归因 */
  taskId: string;
  /** 续接的原生会话 ID(对话室连续对话:经各工具原生 --resume 续接) */
  resumeSessionId?: string;
  /** 对话室会话 ID:适配器透传进事件 meta,供消息回填归因 */
  conversationId?: string;
  /**
   * 完全自主:跳过所有权限确认与沙箱限制。
   * claude → --dangerously-skip-permissions;codex → --dangerously-bypass-approvals-and-sandbox;
   * cursor → --yolo --sandbox disabled --approve-mcps;dsh → 由 settings.yaml 的
   * permission.defaultPreset 控制(适配器忽略本字段)。
   */
  bypassPermissions?: boolean;
}

/** 配置只读展示:结构化条目 + 脱敏,绝不展示配置原文 */
export interface AgentConfigEntry {
  key: string;
  value: string;
  /** 敏感值(密钥/token)已脱敏 */
  masked?: boolean;
}

export interface AgentConfigSection {
  title: string;
  items: AgentConfigEntry[];
}

export interface AgentConfigInfo {
  agent: AgentId;
  sections: AgentConfigSection[];
  notes?: string[];
}

/**
 * 可编辑配置字段:配置速览页的编辑表单与预设切换都建立在这层 schema 上。
 * 原则:secret 字段的明文绝不返回给前端——编辑时前端只提交"新值",留空即不改。
 */
export interface ConfigFieldDef {
  /** 稳定标识(预设与写入共用),如 'env.ANTHROPIC_API_KEY' */
  key: string;
  label: string;
  type: 'string' | 'select';
  secret?: boolean;
  /** 密钥是否已设置(secret 字段绝不回传任何值片段) */
  hasValue?: boolean;
  /** type=select 时的可选项 */
  options?: string[];
  /** 当前值:secret 字段恒为空串;未设置的字段为空串 */
  value: string;
  /** 展示分组 */
  group: string;
  /** 额外说明(可选) */
  hint?: string;
}

/** 配置预设(cc switch 式):多套配置快照,一键切换。仅存本机,密钥明文落盘。 */
export interface AgentPreset {
  id: string;
  name: string;
  agent: AgentId;
  /** key → 明文值(secret 字段的明文仅存在于 ~/.openharness/presets.json,绝不下发) */
  values: Record<string, string>;
  createdAt: number;
}

/** 预设的下发形态:密钥值已脱敏 */
export interface AgentPresetPublic {
  id: string;
  name: string;
  agent: AgentId;
  values: Record<string, string>;
  createdAt: number;
}

export interface TaskHandle {
  id: string;
  pid?: number;
  stop(): Promise<void>;
}

// ---- 对话室(会话式连续对话) ----

export type ConversationStage = 'idea' | 'spec' | 'in-progress' | 'review' | 'done';

export const CONVERSATION_STAGES: ConversationStage[] = ['idea', 'spec', 'in-progress', 'review', 'done'];

export const CONVERSATION_STAGE_LABEL: Record<ConversationStage, string> = {
  idea: '想法',
  spec: '方案',
  'in-progress': '进行中',
  review: '评审',
  done: '完成',
};

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 特性生命周期阶段(对标 Clowder Mission Hub 的最小版) */
  stage: ConversationStage;
  /** 最近一条消息摘要(列表展示) */
  lastMessage?: string;
}

export type ConversationRole = 'user' | 'assistant' | 'task' | 'system';

export interface ConversationMessage {
  seq: number;
  convId: string;
  agent: AgentId | null;
  role: ConversationRole;
  content: string;
  taskId?: string | null;
  createdAt: number;
}

/** 对话内每个 Agent 各自的 resume 链状态 */
export interface ConversationAgentState {
  convId: string;
  agent: AgentId;
  /** 该 Agent 当前可续接的原生会话 ID(为空 = 尚未在本对话中回答过) */
  sessionId: string | null;
  cwd: string | null;
}

// ---- Supervisor 编排层(平台自身的 Agent 循环) ----

export type SupervisorMode = 'hitl' | 'auto';

/** run 状态机:planning → (hitl: awaiting_approval) → executing → verifying → reflecting → finalizing → done/failed/stopped */
export type SupervisorRunState =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'reflecting'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'stopped';

/** 计划步骤:由哪位 Worker 执行什么、怎么算完成。 */
export interface PlanStep {
  id: string;
  title: string;
  /** 执行者:四个 Worker 之一(supervisor 不允许) */
  agent: AgentId;
  prompt: string;
  /** 验收标准:交给验收 LLM 判定,或 autoCheck 时只看任务状态 */
  acceptanceCheck: string;
  /** 跳过 LLM 验收,仅以任务 done 状态为准(省 token) */
  autoCheck?: boolean;
}

export interface SupervisorPlan {
  goal: string;
  steps: PlanStep[];
}

export type SupervisorStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SupervisorStepRecord {
  runId: string;
  stepId: string;
  title: string;
  agent: AgentId;
  prompt: string;
  acceptanceCheck: string;
  autoCheck: boolean;
  state: SupervisorStepState;
  taskId: string | null;
  /** 第几次尝试(从 1 起,含自动重试) */
  attempt: number;
  /** 最后一次 Worker 产出摘要(截断入库) */
  output: string | null;
  verifyResult: 'pass' | 'fail' | null;
  verifyReason: string | null;
}

export interface SupervisorRunRecord {
  id: string;
  goal: string;
  cwd: string;
  mode: SupervisorMode;
  state: SupervisorRunState;
  plan: SupervisorPlan | null;
  report: string | null;
  error: string | null;
  /** Supervisor 自身 LLM 消耗(Worker 消耗归各 Agent 事件) */
  usage: { input: number; output: number };
  createdAt: number;
  endedAt: number | null;
}
