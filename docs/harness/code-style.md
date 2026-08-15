# 代码规范(轻量清单)

> 目的:让 AI 与人都能快速读懂、安全修改。约 20 条,按包分层。

## 1. monorepo 分层职责

| 包 | 只做 | 不做 |
|---|---|---|
| `core` | 类型契约、AgentAdapter 接口、通用工具(truncate/maskSecret) | 不读文件、不碰进程 |
| `agents` | 四个工具适配器(索引/监听/发射/配置读写)+ 共用 config-utils | 不写路由、不碰前端 |
| `server` | store(SQLite)、bus、tasks、conversations、presets、routes、suggest | 不渲染 UI |
| `web` | 组件 + lib(api/useBus) | 不直连数据库 |

## 2. 类型与契约

- 跨包类型集中在 `core/src/types.ts`;适配器能力变更先改 `core/src/adapter.ts`
- 事件模型统一走 `HarnessEvent`;新增字段用可选(`?`)保证向后兼容
- 禁止 `any`(确需时用 `unknown` + 收窄);对外返回类型显式标注

## 3. 注释

- 中文注释,解释**为什么**(设计取舍、踩过的坑),不翻译代码
- 关键模块用 JSDoc 头注释:职责一句话 + 要点列表(参见现有 adapter 文件风格)
- 非显而易见的 hack 必须注释(如"排除常驻 dsh web 进程"、"cursor-key 游标防重复")

## 4. 文件与命名

- 单文件单一职责;React 组件一个文件一个组件
- 组件 PascalCase、函数/变量 camelCase、常量 SCREAMING_SNAKE、文件名 kebab-case
- 新增 server 模块以名词命名(conversations.ts / presets.ts),与 store/routes 并列

## 5. 依赖克制

- 能自写就不引库(先例:TOML/YAML 逐行补丁自写、zstd 用纯 JS fzstd)
- 新增依赖需在 commit 说明理由;优先标准库(node:sqlite、node:fs 等)

## 6. 错误处理与健壮性

- 批量索引:单个文件损坏不阻塞整体(现有各 adapter 的 try/catch 模式)
- 用户可见的错误消息用中文,带上下文(如 `目录不存在:${cwd}`)
- 路径统一 `path.join(os.homedir(), ...)`,禁止硬编码绝对路径

## 7. 数据库(Store)

- 只用 better-sqlite3;建表 `IF NOT EXISTS`;加列用 `PRAGMA table_info` 检查迁移(现有 model 列迁移模式)
- 查询参数化,禁止字符串拼接 SQL;分页统一 `LIMIT ?` + 多取一条判 `hasMore`

## 8. 前端

- Tailwind 4 原子类 + 全局漫画风组件类(comic-card / comic-btn / comic-input / sticker / bubble / halftone)
- 状态用 React hooks,不引入状态库;实时数据经 `useBus` 单连接分发
- 与 server 的交互全部经 `lib/api.ts`,组件不直接 fetch
- 列表 key 稳定(事件用 seq,会话用 agent+sessionId)

## 9. 安全

- 涉及密钥:显示走 `maskSecret`,编辑只提交新值,存储仅本机
- 「完全自主」类危险开关:UI 必须红色警示 + 默认关闭
