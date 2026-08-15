# OpenHarness 架构设计

> 状态:✅ 已确认 v1(2025-08,用户拍板技术栈与范围;配套 [prd.md](./prd.md)、[stack-decision.md](./stack-decision.md))

## 1. 设计原则

1. **Wrap, don't replace**:通过各工具原生 CLI 与本地会话文件接入;
2. **Adapter 隔离**:每个工具一个适配器,新增工具零改动核心;
3. **只读数据面**:会话文件只解析不写;控制只经原生 CLI;
4. **本地优先**:服务绑定 127.0.0.1,凭据不落 OpenHarness 存储。

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript(全栈) | 与各工具 CLI 的 Node 生态一致 |
| 运行时 | Node.js ≥ 22 | 本机已有 v25.8.1 |
| 服务端 | **Hono**(Node adapter) | 轻量、TS 友好,WebSocket 支持 |
| 前端 | **React 19 + Vite + Tailwind CSS** | 快速开发、生态成熟 |
| 进程/流 | `child_process` + **chokidar**(文件监听)+ SSE/WebSocket 推送 | 无需额外常驻服务 |
| 索引存储 | **better-sqlite3**(`~/.openharness/index.db`) | 会话索引与用量聚合,零依赖部署 |
| 包管理 | pnpm workspace(monorepo) | core/server/web 分层清晰 |

## 3. 系统组成

```
┌────────────────────────── 浏览器页面(React) ──────────────────────────┐
│  控制台首页 │ 活动流 │ 会话详情 │ 发任务面板(含智能建议) │ 用量统计    │
└───────────────────────────────┬───────────────────────────────────────┘
                         WebSocket / SSE / REST
┌───────────────────────────────▼───────────────────────────────────────┐
│                        OpenHarness Server(Hono)                        │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ 控制总线     │ │ 事件总线     │ │ 索引服务      │ │ 建议引擎        │  │
│  │ (launch/    │ │ (fan-in +   │ │ (SQLite 索引) │ │ (关键词×特色    │  │
│  │  resume/    │ │  WebSocket) │ │              │ │  评分矩阵)      │  │
│  │  stop/send) │ │             │ │              │ │                │  │
│  └──────┬──────┘ └──────┬──────┘ └──────┬───────┘ └────────────────┘  │
│         └───────────────┼───────────────┘                             │
│                 Adapter 层(每工具一个)                                 │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│   │ cursor   │ │ claude   │ │ codex    │ │ dsh      │                 │
│   │ adapter  │ │ adapter  │ │ adapter  │ │ adapter  │                 │
│   └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘                 │
└────────┼────────────┼────────────┼────────────┼───────────────────────┘
         │            │            │            │
   cursor agent    claude CLI    codex CLI    dsh CLI        (控制:spawn 原生进程)
   IDE 进程探测    ~/.claude/    ~/.codex/    ~/.dsh/         (监控:文件监听/进程表)
                  projects      sessions     sessions
```

## 4. 统一事件模型

所有工具事件归一化为 `HarnessEvent`:

```ts
type HarnessEvent = {
  ts: number;                 // 事件时间
  agent: 'cursor' | 'claude' | 'codex' | 'dsh';
  projectDir: string | null;  // 目标项目
  sessionId: string;          // 工具原生会话 ID
  kind: 'session-start' | 'session-end' | 'user-message' | 'assistant-message'
      | 'tool-call' | 'file-edit' | 'error' | 'mode-change';
  summary: string;            // 人可读摘要(截断到 ~200 字符)
  usage?: { input: number; output: number };  // token,可选
  meta: Record<string, unknown>;              // 原生字段透传(resume 深链等)
};
```

各适配器负责把原生记录归一化(已实测的源格式):

| 工具 | 源 | 格式 |
|---|---|---|
| Claude | `~/.claude/projects/<enc-path>/<sessionId>.jsonl` | 带 type 的 JSONL(`user/assistant/system/mode/ai-title/file-history-*`…),assistant 记录含 `message.usage` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 事件 JSONL(session_meta / response_item / event_msg / turn_context…;实测 rollout 不含 usage,用量以流式事件为准,缺省记 0) |
| DSH | `~/.dsh/sessions/<enc-path>/session-<id>/session.jsonl.zstd` | zstd 压缩 JSONL |
| Cursor | 运行态经 `cursor agent --output-format stream-json`;历史会话后续解析 IDE workspaceStorage(SQLite),v0.1 降级为"进程状态 + 我们发射的会话" |

