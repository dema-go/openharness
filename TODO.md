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

## 第 2 轮:2026-08-15 用户反馈(用户授权:全部采用推荐方案,无需确认)

> 来源:docs/harness/user-question.md 第 2 轮(5 条)
> 已确认决策(用户授权按推荐):通知改用 terminal-notifier;权限拦截显性化+自主模式验证;cursor 登录友好报错;对话室吸底+新消息提示;错误事件入对话气泡+任务收尾必反馈。

- [x] 2.1 调查日志:cursor 失败=未登录;codex 网络重连错误未入气泡;task-start 缺 conversationId;通知=osascript 脚本编辑器
- [x] 2.2 通知修复:terminal-notifier(点击打开控制台),未安装回退 osascript(brew 被墙,改经 GitHub API 下载安装,实测通知发送成功)
- [x] 2.3 对话室滚动:吸底跟随 + 「↓ 新消息」浮钮 + 加载更早不跳视口
- [x] 2.4 claude/codex/cursor 错误映射:权限拦截/未登录 → 可操作的 error 提示
- [x] 2.5 任务收尾必反馈:error 事件入对话气泡;无助手输出时补系统气泡;task-start 带 conversationId;派活提示注入
- [x] 2.6 完全自主验证:dsh/claude 实跑;cursor 验证报错路径(未登录)
- [x] 2.7 全量验证:typecheck/build/重启/浏览器截图/四 Agent 真实任务(dsh·claude 成功,codex 显性报错,cursor 可操作报错)
- [x] 2.8 回标 user-question + CHANGELOG + README + commit + push

## 第 3 轮:2026-08-15 用户反馈(#4 复测未修复 / #7 会话档案无数据 / #8 Codex 无法对话)

- [x] 3.1 对话室滚动:复现真根因(tab 容器缺 flex,整页被撑爆 3041px),一行修复 + 长对话浏览器实测(零页面滚动/发送框固定/自动跟随)
- [x] 3.2 会话档案:codex 事件 sessionId 散落修复 + 已消费文件跳过 + 一次性重建索引;cursor 接入 FTS body 全文轨迹
- [x] 3.3 Codex CLI:系统代理自动注入(scutil --proxy)+ item.completed 新流格式解析;实测 12 秒完成回复正常
- [x] 3.4 顺带修复:chokidar v4 绝对路径 glob 不触发 → 三个适配器 watcher 改根目录监听(合成文件实测实时索引)
- [x] 3.5 全量验证:typecheck/build/重启/浏览器逐项核验/真实任务
- [x] 3.6 回标 + CHANGELOG + README + commit + push

## 第 4 轮:2026-08-15 用户反馈(#9 状态卡误报 RUN / #10 答复截断)

- [x] 4.1 复现 #9:probe 的 pgrep 匹配"任意命令行含 dsh"造成字符串污染(连测试脚本里的 "agent":"dsh" 都误判)
- [x] 4.2 修复:dsh/claude probe 改为"可执行位置"匹配;dsh 任务收尾 10s 后清理残留进程组;任务收尾状态延迟刷新(+5s/+15s)
- [x] 4.3 复现 #10:助手回复被 truncate(200~400 字),气泡无全文
- [x] 4.4 修复:四适配器事件 meta 携带 fullText;对话回填优先用全文
- [x] 4.5 验证:dsh 任务完成→状态卡持续 idle;1091 字回复气泡完整
- [x] 4.6 回标 + CHANGELOG + README + commit + push

## 第 5 轮:2026-08-15 用户反馈(对话室 2 条 + 第 3 轮 7 条,共 9 条)

