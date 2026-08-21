# OpenHarness 项目总结(面试向)

> 一段话版本:OpenHarness 是**多 Agent 编排引擎与可观测控制台**——v0.7 起平台自研 **Supervisor 编排循环**:直连 OpenAI 兼容 LLM(DeepSeek)实现「规划 → 人在环审批 → 派发 → 验收 → 重试/重规划 → 汇总报告」的 Agent 循环,把 Cursor、Claude Code、Codex、DeepSeek Harness 四个生产级 Coding Agent 当作带 Schema 校验的工具调度,Token 预算/轮次/重试/超时硬边界代码层强制,真机双路径验证(正路径全链路 done;失败路径自动重试后反思中止)。同时保留控制面能力:统一 `AgentAdapter` 异构数据归一化、原生 CLI 任务生命周期、实时观测、密钥零回显。Worker 层不重造模型层 Agent——平台做编排,工具做执行。TypeScript 全栈,67 项自动化测试,多轮真实使用反馈迭代。
>
> 与 WeCare RAG 项目互补:WeCare 证明 LLM/RAG 落地能力,OpenHarness 证明 **Agent 编排工程 + TypeScript 全栈**能力。

## 1. 背景与问题

同时使用多个 AI 编程工具的人有一个共同痛点:**任务散落在各工具的会话里,谁在干什么、干到哪了、花了多少,没有全局视野;更大的目标没人拆——你成了四个工具之间的「人肉路由器」**。市面上「统一入口」方案大多用 API 重造能力,丢失工具原生特色(hooks、sandbox、plan、profile 体系)。

## 2. 我的解法

**分层原则**:编排层(平台自身实现)负责规划、验收、重规划与纪律;Worker 层(四个 CLI 原生)负责执行;控制面负责观测与生命周期。核心原则:**Supervisor 编排工具,不重造工具**。

## 2.5 Supervisor 编排层(v0.7,核心)

- **Agent 循环**:planning(LLM 结构化规划,可先调 query_events/memory_read 收集背景)→ [hitl] awaiting_approval(门禁挂起可跨重启续审批)→ executing(经 TaskManager 派发 Worker,验收失败自动重试且注入失败反馈)→ verifying(LLM 按 acceptanceCheck 验收;autoCheck 只看任务状态)→ reflecting(重试耗尽决定 replan/abort)→ finalizing(LLM 汇总报告);
- **LLM Provider**:OpenAI 兼容协议直连(DeepSeek/Qwen/GLM/Kimi/Ollama 通用),原生 tool-calling 消息协议(assistant.tool_calls + tool 回填),零 SDK 依赖;
- **工具注册表**:dispatch_task / query_events / memory_read / memory_write——「派发任务」本身就是工具调用;手写 JSON Schema 入参校验,非法入参返回 error 回填模型自纠(不 throw);执行状态由边界判定(dispatch 是否成功、任务 exit 状态),不做内容字符串启发式;
- **硬边界**(代码层强制,不依赖 prompt 自觉):Token 预算 200k / 规划轮次 8 / 单步重试 2 / 重规划 2 / 步骤超时 30min;
- **真机双路径验证**(DeepSeek):正路径 3 轮 LLM 3790+888 tokens 约 25s 全链路 done;失败路径 Worker 撞权限墙 → 自动重试×2(带反馈,Worker 产出完整根因矩阵)→ 反思判断 abort 且理由高质量(「环境权限问题而非方案问题,不应盲目重规划」)——**失败处理比一路成功更有说服力**;
- **编排自身事件化**:plan-created / gate-waiting / verify-passed / verify-failed / replan / run-finalized 六种事件进统一活动流——可观测的 DNA 用在自己身上。

## 3. 关键设计决策(为什么这么做)

| 决策 | 理由 |
|---|---|
| 编排层直连 LLM API 而非套 CLI 当大脑 | 平台拥有自己的 Agent 循环(tool-calling 协议、Schema 校验、预算边界),面试与工程上都成立;对标 clowder-ai 的 CatAgent 原生 Agent 模式 |
| Worker 经原生 CLI 派发 | 保留 hooks、sandbox、plan 等全部原生能力;平台不重造执行层 |
| 人在环默认,全自动显式开启 | 与「高风险能力默认关闭」的既有安全口径一致;门禁挂起不占线程,跨重启可续 |
| 验收失败的自动重试由状态机执行,不耗 LLM | 便宜且确定;重试耗尽才进反思(LLM 决定 replan/abort) |
| 适配器模式,每工具一个 Adapter | 四工具接口异构(JSONL / zstd JSONL / sqlite / 流式 JSON),隔离变化,扩展零侵入 |
| 统一事件模型 HarnessEvent | 活动流、用量、状态全部消费一种事件,新工具接入只需写归一化器 |
| 游标增量索引 + SQLite | 重启秒级续读、事件不重不漏;索引与聚合分离 |
| 双通道事件去重 | 任务经"CLI 流式输出"与"会话文件监听"两条路径同时到达 → 内容指纹入库去重 |
| 只读数据面 | 绝不写/迁移/复制工具数据——数据主权与信任边界 |
| 配置密钥零片段 | 页面不返回密钥任何片段(输入框只显示"已设置"),预设快照仅存本机;编排层 LLM Key 同一规范 |
| 高风险能力默认关闭 | 「完全自主」模式默认关闭、红色警示;服务仅监听 127.0.0.1 |

