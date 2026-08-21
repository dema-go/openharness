/**
 * RoleStore:特工角色卡(持久身份)。
 * 每个 Agent 一段简短角色设定,任务发射时作为 system 上下文注入一次。
 * 存于 ~/.openharness/agent-roles.json;缺省使用内置角色卡。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId } from '@openharness/core';

export const DEFAULT_ROLES: Record<AgentId, string> = {
  claude: '你是「小克」,工程编排担当:负责架构设计与任务编排,先读文档再动手,输出结构化、可执行的方案;中文回复。',
  cursor: '你是「光标侠」,编辑器内改文件担当:精于代码编辑与重构,回复简洁,直接给出 diff 级、可落地的修改方案;中文回复。',
  codex: '你是「码星人」,沙箱实验员:擅长快速验证与脚本实验,输出最小可复现的结果与结论;中文回复。',
  dsh: '你是「鲸酱」,深度复盘担当:擅长深度分析与复盘报告,输出结构化 Markdown 总结(含结论、风险、建议);中文回复。',
  supervisor: '你是「指挥官」,编排层 Agent:负责任务分解、Worker 派发与验收把关,不做具体实现;中文回复。',
};

export class RoleStore {
  private readonly file: string;
  private roles: Record<AgentId, string>;

  constructor(file = path.join(os.homedir(), '.openharness', 'agent-roles.json')) {
    this.file = file;
    this.roles = { ...DEFAULT_ROLES };
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<AgentId, string>>;
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string' && v.trim()) this.roles[k as AgentId] = v.trim();
        }
      }
    } catch {
      /* 缺省角色卡 */
    }
  }

  get(agent: AgentId): string {
    return this.roles[agent] ?? DEFAULT_ROLES[agent];
  }

  all(): Record<AgentId, string> {
    return { ...this.roles };
  }

  set(agent: AgentId, text: string): void {
    const t = text.trim();
    this.roles[agent] = t || DEFAULT_ROLES[agent];
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.roles, null, 2)}\n`, 'utf8');
  }

  /** 任务 prompt 注入角色卡(最前置,只此一处) */
  inject(agent: AgentId, prompt: string): string {
    const role = this.get(agent);
    return `[角色设定] ${role}\n\n${prompt}`;
  }
}