- [x] 5.1 清理测试残留(rollout-test 文件 + DB 行)
- [x] 5.2 事件指纹去重(agent+会话+类型+全文)+ 存量清理 1415 条
- [x] 5.3 注入上下文分离:isInjectedSystemText 过滤 + extractUserPrompt 提取真实输入 + 任务记录用 displayPrompt
- [x] 5.4 会话档案服务端分页 + 总数 + 搜索下推
- [x] 5.5 空会话默认隐藏 + 含空会话开关;修复 claude/dsh 汇总清零 bug + 重建索引
- [x] 5.6 密钥零片段(schema hasValue/presets 占位符/只读摘要占位符)
- [x] 5.7 用量按天补零 + 45 天以上标签抽稀
- [x] 5.8 目录选择器(浏览…/＋新建)+ 会话记住特工与目录
- [x] 5.9 移动端响应式(标签横滑/对话抽屉/窄列收窄)
- [x] 5.10 全量验证:typecheck/build/接口/桌面+390px 窄屏截图
- [x] 5.11 回标 9 条 + CHANGELOG + README + commit + push

## 第 5.1 轮:2026-08-15 用户反馈(#13 对话室 Markdown 渲染,闭环中追加、收尾前补读发现)

- [x] 13.1 新增 marked + dompurify 依赖(commit 说明理由:XSS 防护)
- [x] 13.2 对话气泡 Markdown 渲染(用户/助手消息),漫画风 .md-body 样式
- [x] 13.3 「Markdown」开关(默认开、localStorage 记忆)
- [x] 13.4 实测:渲染态(列表/行内代码/代码块/表格)+ 原文态切换正常
- [x] 13.5 feedback-loop.md 补充"回标前重读反馈文件"规则,防再漏
- [x] 13.6 回标 + CHANGELOG + README + commit + push

## 第 6 轮:2026-08-16 用户反馈(第 4 轮:求职作品集与工程可信度,6 条)

- [x] 6.1 #3 测试体系:vitest 39 项断言(7 文件:core 工具/解析器/游标/去重/状态机/密钥/补丁/Markdown 消毒)
- [x] 6.2 #3 CI:.github/workflows/ci.yml(typecheck+test+build+check:dates)
- [x] 6.3 #1/#2 口径统一:README 定位段重写、SUMMARY 数据快照化、新增 docs/resume-bullets.md
- [x] 6.4 #4 演示 GIF:90 秒 3MB(docs/screenshots/demo.gif)+ README 首屏重构
- [x] 6.5 #5 深色作品集截图 5 张(docs/screenshots/portfolio/)
- [x] 6.6 #6 Supervisor 按反馈建议暂缓,记入 Roadmap v0.7 候选
- [x] 6.7 全量验证:test/typecheck/build/check:dates + 截图/GIF 核验
- [x] 6.8 回标 6 条 + CHANGELOG + commit + push

## 第 7 轮:2026-08-16 用户反馈(第 6 轮:对标 Clowder AI 的 7 条借鉴项)

- [x] 7.1 #3 角色卡:RoleStore + 发射注入(发射台/对话室)+ 配置页编辑器 + 单测
- [x] 7.2 #5 共享记忆:MemoryStore(200 条裁剪)+ 记一笔 UI + 摘要注入最近 3 条 + 单测
- [x] 7.3 #1 @mention 路由:别名解析(中英文)+ 多特工派发,实测选中小克时 @鲸酱 正确路由
- [x] 7.4 #2 送评审:助手气泡按钮 + 特工选择 + 评审指令派发
- [x] 7.5 #4 富文本:mermaid(直载 vendor ESM,修复 Rollup default 导出丢失)+ KaTeX 懒加载 + 代码块复制按钮 + 5 项单测
- [x] 7.6 #6 费用看板:价目表 store/API + 用量页估算卡 + 可配置 UI
- [x] 7.7 #7 阶段标签:DB 迁移 + 列表贴纸 + 会话头部切换(最小版)
- [x] 7.8 全量验证:48 项测试 + typecheck/build + 浏览器逐项核验 + 真实任务(@mention)
- [x] 7.9 回标 7 条 + CHANGELOG + README + commit + push
