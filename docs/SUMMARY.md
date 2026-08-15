# OpenHarness 项目总结(面试向)

> 一段话版本:我为自己的多 Agent 工作流做了一个本地控制台 —— 通过适配器模式把 Cursor、Claude Code、Codex、DeepSeek Harness 四个生产级 Agent 工具接入统一页面,实时监控其会话、经原生 CLI 发射/排队/打断任务、索引 200+ 会话、聚合用量,全程只读原工具数据、密钥脱敏、零数据迁移。TypeScript 全栈,11 轮迭代、11 个 commit,每轮端到端实测。

## 1. 背景与问题

我个人同时使用 Cursor、Claude Code、Codex、DeepSeek Harness 四个 AI 编程工具,各自有不可替代的特色(IDE 集成 / hooks+plan / sandbox / profile 体系)。痛点:任务散落各处、无全局监控、切换成本高。市面上「统一入口」方案大多用 API 重造能力,丢失工具原生特色。

## 2. 我的解法

**控制面(Control Plane)与原生运行时(Native Runtime)分离**:OpenHarness 不做任何模型调用,只编排工具本身 —— 读它们的本地会话文件(监控),调用它们的原生 CLI(控制),深链回它们的原生界面(体验)。

## 3. 关键设计决策(为什么这么做)

| 决策 | 理由 |
|---|---|
| 适配器模式,每工具一个 Adapter | 四工具接口异构(JSONL / zstd JSONL / sqlite / 流式 JSON),隔离变化,扩展零侵入 |
| 统一事件模型 HarnessEvent | 上层的活动流、用量、状态全部消费一种事件,新工具接入只需写归一化器 |
| 游标增量索引 + SQLite | 重启秒级续读、事件不重不漏;索引与聚合分离 |
| 只读数据面 | 绝不写/迁移/复制工具数据 —— 数据主权与信任边界 |
| 配置接口密钥脱敏 | 结构化展示 + 首尾各 4 位保留,泄漏检查 0 命中 |
| 经原生 CLI 发射任务 | 保留 hooks、sandbox、plan 等全部原生能力,这是产品立身之本 |
| 本地优先,127.0.0.1 | 个人工具,零攻击面 |

## 4. 功能清单

监控(文件监听+流捕获+进程探测→统一活动流)、任务发射/排队(FIFO 自动接续)/打断、会话索引与搜索(200+ 会话)、深链恢复(复制/一键终端打开)、按特色建议引擎、用量统计(工具/模型/天/项目)、配置只读、双通道桌面通知、任务历史持久化。

## 5. 技术栈

TypeScript · pnpm monorepo(core/agents/server/web 四包)· Node 22+ · Hono + WebSocket · React 19 + Vite + Tailwind 4 · SQLite · chokidar · fzstd。

## 6. 数据规模(本机实测)

索引 205+ 会话(Cursor 52 / Claude 8 / Codex 131 / DSH 20),事件流 4000+ 条,聚合 200 万+ tokens,4170 次工具调用记录。

## 7. 迭代中修复的真实 bug(面试素材)

1. **任务 ID 归因断裂**:适配器自造 ID 与管理层 UUID 不一致 → 任务永远 running;
2. **进程探测误报**:`pgrep -f` 匹配到 PATH 环境变量里的字符串 → 精确进程名 + 命令过滤;
3. **SIGINT 状态竞态**:打断后 exit≠0 被记成 error → 记录 stop 意图,归因 stopped;
4. **文件游标跳过元数据**:截断/改写的会话文件产生 sessionId=unknown 的"幽灵会话" → 元数据全量解析、事件按游标回放;
5. **队列自计数**:先建任务再探测忙闲,新任务把自己数进 running → 先探测后创建;
6. **用量重复计数**:消息级 usage 附到每个内容块事件 → 只附首个事件;
7. **密钥脱敏边界**:`CoAuthoredBy` 被误判为 auth 密钥、MCP 子节混入 → 词边界匹配 + 节过滤;
8. **模型归属缺失**:会话文件无 init 事件 → 从消息体 `message.model` / `turn_context.model` 提取并回填历史。

## 8. 遗留与路线图

Cursor 历史无 token 数据、DSH 不记录模型名(如实标注);v0.3 计划:费用估算、更多工具(OpenCode/Aider)、局域网远程访问。

## 9. 我从中获得的

- 异构数据源归一化的完整实践(JSONL/zstd/sqlite/流式 JSON);
- 长驻进程编排(进程组、信号、孤儿处理)与本地 IPC(WS 广播、游标去重);
- 把"讨论→PRD→架构→垂直切片→逐工具扩展→打磨"的完整节奏走了一遍,且每轮都有可验证的交付物。
