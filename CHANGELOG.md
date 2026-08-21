# Changelog

> 版本规则与提交规范见 [docs/harness/git.md](docs/harness/git.md)。新版本在上。
> 早期版本(v0.1 / v0.2)在引入 CHANGELOG 前,按 git log 与 README 简录补记。

## [v0.7.0] - 2026-08-21

定位升级轮:引入 **Supervisor 编排层**——平台自身实现 Agent 循环(设计见 `docs/supervisor-design.md`,对标 clowder-ai 的 CatAgent 原生 Agent 模式)。本版交付后端完整闭环(M1);编排 UI(M2)与并行派发/交叉评审(M3)见 Roadmap。

### 新增
- **Supervisor Agent 循环**(`packages/server/src/supervisor/`):planning(LLM 结构化规划,可先调 query_events/memory_read 收集背景)→ [人在环] awaiting_approval 门禁 → executing(经 TaskManager 派发 Worker,自动重试带失败反馈)→ verifying(LLM 按 acceptanceCheck 验收;autoCheck 只看任务状态)→ reflecting(重试耗尽决定 replan/abort)→ finalizing(LLM 汇总报告)
- **LLM Provider 层**:OpenAI 兼容协议(DeepSeek/Qwen/GLM/Kimi/Ollama 通用),原生 tool-calling 消息协议(assistant.tool_calls + tool 回填),SSE 之外的统一超时/错误映射
- **工具注册表**:dispatch_task / query_events / memory_read / memory_write,零依赖手写入参 schema 校验(非法入参返回 error 回填模型自纠,不 throw);执行状态由边界判定
- **编排 REST API**:`POST/GET /api/supervisor/runs`、`GET /runs/:id`、`POST /runs/:id/approve`(approve/reject/携带修订计划)、`POST /runs/:id/stop`、`GET/PUT /api/supervisor/config`(密钥零片段)
- **Supervisor 配置**:Provider/baseUrl/model/apiKey 存 `~/.openharness/supervisor.json`(默认 DeepSeek),密钥不下发任何片段
- **持久化与恢复**:supervisor_runs / supervisor_steps 两表;服务重启时执行中的 run 归位 stopped,门禁挂起的 run 恢复后可继续审批续跑
- **事件化**:新增 6 种 EventKind(plan-created/gate-waiting/verify-passed/verify-failed/replan/run-finalized)进统一活动流,agent='supervisor'(指挥官,第五位成员,不占状态卡)
- **硬边界**(代码层强制):maxSteps 8 / 规划轮次 8 / 单步重试 2 / 重规划 2 / Token 预算 200k / 步骤超时 30min

### 测试
- MockProvider 脚本化 LLM 全链路单测:hitl 审批/拒绝、auto 模式、验收失败自动重试(带失败反馈)、反思 replan(步骤轮次 rK-sN 隔离)与 abort、Token 预算耗尽、规划失败、执行中 stop(Worker 任务联动打断)、重启恢复(approving 续跑)、工具校验、Provider wire 格式(system 前置/tool_call_id 回填/tool_calls 解析/错误映射)、配置密钥零片段——总计 66 项断言(原 48)

### 验证
- `pnpm -r typecheck` + `pnpm build` + 66 项测试全绿;live 冒烟:config 读写/未配置显性报错/supervisor 单任务发射拒绝/既有路由回归(agents/sessions/events)正常

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

## [v0.3.2] - 2026-08-15

