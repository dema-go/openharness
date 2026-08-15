/**
 * 建议引擎 v0.1(规则版):任务文本关键词 × 工具特色矩阵 → 推荐列表。
 * 只给建议与理由,人做最终决定(PRD F3)。
 */
import { AGENT_DISPLAY, type AgentId } from '@openharness/core';

interface Rule {
  re: RegExp;
  weight: number;
  reason: string;
}

const CAPABILITY: Record<AgentId, string> = {
  cursor: 'IDE 深度集成、Composer 多文件重构、Tab 补全',
  claude: 'hooks、plan 模式、subagents、terminal 直控,适合多步编排',
  codex: 'sandbox 沙箱隔离执行、computer use、rollout,适合实验性代码',
  dsh: 'profile/plugin 可组合体系、多 provider、MCP 生态',
};

const RULES: Record<AgentId, Rule[]> = {
  cursor: [
    { re: /重构|refactor|编辑器|补全|composer|ide|多文件修改|跨文件/, weight: 3, reason: '涉及编辑器内多文件重构' },
    { re: /ui|前端|组件|页面|样式|界面/, weight: 1, reason: '前端/UI 工作适合在 IDE 内迭代' },
  ],
  claude: [
    { re: /编排|多步|流程|pipeline|hook|长期项目|架构|cli|脚本|终端|命令行/, weight: 3, reason: '多步编排/CLI 工程化是 Claude Code 强项' },
    { re: /计划|plan|方案|设计文档|调研/, weight: 2, reason: 'plan 模式适合先规划再动手' },
  ],
  codex: [
    { re: /沙箱|隔离|实验|风险|试运行|不安全|sandbox|explor|prototype|原型/, weight: 3, reason: '沙箱隔离执行,适合实验性代码' },
    { re: /浏览器|网页操作|爬虫|抓取|测试网页|computer use/, weight: 2, reason: 'computer use 可操作真实浏览器/桌面' },
  ],
  dsh: [
    { re: /插件|plugin|profile|mcp|多模型|多provider|对比.*模型|评测/, weight: 3, reason: 'profile/plugin/MCP 体系是 DSH 的特色' },
    { re: /harness|自建|工具链|补丁|patch/, weight: 2, reason: 'harness 层组合能力匹配' },
  ],
};

export interface Suggestion {
  agent: AgentId;
  display: string;
  score: number;
  reasons: string[];
  capability: string;
  enabled: boolean;
}

export function suggest(prompt: string, enabledAgents: Set<AgentId>): Suggestion[] {
  const text = prompt.toLowerCase();
  const out: Suggestion[] = (Object.keys(RULES) as AgentId[]).map((agent) => {
    let score = 0;
    const reasons: string[] = [];
    for (const rule of RULES[agent]) {
      if (rule.re.test(text) || rule.re.test(prompt)) {
        score += rule.weight;
        reasons.push(rule.reason);
      }
    }
    return {
      agent,
      display: AGENT_DISPLAY[agent],
      score,
      reasons,
      capability: CAPABILITY[agent],
      enabled: enabledAgents.has(agent),
    };
  });
  return out.sort((a, b) => b.score - a.score || Number(a.enabled) - Number(b.enabled)).slice(0, 3);
}
