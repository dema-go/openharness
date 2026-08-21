# 简历口径与要点(投递前必读)

> 用途:把 OpenHarness 写进简历/作品集时的统一口径。所有能力与指标必须能**从代码或本机运行接口复核**;动态数据投递前重新快照,勿长期硬编码。

## 项目定位(一句话)

**OpenHarness 多 Agent 编排引擎与可观测平台 | 独立项目**

- 一句话:v0.7 起平台自研 **Supervisor 编排循环**(直连 LLM API 的 Plan → 门禁 → Dispatch → Verify → Reflect → Report),把 Cursor / Claude Code / Codex / DeepSeek Harness 四个生产级 Coding Agent 当作可调度的工具;同时保留统一事件模型、任务生命周期与实时观测的控制面能力。
- 两层职责讲清楚(面试高频追问点):**编排层(平台自身实现)**=LLM 调用、规划、验收、重规划循环;**Worker 层(不重造)**=各 CLI 原生的 Planning/Tool Calling/Runtime。两层都真实,不混为一谈。
- 与 WeCare(RAG)互补:WeCare 证明 LLM/RAG 落地能力,OpenHarness 证明 **Agent 工程 + TypeScript 全栈**能力。
- 视觉口径:简历只写「React 可视化控制台」,漫画风作为产品特色保留(作品集另备深色工程风截图),不作为核心卖点。

## 简历要点(逐条可复核)

1. **自研 Supervisor 编排层(v0.7,核心卖点)**:直连 OpenAI 兼容 LLM API(DeepSeek 等,原生 tool-calling 协议)实现「规划 → 人在环审批 → 派发 → 验收 → 重试/重规划 → 汇总报告」Agent 循环;四个 CLI Agent 封装为带 JSON Schema 校验的工具调用,非法入参回填自纠;Token 预算/轮次/重试/超时硬边界在代码层强制;人在环与全自动双模式(复核:`packages/server/src/supervisor/`);
2. 真机双路径验证:正路径(规划→派发 claude 只读分析→LLM 验收→报告,3 轮 LLM 3790+888 tokens 约 25s);失败路径(Worker 遇权限墙→自动重试带失败反馈×2→反思判断 abort,理由「环境权限问题而非方案问题,不应盲目重规划」)(复核:`CHANGELOG` v0.7.0 验证段 + run 记录);
3. 设计统一 `AgentAdapter`,将 JSONL、SQLite、Zstd、流式 JSON 等异构数据归一化为统一事件模型(复核:`packages/core/src/adapter.ts`、各 `packages/agents/src/*/session-file.ts`);
4. 基于原生 CLI 实现任务发射、会话续接(`--resume`)、FIFO 排队、进程组中断和异常任务恢复(复核:`packages/server/src/tasks.ts`);
5. 构建文件增量监听、进程输出捕获、进程状态探测三通道监控链路,通过 WebSocket 实时推送;编排层自身活动(plan/验收/重规划)同样事件化进统一活动流(复核:`packages/agents/src/*/adapter.ts` + `packages/server/src/bus.ts`);
6. 使用 SQLite 实现会话、事件、任务与编排 run 持久化,处理游标续读、双通道去重、服务重启后编排恢复(执行中归位、门禁挂起可续审批)(复核:`packages/server/src/store.ts`);
7. 服务仅监听 `127.0.0.1`,原始会话只读接入,密钥不回显(编排层 LLM Key 同一规范),高风险自主执行能力默认关闭(复核:README 安全边界 + 配置页实测);
8. 自动化测试 67 项断言(含 MockProvider 脚本化 LLM 的编排全链路单测:审批/拒绝/重试/重规划/预算/中止/重启恢复),GitHub Actions CI(typecheck/test/build)(复核:`packages/server/test/supervisor.test.ts`)。

## 数据快照(动态,投递前重新生成)

生成方式(本机运行中时):

```bash
curl -s http://127.0.0.1:3900/api/sessions?limit=1   # total 字段 = 会话数
curl -s http://127.0.0.1:3900/api/usage              # total/toolCalls = tokens/工具调用
```

最近一次快照(2026-08-21):155 个会话 · 665 万 tokens(输入 491 万 / 输出 173 万)· 7436 次工具调用。

## 禁用口径(降低可信度,不要写)

- ❌ "11 个 commit、11 轮迭代"等静态过程数字 → 写「经过多轮真实使用反馈迭代」;
- ❌ 与仓库当前不符的功能/指标(如"配置只读")→ 投递前对照 README 功能全景核对;
- ❌ **混淆两层**:说「实现了四个 Agent 的 Planning/Tool Calling」——Worker 层是 CLI 原生的;平台实现的是**编排层的 Agent 循环**(它自己的规划/工具调用/验收)。v0.7 后可以大方说「自研 Supervisor 编排引擎」,但两句都要能讲清边界;
- ❌ 把编排 UI 说成已上线(当前为 API 级,UI 在 Roadmap)→ 演示用 curl 序列或活动流事件;
- ❌ 夸大数据规模 → 一切指标以重新快照为准。