第 2 轮反馈复测(#4)与补充反馈(#7/#8),均为根因级修复。

### 修复
- **对话室页面越聊越长**(#4 复测未修复的真根因):tab 内容容器缺 `flex`,面板无法被高度约束,长对话把整页撑爆(实测页面总高 3000+px、发送框被推出版面)。补上 flex 约束后,30+ 条消息长对话页面零滚动、发送框固定、自动跟随最新
- **会话档案无轨迹数据**(#7):codex 旧解析器把消息事件散落到条目 ID 下(`response_item.payload.id` 是条目 ID 而非会话 ID),且消费完的文件重启后把会话汇总清零 → 文件级统一覆盖会话 ID、已消费文件跳过,并一次性重建索引(meta 迁移 `reindex-v1.2`);cursor 接入 conversation-search.db 的 FTS body,时间线展示对话全文摘要,标题回退 FTS
- **Codex CLI 无法对话**(#8):① CLI 不读 macOS 系统代理,直连 OpenAI 超时(App 正常)→ 适配器经 `scutil --proxy` 解析并注入代理环境变量;② CLI v0.144+ 的 `--json` 流改用 `item.completed` 格式,旧解析器漏掉回复 → 支持新格式。实测任务 12 秒完成、回复正常(此前 4 分钟重连后失败)
- **chokidar v4 绝对路径 + glob 不触发**(顺带发现):三个适配器(claude/codex/dsh)的实时 watcher 全部失效 → 改为监听根目录 + 处理器按扩展名过滤,合成文件实测实时索引恢复

### 工程
- Store 新增 meta 表 + `resetAgentIndex`(一次性索引重建迁移)
## [v0.3.3] - 2026-08-15

第 4 轮反馈(#9 状态卡误报 / #10 答复截断),均为根因级修复。

### 修复
- **任务完成但左侧状态卡仍显示 RUN**(#9):状态探测 `pgrep -f` 匹配"任意命令行里含单词 dsh"的进程——脚本/终端里 `"agent":"dsh"` 之类的字符串都会触发误报(字符串污染,复现确认)。修复:dsh/claude 探测改为"可执行位置"匹配(`bin/dsh`、`dsh --profile` 才计数);dsh 任务收尾后 10s 清理残留进程组(SIGKILL);任务收尾后 +5s/+15s 延迟刷新状态。实测任务完成起状态卡持续待命
- **对话室特工答复被截断**(#10):四个适配器把助手回复 truncate(200~400 字)后存入事件摘要,对话气泡只能拿到截断版。现在事件 `meta.fullText` 携带全文(claude/codex/dsh/cursor 全覆盖),对话回填优先用全文。实测 1091 字回复气泡完整展示

## [v0.3.4] - 2026-08-15

第 5 轮反馈(对话室 2 条 + 第 3 轮 7 条,共 9 条),根因级修复 + 体验打磨。

### 修复
- **活动流重复消息**(#2):发射路径(stdout)与文件监听路径重复入库 → 按(agent+会话+类型+全文)指纹入库去重,一次性迁移清理存量重复 1415 条,实测消息类重复归零
- **系统注入上下文混入用户消息**(#3):四工具解析器过滤 `<recommended_plugins>`/`<system-reminder>` 等注入;`[对话背景]` 注入任务在展示层自动提取「[本轮消息]」后真实输入(活动流/会话标题/任务记录);任务记录改用用户原始输入
- **会话档案汇总清零**:claude/dsh 与 codex 同款的"已消费文件重启后被空解析覆盖为 0 消息"bug → 已消费且无新内容时跳过汇总;重建 claude/dsh 索引
- **配置页密钥片段泄漏**(#6):密钥字段不再返回任何片段——输入框只显示「已设置/留空不改」,只读摘要与预设列表一律占位符(••••••••)
- **用量日期轴不连续**(#7):按天图对所选范围逐日补零,超 45 天自动抽稀标签(数据柱与悬浮提示仍逐日完整)

### 新增
- **目录选择器**(#11):发射台/对话室「浏览…」(本机原生 choose folder)与「＋新建」(新建文件夹作为工作区)
- **会话记忆**(#12):每个对话记住自己的特工与工作目录,刷新/切页不重置
- **会话档案分页**(#4):服务端游标「加载更早」+「已加载 X / 共 Y」,搜索与特工筛选覆盖全部会话
- **空会话默认隐藏**(#5):「含空会话」开关;清理残留测试数据
- **移动端响应式**(#1):390px 窄屏标签横滑、对话列表抽屉(☰)、活动流窄列收窄,无横向裁切

## [v0.4.0] - 2026-08-15

第 5 轮追加反馈(#13 对话室 Markdown 渲染,闭环中追加、收尾前补读发现)。

### 新增
- **对话气泡 Markdown 渲染**:marked 解析 + DOMPurify 消毒(XSS 防护,理由见 commit),支持标题/列表/行内代码/代码块/表格/引用/链接等,漫画风 .md-body 样式
- **「Markdown」开关**:对话室头部开关,默认开启、localStorage 记忆,关闭即显示原始文本(实测两种模式切换正常)

### 文档
- feedback-loop.md 补充硬规则:**回标前必须重读 user-question.md 全文**,防闭环中追加的条目被漏掉

## [v0.5.0] - 2026-08-16

第 4 轮反馈(求职作品集与工程可信度,6 条;#6 Supervisor 按反馈自身建议暂缓入 Roadmap)。

### 新增
- **自动化测试体系**:vitest 7 个测试文件 39 项断言——core 工具函数、四工具会话解析器(注入过滤/全文透传/游标续读)、事件指纹去重、ConversationManager 状态机(resume 链/摘要注入/收尾反馈/防重复气泡)、密钥零片段、TOML/YAML 逐行补丁、Markdown 渲染消毒
- **GitHub Actions CI**:`.github/workflows/ci.yml`(typecheck → test → build → check:dates)
- **一分钟演示 GIF**:90 秒 3MB(docs/screenshots/demo.gif),按脚本演示发任务→实时流→对话室→档案→用量→配置
- **深色工程风作品集截图**:5 张(docs/screenshots/portfolio/),README 新增作品集小节
- **简历口径文档**:docs/resume-bullets.md(定位/逐条可复核要点/禁用口径)

### 文档
- README:定位统一为「多 Agent 编排与可观测控制台」,首屏重构为定位→演示→解决问题→架构;删除「11 个 commit」等静态过程数字,改为「多轮真实使用反馈迭代」
- SUMMARY:重写为定位口径 + API 实时数据快照(137 会话/458 万 tokens/5880 工具调用,标注动态)+ 10 个真实 bug 素材
- Roadmap:v0.5 完成;Supervisor 编排层记入 v0.7 候选(默认关闭自动执行)

## [v0.6.0] - 2026-08-17

第 6 轮反馈(对标 Clowder AI,7 条借鉴项,全部轻量落地)。

### 新增
- **@mention 显式路由**:消息含 `@小克`/`@码星人`(中英文别名)自动路由到该特工,支持一条消息 @多个特工逐个派发(实测:选中小克时发 @鲸酱,任务正确派给鲸酱)
- **送评审**:助手气泡「🕵 送评审」按钮,一键派发标准评审指令给其他特工(自动排除自己),评审结果回流对话
- **特工角色卡(持久身份)**:四特工内置角色卡,任务发射时以 `[角色设定]` 前缀注入最前;配置页可编辑(~/.openharness/agent-roles.json)
- **富文本升级**:mermaid 流程图 + KaTeX 数学公式 + 代码块「复制」按钮;mermaid/katex 均懒加载。工程踩坑:mermaid core 构建经 Rollup 二次打包会丢失 default 导出 → 构建插件直载 vendor 完整 ESM 运行时加载
- **团队共享记忆**:~/.openharness/memory.md(200 条上限自动裁剪),对话室「✎ 记一笔」,切换特工/新对话注入最近 3 条
- **费用估算**:用量账本「费用估算」卡(总额+按特工),可配置价目表(~/.openharness/pricing.json),未知模型按默认价
- **对话阶段标签**:想法/方案/进行中/评审/完成,列表贴纸 + 会话头部下拉(DB 迁移)

### 测试
- 新增 RoleStore/MemoryStore/角色与记忆注入/markdown 分段管线(含 mermaid 提取、XSS、$ 保护)等测试,总计 48 项断言

## [v0.6.1] - 2026-08-17

### 新增
- **@ 自动补全**(对话室):输入 @ 弹出特工列表(头像+名称+id),继续输入即过滤,↑↓/Enter/点击选取、Esc 关闭;与 @mention 路由无缝衔接,支持连续点名多个特工

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
