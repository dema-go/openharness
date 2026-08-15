# OpenHarness 迭代 TODO

> 来源:`docs/user-question.md`(用户问题反馈)。
> 已确认的设计决策:
> - **对话上下文**:原生 resume 续接(各工具 CLI 均支持 resume)
> - **切换 Agent**:注入最近对话摘要
> - **对话入口**:新 Tab「对话室」+ 历史会话可续聊
> - **配置**:逐字段编辑 + 预设切换(cc switch 式)
> - **活动流**:游标「加载更早」+ 每页条数可选 + 事件类型筛选 + 关键词搜索
> - **用量**:7/14/30/90 天/全部 + 自定义起止
>
> 实施顺序:3 活动流 → 4 用量 → 2 配置 → 1 对话

## 3. 实时活动流:分页 + 筛选

- [x] 3.1 服务端:`events` 查询支持 `beforeSeq` 游标、`kind` 多选、`q` 关键词;返回带 `seq` 与 `hasMore`
- [x] 3.2 WS 推送的事件携带 `seq`(与历史分页无缝去重)
- [x] 3.3 前端:活动流改为服务端分页——「加载更早」+ 每页 50/100/200 可选
- [x] 3.4 前端:事件类型(10 种)多选筛选 + 关键词搜索
- [x] 3.5 typecheck + build + 接口验证

## 4. 用量账本:时间范围

- [x] 4.1 服务端:`usage()` 参数化(7/14/30/90 天、全部、自定义起止),全部聚合按范围过滤
- [x] 4.2 前端:范围档位选择器 + 自定义起止日期,按天图随范围聚合
- [x] 4.3 typecheck + build + 接口验证

## 2. 配置速览:编辑 + 预设切换

- [x] 2.1 core:新增 `ConfigFieldDef`/`Preset` 类型;`AgentAdapter` 增加 `configSchema()` / `updateConfig()` / `getConfigValues()`
- [x] 2.2 各 adapter 实现可编辑字段 schema 与配置写入(claude settings.json / codex config.toml / dsh settings.yaml+credentials;cursor 为 OAuth 登录,给出说明)
- [x] 2.3 服务端:预设存储(`~/.openharness/presets.json`)+ API(列表/保存快照/应用/删除)
- [x] 2.4 服务端:`PUT /api/config/:agent` 写入配置(密钥字段不回传明文,留空不改)
- [x] 2.5 前端:配置页编辑表单(内联编辑、密钥隐藏、保存回写)+ 预设管理(存为预设/应用/删除)
- [x] 2.6 typecheck + build + 接口验证

## 1. 对话式任务:对话室

- [x] 1.1 core:`LaunchOptions` 增加 `resumeSessionId` / `conversationId`;`HarnessEvent` 增加 `seq`
- [x] 1.2 adapter launch 支持 resume(claude `-p --resume` / codex `exec resume --json` / cursor `--resume`;dsh headless 不支持,退化为摘要注入),`conversationId` 透传进事件 meta
- [x] 1.3 服务端:`conversations` / `conversation_messages` / `conversation_agents` 表 + Store 方法
- [x] 1.4 服务端:`ConversationManager` —— 发消息(按各 Agent 自己的 resume 链)、切换 Agent 时注入最近对话摘要、任务事件回填消息
- [x] 1.5 服务端:对话 REST API(CRUD/发消息/打断)+ WS 推送 conversation 消息
- [x] 1.6 前端:新 Tab「对话室」—— 会话列表、聊天气泡、Agent 切换、运行状态/打断
- [x] 1.7 前端:会话档案增加「对话室续聊」入口
- [x] 1.8 typecheck + build + 端到端验证(单测状态机 + dsh 真实两轮对话 + 浏览器 UI)

## 收尾

- [x] 全量 `pnpm -r typecheck` + `pnpm -r build` 通过
- [x] README 功能全景 / 架构说明更新

## 5. 完全自主模式(追加迭代)

- [x] 5.1 核实四工具 CLI 的全自主开关(claude --dangerously-skip-permissions / codex --dangerously-bypass-approvals-and-sandbox / cursor --yolo --sandbox disabled --approve-mcps / dsh 由 settings.yaml permission.defaultPreset 控制)
- [x] 5.2 `LaunchOptions.bypassPermissions` + 四 adapter launch 参数映射
- [x] 5.3 发射台与对话室各加「完全自主」开关(红框警示、localStorage 记忆、默认关闭)
- [x] 5.4 服务端路由透传(/api/tasks 与对话消息)
- [x] 5.5 typecheck + build + claude 真实验证(进程参数 + 零确认完成)
