# OpenHarness

> **个人 Agent 控制台** —— 一个页面,管理、操作、监控你的所有 AI 编程 Agent(Cursor · Claude Code · Codex · DeepSeek Harness),保留每个工具的原生特色。
> 视觉:《阿衰》式彩色漫画风,由 Open Design × DeepSeek Harness 设计生成([设计文档](docs/DESIGN.md))。
> 当前版本:**v0.3.2**(变更记录见 [CHANGELOG](CHANGELOG.md))。

![控制台首页](docs/screenshots/cartoon-home.png)

## 它解决什么问题

同时使用多个 AI Agent 工具的人都有一个痛点:**任务散落在各个工具的会话里,谁在干什么、干到哪了、花了多少,没有全局视野**。OpenHarness 是这一层缺失的「控制面」:

- **一个页面看到全部**:四个 Agent 的实时活动流、状态卡、会话索引、用量统计;
- **一个页面发起任务**:选工具、写任务,页面按各工具特色给出建议,你来拍板;
- **随时回到原生体验**:任务进行中一键深链回 Cursor / 终端里的 Claude Code / Codex / DSH。

核心原则一句话:**OpenHarness 编排和观察工具本身,而不是用 API 重新实现它们。**

## 架构

```
┌─────────────────────────── 浏览器页面(React 19) ───────────────────────────┐
│  控制台首页 · 活动流 · 对话室 · 会话索引/详情 · 发任务(建议引擎)· 用量 · 配置 │
└───────────────────────────────┬─────────────────────────────────────────────┘
                         REST / WebSocket(实时推送)
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                        OpenHarness Server(Hono + SQLite)                     │
│  事件总线(归一化+入库+广播)· 任务管理(发射/排队/打断/持久化)· 对话管理 ·      │
│  建议引擎 · 配置编辑与预设                                                     │
└───────┬──────────────────┬──────────────────┬──────────────────┬────────────┘
        │ CursorAdapter    │ ClaudeAdapter    │ CodexAdapter     │ DshAdapter
        │ conversation-    │ ~/.claude/       │ ~/.codex/        │ ~/.dsh/
        │ search.db        │ projects/*.jsonl │ sessions/**/*.jsonl│ sessions/**/*.zstd
        ▼                  ▼                  ▼                  ▼
  cursor-agent      claude -p          codex exec        dsh --profile headless
  (原生 CLI)        (stream-json)      (--json)          (原生 CLI)
```

- **适配器模式**:每个工具一个 Adapter,统一接口 `listSessions / indexEvents / watch / launch / resumeCommand / describeConfig / configSchema / updateConfig`,新增工具零改动核心;
- **统一事件模型**:所有工具的原生记录归一化为 `HarnessEvent`,活动流、用量、状态都建立在这一层;
- **只读 + 脱敏**:会话文件只解析不写入;配置页绝不展示密钥原文(编辑只回传"新值",留空不改);
- **本地优先**:数据不离开你的机器,凭据仍归各工具自己管理;配置预设(密钥快照)仅存 `~/.openharness/presets.json`。

## 功能全景

