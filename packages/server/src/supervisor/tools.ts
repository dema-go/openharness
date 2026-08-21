/**
 * Supervisor 工具注册表:编排即工具调用。
 * 「派发任务给 CLI Agent」与普通 Agent 的 read_file 一样,是带 schema 的工具:
 * 执行前先做入参校验(非法入参返回 error 让模型自纠,不 throw),
 * 执行状态由边界判定(dispatch 是否成功、任务 exit 状态),不做内容字符串启发式。
 */
import type { AgentId, HarnessEvent } from '@openharness/core';
import { WORKER_AGENT_IDS } from '@openharness/core';

export interface ToolResult {
  ok: boolean;
  /** 回填给 LLM 的输出(调用方负责总长截断) */
  output: string;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ParamDef {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface SupervisorTool {
  name: string;
  description: string;
  parameters: Record<string, ParamDef>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具执行上下文:由 SupervisorManager 提供(生命周期/等待/查询都归 manager) */
export interface ToolContext {
  runId: string;
  cwd: string;
  /** 派发并等待一个 Worker 任务收尾(含超时打断与产出收集) */
  launchAndWait: (agent: AgentId, prompt: string, timeoutMs: number) => Promise<{
    taskId: string;
    state: string;
    exitCode: number | null;
    output: string;
  }>;
  /** 查询统一事件流(观察面复用) */
  queryEvents: (filter: { agent?: string; kind?: string; q?: string; limit?: number }) => HarnessEvent[];
  memory: { read(): string; append(text: string): void };
}

/** 入参校验:返回错误消息(null = 通过)。手写实现,零依赖。 */
export function validateArgs(
  tool: Pick<SupervisorTool, 'name' | 'parameters'>,
  args: Record<string, unknown>,
): string | null {
  for (const [key, def] of Object.entries(tool.parameters)) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      if (def.required) return `参数 "${key}" 缺失(需要 ${def.type})`;
      continue;
    }
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== def.type) {
      return `参数 "${key}" 类型错误:需要 ${def.type},实际 ${actual}`;
    }
    if (def.enum && !def.enum.includes(String(value))) {
      return `参数 "${key}" 取值 "${String(value)}" 不在允许范围 [${def.enum.join(', ')}]`;
    }
  }
  return null;
}

function trunc(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[截断,全文 ${text.length} 字符]` : text;
}

// ---- 工具实现 ----

const dispatchTask: SupervisorTool = {
  name: 'dispatch_task',
  description:
    '把一个子任务派发给指定 Worker Agent(CLI)同步执行并等待收尾。返回任务最终状态与产出摘要。适合需要真实改代码/跑命令的步骤。',
  parameters: {
    agent: {
      type: 'string',
      description: '执行者',
      required: true,
      enum: [...WORKER_AGENT_IDS],
    },
    prompt: { type: 'string', description: '给 Worker 的完整任务指令(含上下文与边界)', required: true },
    timeoutMinutes: { type: 'number', description: '该步超时分钟数(默认 30)' },
  },
  async execute(args, ctx) {
    const agent = String(args.agent) as AgentId;
    const prompt = String(args.prompt);
    const timeoutMs = Math.max(1, Number(args.timeoutMinutes ?? 30)) * 60_000;
    const r = await ctx.launchAndWait(agent, prompt, timeoutMs);
    const ok = r.state === 'done';
    return {
      ok,
      output: [
        `任务 ${r.taskId} 已收尾:state=${r.state}${r.exitCode !== null ? ` exit=${r.exitCode}` : ''}`,
        r.output ? `产出:\n${trunc(r.output, 3500)}` : '(无文本产出)',
      ].join('\n'),
    };
  },
};

const queryEvents: SupervisorTool = {
  name: 'query_events',
  description: '查询统一活动事件流(全部 Agent 的会话/任务/错误事件),用于规划前了解项目近况与各 Agent 状态。',
  parameters: {
    agent: { type: 'string', description: '按 Agent 过滤(cursor/claude/codex/dsh)', enum: [...WORKER_AGENT_IDS] },
    kind: { type: 'string', description: '按事件类型过滤(如 task-end/error)' },
    q: { type: 'string', description: '关键词' },
    limit: { type: 'number', description: '返回条数(默认 20,最大 100)' },
  },
  async execute(args, ctx) {
    const events = ctx.queryEvents({
      agent: args.agent ? String(args.agent) : undefined,
      kind: args.kind ? String(args.kind) : undefined,
      q: args.q ? String(args.q) : undefined,
      limit: Math.min(Math.max(Number(args.limit ?? 20), 1), 100),
    });
    if (!events.length) return { ok: true, output: '(无匹配事件)' };
    return {
      ok: true,
      output: events.map((e) => `- [${e.agent}] ${e.kind}: ${e.summary}`).join('\n'),
    };
  },
};

const memoryRead: SupervisorTool = {
  name: 'memory_read',
  description: '读取团队共享记忆(跨会话经验沉淀),规划时可参考。',
  parameters: {},
  async execute(_args, ctx) {
    const text = ctx.memory.read().trim();
    return { ok: true, output: text ? trunc(text, 3000) : '(暂无记忆)' };
  },
};

const memoryWrite: SupervisorTool = {
  name: 'memory_write',
  description: '向团队共享记忆追加一条经验(一行,简明扼要),供后续任务参考。',
  parameters: { text: { type: 'string', description: '要记住的内容(单行)', required: true } },
  async execute(args, ctx) {
    ctx.memory.append(String(args.text));
    return { ok: true, output: '已记入团队记忆。' };
  },
};

/** M1 工具集:派发 + 观察查询 + 记忆(并行派发/交叉评审/read_session 见 M3) */
export const SUPERVISOR_TOOLS: SupervisorTool[] = [dispatchTask, queryEvents, memoryRead, memoryWrite];

export function findTool(name: string): SupervisorTool | undefined {
  return SUPERVISOR_TOOLS.find((t) => t.name === name);
}

/** 校验并执行一个工具调用:非法入参返回 error 结果(回填 LLM 自纠),不 throw。 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return { ok: false, output: `Error: 未知工具 "${name}"` };
  const invalid = validateArgs(tool, args);
  if (invalid) return { ok: false, output: `Error: 入参校验失败 —— ${invalid}` };
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return { ok: false, output: `Error: 工具执行异常 —— ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 供 LLM 使用的工具 schema(OpenAI function 格式) */
export function toolSchemas(names: string[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return SUPERVISOR_TOOLS.filter((t) => names.includes(t.name)).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, def]) => [
            k,
            { type: def.type, description: def.description, ...(def.enum ? { enum: def.enum } : {}) },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, def]) => def.required)
          .map(([k]) => k),
      },
    },
  }));
}
