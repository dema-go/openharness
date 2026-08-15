# 技术栈决策:主流是什么?OpenHarness 该选什么?

> 状态:待用户拍板 · 2026-08

## 1. 先回答你的问题:后端都是 Python 吗?

**不是。** 2025 年的真实格局(依据 [Stack Overflow 2025 调查解读](https://dev.to/dev_tips/my-thoughts-on-the-2025-stack-overflow-survey-the-hype-the-reality-the-gap-26e3) 与 [2026 Web 技术栈分析](https://insoftex.com/insights/top-technology-stacks-for-web-app-development/)):

| 领域 | 主流后端 | Python 的位置 |
|---|---|---|
| 通用 Web 产品 | **TypeScript/Node**、Go、Java | FastAPI/Django 是主流之一,但并非"默认" |
| 数据科学 / 模型训练 | **Python**(绝对主导) | 主导 |
| **AI Agent 编排** | **TypeScript 与 Python 双雄** | LangChain/LangGraph/CrewAI 属 Python 阵营;Vercel AI SDK、Claude Agent SDK 属 TS 阵营 |

结论:Python 是"AI/数据"领域的第一语言,但"AI 产品工程"是 TS 和 Python 对半分——而 **Agent CLI 工具生态本身就是 Node/TS 主导的**。

## 2. 对本项目最关键的三个事实

1. **你要编排的四个工具全是 Node/TS 写的 CLI**:Claude Code、Codex、Cursor Agent、DSH 都运行在 Node 上。适配层用 TypeScript 意味着:同运行时、同调试习惯、甚至可以直接复用它们的生态库。
2. **OpenHarness 的定位是"不重新实现 Agent"**,所以根本不需要 LangChain/LangGraph 这类框架——核心是**进程编排 + 文件事件流 + Web 实时推送**,这正是 Node 最顺手的领域(它的 `child_process`、chokidar、WebSocket 生态是所有语言里最成熟的)。
3. **前端 React 没有争议**。选 TS 则全栈同语言,类型可以从适配器一路共享到 UI,项目里只维护一套心智模型。

## 3. 方案对比

| 维度 | A: TS 全栈(Hono + React + Vite) | B: Python 后端 + React 前端 | C: TS 主体 + 可选 Python 服务 |
|---|---|---|---|
| 与 4 个工具的同构性 | ★★★(同运行时) | ★(跨进程 JSON 通信) | ★★★ |
| 进程编排/事件流生态 | ★★★(child_process/chokidar/SSE) | ★★(asyncio/watchdog) | ★★★ |
| 简历主流度(AI 产品工程岗) | ★★★(TS agent 生态正热) | ★★★(Python 也热) | ★★★ |
| 单一语言全栈类型共享 | ★★★ | ★(前后端类型契约要手写) | ★★★ |
| 未来加数据分析类模块 | ★★(TS 也能做,生态略弱) | ★★★ | ★★★(monorepo 加一个 FastAPI 服务即可) |
| 开发速度/维护成本(单人) | ★★★ | ★★(两套语言上下文切换) | ★★★ |

## 4. 我的建议

**选 C 的起点 = A**:主体 TS 全栈;monorepo 结构天然支持将来挂 Python 服务,但不为"看起来有 Python"而拆语言。

简历视角的关键不是语言,而是**故事**:这个项目的亮点是"给 Cursor / Claude Code / Codex / DSH 这些生产级 Agent 工具做了统一控制面(适配器模式 + 事件驱动 + 实时监控)"——面试官问的是架构,不是"你后端用了 Python 没"。TS 全栈是这个故事最自然的载体。
