# OpenHarness — 愿景与需求讨论稿

> 状态:讨论中(第 1 轮) · 2025-08 启动
> 本文件是需求的活文档,每轮讨论后更新,直到愿景收敛为可开工的 PRD。

## 1. 愿景重述

一个**个人 Agent 控制台**:

- 你日常同时使用多个 Agent 工具:Cursor、Claude Code、Codex、DeepSeek Harness(可能更多)。
- 希望有一个**统一入口页面**,在一个页面上:
  - **操作**:启动、恢复、打断各 Agent 的任务;
  - **监控**:实时看到各 Agent 在干什么、进度如何;
  - **管理**:任务/会话的归档、检索、分发。
- 关键约束:**保留各 Agent 自身的特色**,而不是只换一个界面去调各家大模型 API。

一句话:**OpenHarness 是"控制面",各 Agent 是"原生运行时"**——它编排和观察工具本身,而不是替代工具。

## 2. 现状盘点(2025-08 本机实测)

| 工具 | 本机形态 | 会话/状态存储 | 可脚本化接口 | 特色(需要保留的价值) |
|---|---|---|---|---|
| **Claude Code** | CLI v2.1.233 | `~/.claude.json` + `~/.claude/projects/<路径>/*.jsonl`(7+ 个项目有历史会话) | `claude -p`(headless)、`--resume <session-id>`、`--continue`、hooks、MCP、`/output-style` | hooks、plan mode、subagents、terminal 直控、CLAUDE.md 上下文体系 |
| **Cursor** | IDE 3.16.17(桌面 App 运行中) | IDE 内工作区状态(`~/Library/Application Support/Cursor`) | ✅ **`cursor agent` 子命令可用**:`--print`、`--output-format json/stream-json`、`--resume [chatId]`、`--continue`、`--mode plan/ask`、`--sandbox`、`--model`、MCP;首次调用自动安装 cursor-agent | Composer、Tab 补全、IDE 深度集成、多模型、Agent 窗口 |
| **Codex** | ChatGPT 桌面 App + **CLI 0.147.0 已安装**(2025-08-15) | `~/.codex/`(global-state、sessions、archived_sessions;config.toml 已有,sandbox_mode=workspace-write) | ✅ `codex exec`(非交互)、`codex resume/--last`、`fork`、`archive`、**`exec-server`(实验性独立服务)** | sandbox 执行、computer use、rollout、AGENTS.md |
| **DeepSeek Harness (DSH)** | CLI `dsh`;`dsh web` 正在 127.0.0.1:3080 运行(本会话即跑在其中) | `~/.dsh` profile 体系 | profile/plugin 补丁层、`--profile headless` 单任务模式、MCP | profile 可组合性、插件机制、多 provider、web/tui/headless 三形态 |

**结论**:四个工具都有本地会话数据可读,CLI 化程度不一:

- Claude Code / DSH:完全可脚本化,可直接由 OpenHarness 驱动;
- Cursor:主要靠 IDE 进程 + `cursor-agent`,需要确认 CLI 安装或走深链;
- Codex:建议安装官方 CLI 作为接入口,桌面 App 只能做只读监控。

## 3. 核心架构原则(讨论起点)

1. **Wrap, don't replace**:通过各工具自己的 CLI/进程/会话文件接入,不重新实现它们。
2. **读得进,控得住,留得出**:
   - 读:解析各工具本地会话文件,聚合成统一活动流;
   - 控:通过各工具 CLI 启动/恢复/打断任务;
   - 留:任务进行中随时"深链"跳回原工具继续(保留原生体验)。
3. **适配器模式**:每个工具一个 Adapter(接入层),新增工具只需加 Adapter,不动核心。
4. **本地优先**:所有数据在你自己机器上,不经过第三方云。

## 4. 待澄清的关键决策点

### A. 载体形态
纯本地 Web 服务(浏览器打开)?桌面壳(Tauri/Electron)?作为 DSH 的 profile/插件?还是先 CLI/TUI?

### B. 监控 vs 控制
页面只读监控,还是也能启动/恢复/打断/发消息?控制到什么深度?

### C. 对话发生位置
页面内直接内嵌各 agent 的对话流,还是只做"启动 + 监控 + 深链回原工具",或两者混合?

### D. 特色保留优先级
Cursor 的 IDE 集成、Claude Code 的 hooks/plan、Codex 的 sandbox、DSH 的 profile 体系——哪些是"必须保留",哪些可妥协?(多选)

### E. Codex 接入方式
安装 Codex CLI(完全可脚本化),还是仅监控桌面 App,或两者都接?

### F. 任务分发策略
纯手动指定工具 / 页面按特色给出建议、人做决定 / 按任务描述自动路由?

### G. 范围边界
是否需要:统一凭据管理、用量统计(token/费用)、任务排队、远程(多机)访问、团队协作?

## 5. MVP 设想(待定稿)

> 以下是最小可行形态的草稿,待上述问题收敛后改写为 PRD。

1. **控制台首页**:每个 Agent 一张卡片——运行状态、最近会话、任务摘要、一键"继续/打开"。
2. **统一活动流**:聚合各工具的会话事件(启动、消息、工具调用、完成/失败),时间线展示。
3. **发任务**:选择 Agent + 输入任务 → 调用其原生 CLI 启动(或深链到原工具)。
4. **会话详情**:点击任意会话,查看摘要/关键消息,并深链回原工具继续。
5. **Adapter SDK**:`agents/*` 每个工具一个适配器,提供统一接口 `listSessions / watch / launch / resume / stop / openExternal`。