## 4. 功能清单

- **监控三通道**:文件增量监听 + CLI 流式捕获 + 进程状态探测 → 统一实时活动流(WebSocket 推送,最新在前,分页/类型筛选/关键词)
- **任务生命周期**:原生 CLI 发射、FIFO 排队自动接续、进程组中断、状态归因(stopped vs error)、重启后僵尸任务归位
- **对话室**:会话式连续问答——聊天气泡(Markdown 渲染)、原生 resume 续接上下文、同一会话内切换 Agent(摘要注入)、历史会话一键续聊
- **会话档案**:四工具会话统一索引、分页/全量搜索、时间线轨迹(cursor 接入搜索库全文)
- **配置控制面**:逐字段编辑写回原配置文件 + cc switch 式预设切换;密钥零片段
- **用量账本**:总量/按工具/按模型/按天/按项目,时间范围可选(7/14/30/90 天/自定义)
- **自动化测试**:vitest 覆盖解析器/游标续读/去重/任务状态机/密钥脱敏/配置补丁/API 层/Supervisor 编排全链路(MockProvider 脚本化 LLM:审批/拒绝/重试/重规划/预算/中止/重启恢复),67 项断言 + GitHub Actions CI

## 5. 技术栈

TypeScript · pnpm monorepo(core/agents/server/web 四包)· Node 22+ · Hono + WebSocket · React 19 + Vite + Tailwind 4 · SQLite · chokidar · fzstd · vitest。

## 6. 数据规模(本机 API 实时快照)

> 快照时间:2026-08-21(经本机 REST API 实时生成;**动态数据,投递前请重新快照**,勿长期引用)

- 会话索引:**155 个**(Cursor / Claude Code / Codex / DeepSeek Harness)
- 聚合用量:**665 万 tokens**(输入 491 万 / 输出 173 万)
- 工具调用记录:**7436 次**
- Supervisor 编排 run:**2 次真机验证**(DeepSeek,正路径 done + 失败路径反思中止)

## 7. 迭代中修复的真实 bug(面试素材)

1. **任务 ID 归因断裂**:适配器自造 ID 与管理层 UUID 不一致 → 任务永远 running;
2. **进程探测字符串污染**:`pgrep -f` 匹配到命令行里的 `"agent":"dsh"` 等字符串 → 改为"可执行位置"匹配;
3. **SIGINT 状态竞态**:打断后 exit≠0 被记成 error → 记录 stop 意图,归因 stopped;
4. **文件游标跳过元数据**:截断/改写的会话文件产生"幽灵会话" → 元数据全量解析、事件按游标回放;
5. **已消费文件重启后汇总清零**:offset 到文件尾时被空解析覆盖成 0 消息 → 已消费跳过汇总;
6. **双通道重复入库**:CLI 流与文件监听同一条消息存成两条事件 → 内容指纹去重 + 一次性清理存量;
7. **事件归属散落**:codex `response_item.payload.id` 是条目 ID 而非会话 ID → 文件级统一覆盖会话 ID;
8. **headless 权限拦截假完成**:claude 权限请求无人批准却 exit 0 → 显性标记失败并给出可操作提示;
9. **chokidar v4 glob 失效**:绝对路径 + glob 的 watcher 完全不触发 → 根目录监听 + 扩展名过滤;
10. **页面高度失控**:flex 容器缺高度约束,长对话把整页撑爆 → 补 min-h-0/flex 链;
11. **stop() 规划阶段挂死门禁**(v0.7):planPhase 返回后未检查 stopRequested 即进入 awaiting_approval,run 永久挂起 → 补检查点 + 回归测试。

## 8. 遗留与路线图

- 已知边界(如实标注):Cursor 历史无 token 数据、DSH 不记录模型名;编排 UI 未上线(现为 API 级,curl 可演示);Supervisor 派发默认保守权限,写文件类任务需 run 级自主开关(M2 透传);
- 路线图:v0.7.x 编排 Tab UI + 自主开关透传;v0.8 并行派发、跨模型交叉评审、AnthropicProvider 双协议、更多工具(OpenCode/Aider)、局域网远程访问。

## 9. 我从中获得的

- **Agent 循环的完整工程实践**:LLM tool-calling 协议、结构化规划/验收/反思、失败反馈注入重试、预算与轮次硬边界——不是调 SDK,是自建 harness;
- 异构数据源归一化的完整实践(JSONL/zstd/sqlite/流式 JSON);
- 长驻进程编排(进程组、信号、孤儿处理)与本地 IPC(WS 广播、游标去重);
- 真实用户反馈驱动的迭代闭环(反馈 → 确认 → TODO → 验证 → 回标),每轮都有可验证的交付物。