## 5. 控制面:原生 CLI 映射(全部已实测可用)

| 操作 | cursor | claude | codex | dsh |
|---|---|---|---|---|
| 新任务 | `cursor agent -p <prompt> --output-format stream-json` | `claude -p <prompt> --output-format stream-json --verbose` | `codex exec <prompt> --json` | `dsh --profile headless <task>` |
| 恢复会话 | `--resume <chatId>` | `--resume <sessionId>` | `resume <id>` | `--resume <session>` |
| 指定项目 | `--workspace <dir>` | `cwd=<dir>` | `cwd=<dir>` | `cwd=<dir>` |
| 打断 | SIGINT → 进程树终止 | 同左 | 同左 | 同左 |
| 补充消息 | 部分支持(交互模式) | stdin 续聊(交互模式) | 部分支持 | 单任务模式,不支持 |

> 运行管理:控制总线持有 spawn 的进程句柄(含 pgid),维护运行任务表;打断 = 对进程组发 SIGINT,超时后 SIGKILL。

## 6. 监控面:三种通道

1. **文件监听(chokidar)**:tail 各工具会话目录,新事件秒级进入活动流——历史会话也能实时看到(即使任务不是从 OpenHarness 发起);
2. **进程流捕获**:OpenHarness 自己 spawn 的任务,直接消费 stdout/stderr 的 stream-json——最实时;
3. **进程探测(轮询 30s)**:`ps` 检测各工具进程存在性,标注"工具空闲/运行中",供状态卡与去重。

索引服务将三者归一事件写入 SQLite(增量:`lastPos` 游标按文件记录),启动时全量重放缺失部分。

## 7. 深链映射

| 工具 | 深链 |
|---|---|
| Cursor | `cursor://file/<absPath>` 或 `cursor <dir>`;会话恢复靠 `cursor agent --resume <chatId>`(终端) |
| Claude Code | 页面生成命令:`claude --resume <sessionId>`,一键复制/经 `open -a Terminal` 打开 |
| Codex | `codex resume <id>`(终端) |
| DSH | `http://127.0.0.1:3080` 的 dsh web 页面(本工具) |

## 8. 智能建议引擎(v0.1 规则版)

评分矩阵:任务文本关键词 → 各工具特征分,输出 Top 建议 + 理由。

| 特征信号 | cursor | claude | codex | dsh |
|---|---|---|---|---|
| 编辑器内交互/补全/重构 | ●●● | ●● | ● | ● |
| 多步编排/hook/长期项目 | ● | ●●● | ●● | ●● |
| 沙箱隔离执行/实验性代码 | ● | ●● | ●●● | ● |
| 可组合 profile/插件/MCP | ● | ●● | ● | ●●● |
| 需要 GUI/浏览器操作 | ●● | ● | ●●● | ● |

匹配策略:关键词命中 + 近期会话成功率加权;v0.1 输出推荐列表与理由,不做自动执行;v0.2 可选接 LLM 判断。

## 9. 安全与边界

- 服务仅监听 127.0.0.1(局域网远程访问为 v0.3,需显式开启 + 令牌);
- OpenHarness 不保存任何工具的 API 凭据;凭据仍在各工具自己的配置中;
- 对工具数据目录严格只读;`~/.openharness/` 仅存索引与自身配置;
- spawn 任务继承用户当前 shell 环境(各工具凭据自然生效)。

## 10. 仓库结构(计划)

```
OpenHarness/
├── docs/                    # vision / prd / architecture / decisions
├── packages/
│   ├── core/                # 类型、事件模型、适配器接口、深链工具
│   ├── agents/              # cursor / claude / codex / dsh 适配器 + 事件归一化
│   ├── server/              # Hono 服务:REST + WebSocket、控制总线、索引、建议引擎
│   └── web/                 # React + Vite 前端
├── pnpm-workspace.yaml
└── package.json
```