| 能力 | 说明 | 状态 |
|---|---|---|
| 实时监控 | 四工具会话文件监听 + 任务流式捕获 + 进程探测,统一活动流(WebSocket 推送) | ✅ |
| 活动流分页筛选 | 最新在前 + 游标「加载更早」+ 每页 50/100/200 + 10 种事件类型筛选 + 关键词搜索,「↑ 最新」浮钮一键回顶 | ✅ |
| 任务发射 | 经各工具**原生 CLI** 启动(`claude -p` / `codex exec` / `cursor-agent` / `dsh --profile headless`),保留 hooks/sandbox/plan 等全部原生能力;可选「完全自主」跳过所有权限确认(claude `--dangerously-skip-permissions` / codex `--dangerously-bypass-approvals-and-sandbox` / cursor `--yolo --sandbox disabled`) | ✅ |
| 任务排队 | 勾选「排队执行」,Agent 忙时 FIFO 入队,收尾自动接续 | ✅ |
| 打断/移除 | 进程组 SIGINT,状态正确归因(stopped vs error) | ✅ |
| 会话索引 | 4 工具 200+ 会话统一索引、搜索、详情(时间线/统计;cursor 接入搜索库全文轨迹) | ✅ |
| 深链恢复 | `claude --resume` / `codex resume` / `cursor agent --resume` / `dsh --profile tui --resume`,一键复制或**直接在终端打开** | ✅ |
| 对话室 | 会话式连续问答:聊天气泡 + 原生 resume 续接上下文(claude/codex/cursor)+ dsh 摘要注入兜底;**同一对话内可切换 Agent**(注入最近对话摘要),历史会话一键续聊 | ✅ |
| 智能建议 | 关键词 × 工具特色矩阵评分,推荐 + 理由,人做决定 | ✅ |
| 用量统计 | 总量 / 按工具 / 按模型 / 按天 / 按项目,范围可选(7/14/30/90 天/全部/自定义起止),含数据完整性标注 | ✅ |
| 配置编辑 | 四工具配置直接编辑(api key / baseUrl / 模型等),写回原配置文件,密钥不回显 | ✅ |
| 配置预设 | cc switch 式:整套配置一键存为预设、一键切换/删除,密钥仅存本机 | ✅ |
| 通知 | 浏览器通知 + 服务端 macOS 通知(terminal-notifier,点击直达控制台,浏览器关闭也提醒) | ✅ |
| 任务历史 | SQLite 持久化,重启保留,僵尸任务自动归位 | ✅ |

## 技术栈

TypeScript 全栈 · pnpm monorepo · Node.js ≥ 22 · Hono + WebSocket · React 19 + Vite + Tailwind CSS 4 · SQLite(better-sqlite3 / node:sqlite)· chokidar · fzstd(纯 JS zstd 解压)

选型论证见 [docs/stack-decision.md](docs/stack-decision.md)。

## 快速开始

```bash
pnpm install
pnpm dev:server        # http://127.0.0.1:3900(REST + WebSocket + 静态托管)
pnpm dev:web           # http://127.0.0.1:3901(前端热更新)
```

生产模式:`pnpm --filter @openharness/web build && pnpm start`

> Cursor 控制需先执行一次 `cursor-agent login`(CLI 与 IDE 登录态不共享)。

## 工程亮点

- **11 个 commit、11 轮迭代全部端到端实测**,修出的真实 bug 本身就是最佳实践样本:任务 ID 归因断裂、进程探测误报(PATH 字符串污染)、SIGINT 状态竞态、文件游标跳过元数据(截断文件产生"幽灵会话")、队列自计数、密钥过度/不足脱敏、用量重复计数;
- **统一事件模型 + 游标增量索引**:重启秒级续读,事件不重不漏;
- **安全边界**:服务仅监听 127.0.0.1;密钥永不回显(编辑只提交新值、预设快照本地落盘),配置接口 0 密钥泄漏;
- **设计**:「特工小队」漫画风(《阿衰》式)—— 四工具角色化(光标侠/小克/码星人/鲸酱),奶油纸底 + 墨线描边 + 硬实影 + 高饱和撞色,站酷快乐体 × Luckiest Guy × IBM Plex Mono,对话气泡状态、火花条签名元素,支持 reduced-motion。

![发射台](docs/screenshots/cartoon-launcher.png)

## 文档

- [PRD](docs/prd.md) · [架构设计](docs/architecture.md) · [技术栈决策](docs/stack-decision.md)
- [开发规范](docs/harness/README.md)(反馈闭环 / 开发验证 / 提交规范 / 代码规范)· [用户反馈](docs/harness/user-question.md) · [变更记录](CHANGELOG.md)
- [项目总结(面试向)](docs/SUMMARY.md) · [讨论与迭代记录](docs/vision-discussion.md)

## Roadmap

- ✅ v0.3:对话室、配置编辑与预设、活动流分页筛选、用量范围、完全自主模式(已发布,见 CHANGELOG)
- v0.4:费用估算(可配置价目表)、更多 Agent 工具(OpenCode / Aider…)、局域网远程访问
- v0.5:任务模板与自动化工作流、多机会话同步

## License

[MIT](LICENSE)
