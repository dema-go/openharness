import type {
  AgentConfigInfo,
  AgentId,
  AgentStatus,
  ConfigFieldDef,
  HarnessEvent,
  LaunchOptions,
  SessionSummary,
  TaskHandle,
} from './types.js';

/** 会话文件解析游标存储:保证重启后增量续读、事件不重复入库。 */
export interface CursorStore {
  get(filePath: string): number;
  set(filePath: string, offset: number): void;
}

export interface IndexHandlers {
  onEvent(e: HarnessEvent): void;
  onSummary(s: SessionSummary): void;
}

/**
 * AgentAdapter:每个 Agent 工具一个实现。
 * 原则:只读工具本地数据、只经原生 CLI 控制,不重新实现任何能力。
 */
export interface AgentAdapter {
  agentId: AgentId;
  displayName: string;
  enabled: boolean;
  disabledReason?: string;

  /** 列出工具本地存储中的全部会话(只读索引)。 */
  listSessions(): Promise<SessionSummary[]>;

  /**
   * 解析会话文件,产生归一化事件与会话汇总(启动时重建索引)。
   * 已消费的字节偏移写入游标存储,避免重复入库。
   */
  indexEvents(handlers: IndexHandlers): Promise<void>;

  /**
   * 开始监听会话目录,新增记录实时回调。返回停止函数。
   */
  watch(onEvent: (e: HarnessEvent) => void): Promise<() => Promise<void>>;

  /** 通过原生 CLI 启动一个任务;事件实时回调。 */
  launch(opts: LaunchOptions, onEvent: (e: HarnessEvent) => void): Promise<TaskHandle>;

  /** 该工具进程当前是否在运行(粗粒度状态探测)。 */
  probe(): Promise<boolean>;

  /** 生成在原生工具中恢复会话的命令(深链)。 */
  resumeCommand(sessionId: string): string;

  /** 只读配置摘要(结构化 + 密钥脱敏,绝不返回配置原文)。 */
  describeConfig(): Promise<AgentConfigInfo>;

  /** 可编辑配置字段 schema(当前值已按 secret 规则脱敏)。 */
  configSchema(): Promise<ConfigFieldDef[]>;

  /**
   * 写入配置:key → 新值。secret 字段仅当用户提交了新值才会出现;
   * 返回实际写入的字段 key 列表。实现负责保留配置文件中的其他内容。
   */
  updateConfig(values: Record<string, string>): Promise<{ applied: string[] }>;

  /** 读取 schema 字段的当前明文值(仅供服务端做预设快照,绝不返回给前端)。 */
  getConfigValues(): Promise<Record<string, string>>;

  /** 汇总为 AgentStatus(由 server 填充 activeTasks / queuedTasks / sessionsCount)。 */
  describeStatus(extra: Pick<AgentStatus, 'activeTasks' | 'queuedTasks' | 'sessionsCount'>): AgentStatus;
}
