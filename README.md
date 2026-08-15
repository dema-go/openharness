# OpenHarness

个人 Agent 控制台:统一入口页面,管理、操作、监控你的多个 Agent 工具(Cursor、Claude Code、Codex、DeepSeek Harness),保留各工具自身特色。

## 现状(v0.1,四个 Agent 全部接入)

- ✅ Claude Code 适配器:会话索引(JSONL 解析 + SQLite)、实时监听、CLI 任务发射/打断、深链恢复命令
- ✅ Codex 适配器:rollout JSONL 索引/监听、`codex exec --json` 发射/打断、`codex resume` 深链
- ✅ Cursor 适配器:conversation-search.db 会话索引、`cursor-agent` 发射(需先 `cursor-agent login`)、`cursor agent --resume` 深链
- ✅ DSH 适配器:zstd 会话解析/监听、`dsh --profile headless` 发射、`dsh --profile tui --resume` 深链
- ✅ 控制台 UI:Agent 状态卡(LED 信号表)、统一活动流(实时推送)、发任务面板(按特色匹配的建议引擎)、会话索引页 + 会话详情抽屉(统计/时间线/恢复命令复制)、用量统计页(总量/按工具/近 14 天/按项目)

> **v0.1 MVP(F1–F6)已全部交付,进入验收。** 服务:`http://127.0.0.1:3900`

## 快速开始

```bash
pnpm install
pnpm dev:server          # http://127.0.0.1:3900 (REST + WebSocket)
pnpm dev:web             # http://127.0.0.1:3901 (前端热更新,代理 /api /ws)
```

生产模式(单端口):`pnpm --filter @openharness/web build && pnpm start`

## 文档

- [愿景与需求讨论稿](docs/vision-discussion.md) —— 讨论记录与决策
- [PRD 产品需求文档](docs/prd.md) —— 功能需求与 MVP 范围
- [架构设计](docs/architecture.md) —— 技术栈、适配器、事件模型
- [技术栈决策](docs/stack-decision.md) —— "主流是什么?该选什么?"

## 一句话架构

**OpenHarness 是"控制面",各 Agent 是"原生运行时"**:通过各工具原生 CLI 与本地会话文件接入,页面负责发射任务、实时监控、会话索引与深链跳转——不重新实现、不迁移数据、不聚合模型 API。