## 5. MVP 设想(待定稿)

> 以下是最小可行形态的草稿,待上述问题收敛后改写为 PRD。

1. **控制台首页**:每个 Agent 一张卡片——运行状态、最近会话、任务摘要、一键"继续/打开"。
2. **统一活动流**:聚合各工具的会话事件(启动、消息、工具调用、完成/失败),时间线展示。
3. **发任务**:选择 Agent + 输入任务 → 调用其原生 CLI 启动(或深链到原工具)。
4. **会话详情**:点击任意会话,查看摘要/关键消息,并深链回原工具继续。
5. **Adapter SDK**:`agents/*` 每个工具一个适配器,提供统一接口 `listSessions / watch / launch / resume / stop / openExternal`。

## 6. 决策记录

### 第 1 轮问答(2025-08-15)— 已确认 ✅

| # | 决策点 | 结论 |
|---|---|---|
| A | 载体形态 | **本地 Web 服务 + 浏览器页面**(与你现有 dsh web 习惯一致) |
| B | 控制深度 | **监控 + 完整控制**:启动/恢复/打断/发消息,页面即总控台 |
| C | 对话位置 | **混合**:页面轻量控制(发消息/打断)+ 深链回原工具看完整原生界面 |
| D | 特色保留 | **四个全要**:Cursor IDE 集成、Claude Code hooks/plan/subagents、Codex sandbox/computer use/rollout、DSH profile/plugin/MCP |
| E | Codex 接入 | **安装 Codex CLI**(`@openai/codex`)作为脚本化入口;桌面 App 做只读监控补充 |
| F | 任务分发 | **手动选择 + 页面智能建议**:按特色给推荐和理由,人拍板 |

### 由此推出的架构结论

- OpenHarness = 本地 Web 控制面;每个工具一个 **Adapter**,通过其原生 CLI/会话文件接入;
- 页面必须同时具备:任务发射(原生 CLI 启动)、实时监控(会话文件/进程事件)、深链跳转(`cursor://`、`claude --resume` 打开终端、`codex --resume`、`dsh web` 已有页面);
- ✅ **Cursor 接入已技术验证**:`cursor agent` 子命令完全可脚本化(json/stream-json 输出、resume、plan 模式),不需要单独装 cursor-agent;
- ✅ **Codex CLI 0.147.0 已安装**,`exec/resume/fork/exec-server` 齐全,接入无障碍;
- 未决:G(范围边界:凭据管理/用量统计/排队/远程/协作)——纳入第 2 轮讨论。

## 7. 讨论记录

- **第 1 轮**:完成本机工具盘点与集成面调研;提出 A–G 七个决策点;A–F 六项已由用户确认(见上表);安装 Codex CLI 0.147.0;验证 Cursor `cursor agent` 脚本化接口可用。
- **第 2 轮**:实测四个工具会话数据格式(Claude 类型化 JSONL / Codex rollout JSONL / DSH zstd JSONL / Cursor 流式接口);输出 [PRD](prd.md) 与 [架构设计](architecture.md) 草案;G 项已确认(按建议:仅含用量统计);技术栈经 [stack-decision.md](stack-decision.md) 分析后拍板:**TS 全栈为主、Python 可选挂载**。讨论阶段收敛完毕,第 3 轮起进入 v0.1 搭建。
- **第 3 轮**:搭建 v0.1 骨架并跑通第一个垂直切片 —— pnpm monorepo(core/agents/server/web 四包)+ Claude 适配器(JSONL 解析、游标增量、chokidar 监听、CLI 发射/打断)+ Hono 服务(REST/WS/SQLite 索引/建议引擎)+ React 控制台(任务控制舱视觉、LED 信号表)。端到端实测:索引 3 个真实会话 305 条事件;经 API 发射 3 个真实 Claude 任务,WS 实时流送达 PASS;修复 taskId 归因 bug;浏览器截图验收通过。服务运行于 `http://127.0.0.1:3900`。
- **第 4 轮**:接入 **Codex 适配器** —— 摸清 rollout JSONL 格式(7 种顶层事件、response_item 10+ 子类型、会话归属 session_meta.session_id、标题 turn_context.summary),实现解析/递归监听/`codex exec --json` 发射/打断;索引 84 个 rollout → 51 个会话(后随桌面 App 新写入增至 129)。实测修复三个 bug:probe 误报(进程名精确匹配 + 桌面常驻排除)、打断状态竞态(stopped vs error)、错误事件未入流(重连超时现可见)。发现外部环境问题:codex exec 存在 API 超时重连(非 harness 问题)。新增**会话索引页 + 会话详情抽屉**(统计、时间线、`codex resume` 恢复命令一键复制),事件 API 支持按会话过滤。浏览器截图验收通过。
- **第 5 轮**:**Cursor 与 DSH 适配器接入,四工具全部点亮** —— Cursor 经 `conversation-search.db`(node:sqlite 只读)索引 52 个真实会话,`cursor-agent --print stream-json` 发射;DSH 经 fzstd 纯 JS 解压 zstd 会话文件(行号游标,chunk 化事件归一化),`dsh --profile headless` 发射。实测修复:给 headless profile 补装 `@liustack/modlens` bundle(修复 NO_ADAPTER);四个适配器统一 stderr 错误透传(失败原因直接进活动流)。终验:DSH 任务 done(exit 0);Cursor 任务报错并精确显示原因 —— `cursor-agent` CLI 需用户执行一次 `agent login`(IDE 登录态不共享)。
