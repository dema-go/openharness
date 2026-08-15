# AGENTS.md — OpenHarness 项目协作规范

本文件是各类 Agent 工具(Cursor / Claude Code / Codex / DSH 等)在本仓库工作时必须遵守的共同约定。

## 日期规范(最重要,历史教训)

> **教训**:2026-08 曾发现 docs/ 与 design/ 多处文档把"当前日期"写成 2025,
> 原因是写文档的 Agent 凭模型记忆推断年份,而不是查系统时钟——实际当时是 2026-08-15。

1. **一切"当前日期"以本机系统时钟为准,禁止凭模型记忆或训练数据推断年份。**
   写入任何文档/代码前,先运行 `date '+%Y-%m-%d %H:%M'` 确认真实日期。
2. 文档中"今日 / 本月 / 本轮讨论 / 交付时间 / 现状盘点"等**当前时间语义**的标注,
   必须使用上一步查到的真实日期。
3. **外部资料的真实年份不得篡改**:引用的调查、文章、版本号、历史事件
   (如 "Stack Overflow 2025 调查"、某 CLI 的发布年份)保留其本来年份,
   与"当前日期"区分开;禁止为了"统一成今年"而改动它们。
4. 页面/组件/脚本中展示"今天"时,一律用运行时 `new Date()` 动态生成,
   **禁止硬编码日期字符串**(设计稿、mockup 同理)。
5. 修改任一文档的日期后,核对同批文档(状态行、讨论轮次、里程碑、CHANGELOG)
   的日期是否一致。
6. 提交前运行 `pnpm run check:dates`。若告警指向外部资料的真实年份,
   把该处的原文加进 `scripts/check-dates.mjs` 的 `ALLOWLIST` 并注明理由;
   否则一律修正为系统时钟的当前年份。

## 仓库结构

- `docs/` — 产品/架构/决策文档(活文档,每轮讨论后更新)
- `docs/harness/` — 开发规范与用户反馈(本文件硬规则的细则来源)
- `design/` — 设计稿与静态 mockup
- `packages/` — core / agents / server / web 四个包(pnpm workspace)
- `scripts/` — 工程脚本(含 `check-dates.mjs` 日期检查)
- 根目录:`TODO.md`(当前迭代任务)、`CHANGELOG.md`(版本记录)、`AGENTS.md` / `CLAUDE.md`(协作规范入口)

## 反馈闭环(每次版本更新,细则见 docs/harness/feedback-loop.md)

1. 用户反馈统一记入 `docs/harness/user-question.md`,按"第 N 轮(YYYY-MM-DD)"分节;
   已完成的反馈**只追加回标、不删除、不改写原文**。
2. 版本更新前,必须通读 user-question.md 中全部未完成条目 → **逐项与用户确认决策点**
   (选项式提问,推荐项放首位标注 Recommended)→ 生成根目录 `TODO.md`(勾选式,含验证项)。
3. **未与用户确认的需求禁止动手**;用户没拍板的取舍不许擅自决定。
4. 全部完成后:勾选 TODO.md;user-question.md 对应条目追加 `> ✅ vX.Y.Z 交付:…` 回标;
   更新 CHANGELOG.md 与 README 功能全景表。

## 修改顺序与验证(细则见 docs/harness/development.md)

1. 跨层改动按 **core(类型契约)→ agents(四个适配器一个不少)→ server → web** 顺序推进。
2. 每个完成项的验证缺一不可:`pnpm -r typecheck` + `pnpm -r build` + 接口 curl 实测 +
   UI 截图核验;改 server 代码后**必须重启 server 再验证**(tsx 无 watch)。
3. 新 CLI 能力先 `--help` / 构造必失败参数核实,再写代码;真实任务测试用极小 prompt 控成本;
   测试产生的对话/预设/任务数据验证后清理。
4. 动用户真实配置文件(~/.claude、~/.codex、~/.dsh)时:先备份 → 幂等验证 → diff 只动目标键 → 还原或确认无害。
5. 安全红线:密钥明文绝不进入任何 API 响应;「完全自主」类危险开关默认关闭且必须有红色警示;
   服务只监听 127.0.0.1;预设快照仅存本机。

## 提交与版本(细则见 docs/harness/git.md)

- 提交格式 Conventional Commits 中文版:`feat/fix/docs/refactor/chore/test: 中文描述`
  (首行 ≤ 50 字,body 说明"为什么"与"怎么验证的")。
- 一个反馈闭环一个 commit(或同闭环内按功能拆分);不提交密钥、.env、构建产物、临时文件。
- 版本遵循 SemVer;每轮闭环在 CHANGELOG.md 记新条目(新版本在上)。

## 代码规范(细则见 docs/harness/code-style.md)

- 跨包类型集中在 `packages/core/src/types.ts`;适配器能力变更先改 `packages/core/src/adapter.ts`。
- 禁止 `any`;中文注释解释**为什么**;单文件单一职责;禁止硬编码绝对路径。
- 依赖克制:能自写不引库,新增依赖需在 commit 说明理由。
- 数据库:参数化 SQL;加列用 `PRAGMA table_info` 检查迁移;分页多取一条判 hasMore。
- 前端:组件与 server 交互一律经 `lib/api.ts`;实时数据经 `useBus` 单连接;沿用 comic-* 组件类与漫画风。

## 文档写作约定

- 状态行格式:`> 状态:…(YYYY-MM,…)`,年份必须来自系统时钟;
- 讨论/决策记录按"第 N 轮(YYYY-MM-DD)"编号,日期同样取自系统时钟;
- 引用外部链接时保留链接原样,不得为改年份而改动 URL。
