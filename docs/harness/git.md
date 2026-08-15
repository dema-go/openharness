# 版本号与提交规范

## 1. 版本号规则(SemVer)

- 格式 `v主.次.修订`,如 `v0.3.0`
- **修订(patch)**:bug 修复、文档修正
- **次(minor)**:新增功能——一轮"反馈 → TODO → 完成"的闭环通常记为 minor
- **主(major)**:不兼容的架构变更(0.x 阶段几乎不会发生)
- 版本号落点:CHANGELOG.md 条目 + README 功能全景表 + user-question.md 回标

## 2. 提交规范(Conventional Commits 中文版)

```
<type>: <中文描述>

<可选 body:为什么这样改 / 验证结果>
```

type 取值:

| type | 用途 | 示例 |
|---|---|---|
| feat | 新功能 | `feat: 对话室支持原生 resume 续接上下文` |
| fix | 修复 bug | `fix: patchToml 根键替换区间为空导致重复插入` |
| docs | 文档/规范 | `docs: 新增 docs/harness 开发规范` |
| refactor | 重构(不改行为) | `refactor: 事件分页抽取 eventsPage` |
| chore | 杂项(依赖/配置/脚本) | `chore: 升级 typescript 5.7` |
| test | 测试相关 | `test: ConversationManager 状态机单测` |

规则:

- **一个闭环一个 commit**(或按功能拆分为多个,但同一闭环内)
- 首行 50 字内;body 说明"为什么"与"怎么验证的"(本项目传统:每轮端到端实测)
- 不提交:密钥、`.env`、构建产物(已有 .gitignore 覆盖)、临时测试文件

## 3. CHANGELOG.md 维护

- 位置:仓库根目录 `CHANGELOG.md`
- 每轮闭环新增一个版本条目,格式:

```markdown
## [v0.3.0] - 2026-08-15

### 新增
- 活动流:游标「加载更早」+ 事件类型/关键词筛选
- ...

### 修复
- patchToml 根键替换区间 bug

### 文档
- docs/harness 开发规范
```

- 保持「新版本在上」;早期版本(未有 CHANGELOG 的时期)允许简录补记
- 与 commit 一一对应:每个版本条目的内容应能从 `git log` 追溯到具体提交
