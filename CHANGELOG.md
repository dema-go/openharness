# Changelog

> 版本规则与提交规范见 [docs/harness/git.md](docs/harness/git.md)。新版本在上。
> 早期版本(v0.1 / v0.2)在引入 CHANGELOG 前,按 git log 与 README 简录补记。

## [v0.3.1] - 2026-08-15

用户反馈闭环第 2 轮(6 条,用户授权全部采用推荐方案),以修复与体验打磨为主。

### 修复
- **通知**:osascript(系统显示为"脚本编辑器",点击展开打开脚本编辑器)→ terminal-notifier,归属正常、点击直达控制台;未安装时回退 osascript
- **对话室**:任务气泡重复(task-start 事件早于 send() 登记导致双行)
- **codex**:退出码 0 但无助手输出(网络重连耗尽)误报"任务完成" → 显性标记失败
- **claude**:headless 权限拦截被吞导致"假完成"(报告没写出来却显示完成)→ 显性失败并提示勾选「完全自主」重试
- **cursor**:未登录报错不可操作 → 映射为可操作指引(cursor-agent login / CURSOR_API_KEY)

### 新增
- **对话室体验**:错误事件实时入对话气泡;任务收尾必有反馈(无助手输出时补系统气泡说明原因);发送框固定底部,仅停在底部时自动吸底,读历史不被拽走,「↓ 新消息」浮钮一键回底;加载更早保持视口位置
- **活动流**:改为最新在前 + 「↑ 最新」浮钮 + 「加载更早」移至列表底部
- **跨 Agent 派活回流**:切换/续接时向 Agent 注入本机 API 协作约定(带 conversationId);`POST /api/tasks` 支持 `conversationId`,外部派活的任务结果回流对话
- **displayPrompt**:气泡与活动流显示用户原文而非注入摘要后的长 prompt

### 工程
- terminal-notifier 安装至 /opt/homebrew(brew 升级受网络限制,经 GitHub API 直装)

## [v0.3.0] - 2026-08-15

用户反馈闭环第 1 轮(docs/harness/user-question.md),全部交付并端到端实测。

### 新增
- **对话室**:会话式连续对话——会话列表/聊天气泡/打断;原生 resume 续接上下文(claude/codex/cursor),dsh headless 不支持 resume 则以最近对话摘要注入兜底;同一会话内可切换 Agent(注入摘要);会话档案一键「对话室续聊」
- **配置编辑**:四工具配置逐字段编辑(api key/baseUrl/模型等),写回原文件且其余内容保留;密钥不回显
- **配置预设**:cc switch 式——当前配置一键存为预设/应用/删除,快照仅存本机
- **活动流分页筛选**:游标「加载更早」+ 每页 50/100/200 + 10 种事件类型筛选 + 关键词搜索
- **用量范围**:7/14/30/90 天/全部/自定义起止,全部聚合随范围过滤
- **完全自主模式**:发射台与对话室可选跳过所有权限确认(claude `--dangerously-skip-permissions` / codex `--dangerously-bypass-approvals-and-sandbox` / cursor `--yolo --sandbox disabled`;dsh 由 settings.yaml 权限预设控制)
- 事件携带入库 `seq`,WS 实时流与历史分页无缝去重

### 修复
- `patchToml` 根键替换搜索区间为空,导致更新既有键时重复插入

### 文档
- 新增 `docs/harness/` 开发规范(反馈闭环/开发验证/git/code-style)
- `user-question.md` 迁入 docs/harness 并按轮次归档回标

## [v0.2.0] - 2026-08-15(简录)

- 任务历史持久化(SQLite,重启保留,僵尸任务归位)
- 任务排队(忙时 FIFO 入队,收尾自动接续)
- 配置只读页(结构化展示 + 密钥脱敏)
- 按模型用量统计 + 服务端桌面通知
- 深链一键在终端打开恢复
- 漫画风重设计(特工小队)

## [v0.1.0] - 2026-08-15(简录)

- MVP:Claude 适配器 + 控制台首个垂直切片
- Cursor / Codex / DSH 适配器,四工具全部接入
- 统一事件模型 + 游标增量索引 + 实时活动流(WebSocket)
- 任务发射/打断(原生 CLI)、会话索引与详情、智能建议、用量统计
