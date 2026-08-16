# 简历口径与要点(投递前必读)

> 用途:把 OpenHarness 写进简历/作品集时的统一口径。所有能力与指标必须能**从代码或本机运行接口复核**;动态数据投递前重新快照,勿长期硬编码。

## 项目定位(一句话)

**OpenHarness 多 Agent 编排与可观测平台 | 独立项目**

- 一句话:统一接入 Cursor / Claude Code / Codex / DeepSeek Harness 四个生产级 AI Coding Agent,提供任务控制、会话索引与实时观测的本地控制面;不重新实现模型层 Agent,而是解决异构适配、任务生命周期、会话状态、实时观测与安全边界问题。
- 与 WeCare(RAG)互补:WeCare 证明 LLM/RAG 落地能力,OpenHarness 证明 **Agent 工程 + TypeScript 全栈**能力。
- 视觉口径:简历只写「React 可视化控制台」,漫画风作为产品特色保留(作品集另备深色工程风截图),不作为核心卖点。

## 简历要点(逐条可复核)

1. 设计统一 `AgentAdapter`,将 JSONL、SQLite、Zstd、流式 JSON 等异构数据归一化为统一事件模型(复核:`packages/core/src/adapter.ts`、各 `packages/agents/src/*/session-file.ts`);
2. 基于原生 CLI 实现任务发射、会话续接(`--resume`)、FIFO 排队、进程组中断和异常任务恢复(复核:`packages/server/src/tasks.ts`);
3. 构建文件增量监听、进程输出捕获、进程状态探测三通道监控链路,通过 WebSocket 实时推送(复核:`packages/agents/src/*/adapter.ts` + `packages/server/src/bus.ts`);
4. 使用 SQLite 实现会话、事件和任务持久化,处理游标续读、双通道去重和 Token 重复统计等问题(复核:`packages/server/src/store.ts`);
5. 服务仅监听 `127.0.0.1`,原始会话只读接入,密钥不回显,高风险自主执行能力默认关闭(复核:README 安全边界 + 配置页实测)。

## 数据快照(动态,投递前重新生成)

生成方式(本机运行中时):

```bash
curl -s http://127.0.0.1:3900/api/sessions?limit=1   # total 字段 = 会话数
curl -s http://127.0.0.1:3900/api/usage              # total/toolCalls = tokens/工具调用
```

最近一次快照(2026-08-16):137 个会话 · 458 万 tokens · 5880 次工具调用。

## 禁用口径(降低可信度,不要写)

- ❌ "11 个 commit、11 轮迭代"等静态过程数字 → 写「经过多轮真实使用反馈迭代」;
- ❌ 与仓库当前不符的功能/指标(如"配置只读")→ 投递前对照 README 功能全景核对;
- ❌ 把适配器模式包装成"自研 Agent 框架/多 Agent 协作平台" → 会误导面试官以为实现了模型层 Planning/Tool Calling/Runtime;
- ❌ 夸大数据规模 → 一切指标以重新快照为准。
