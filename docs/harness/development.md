# 开发与验证流程

## 1. 分层修改顺序(monorepo 自下而上)

任何跨层能力(如新的事件类型、新的启动参数),按以下顺序推进,避免返工:

```
core(类型契约 + adapter 接口)
  → agents(四个适配器全部实现,一个都不能少)
    → server(store / 总线 / 任务 / 对话 / 路由)
      → web(api.ts → 组件)
```

- 契约集中在 `packages/core/src/types.ts`(类型)与 `packages/core/src/adapter.ts`(AgentAdapter 接口)
- 改契约后,四个适配器(claude / codex / cursor / dsh)必须同步实现或显式声明不支持(如 dsh headless 无 `--resume`,由上层降级处理)

## 2. 每项 TODO 的完成标准(验证清单)

每个勾选项必须全部通过,缺一不可:

| 验证 | 命令/方式 |
|---|---|
| 类型 | `pnpm -r typecheck` |
| 构建 | `pnpm -r build`(web 产物供 3900 直接托管) |
| 接口 | 重启 server 后 curl 实测(参数、返回结构、边界值) |
| UI | agent-browser 截图逐页核验(布局、交互、状态回填) |
| 数据 | 涉及 SQLite 变更时,验证迁移(旧库启动不报错、新表可用) |

- **重启才生效**:`tsx src/index.ts` 无 watch,改完 server 代码必须重启再验证
- **WS 链路**要用真实事件验证(任务事件 → 前端气泡/活动流),不能只测 REST

## 3. 真实 Agent 测试的边界

- CLI 能力**先核实再写代码**:用 `--help` / 构造"必失败参数"探测(如 `--resume` + 假 session id),确认参数被接受、错误信息符合预期
- 必须真跑时:prompt 极小化(如"只回复两个字:收到"),控制 token 成本
- 真实任务产生的测试数据(对话、预设、任务记录)验证后**清理干净**

## 4. 用户真实文件的操作红线

- 测试会写用户配置文件(~/.claude/settings.json、~/.codex/config.toml、~/.dsh/*.yaml)时:
  1. 先备份到 /tmp,2. 用幂等值(写入=现值)验证,3. diff 确认只动了目标键,4. 还原或确认无害
- 补丁式写文件(patchToml/patchYaml)必须保证:既有键原位替换、缺失键插入到正确位置、**其余内容字节级保留**

## 5. 安全红线(不可回归)

- 服务仅监听 `127.0.0.1`;密钥明文**永不**出现在任何 API 响应中(编辑只提交新值、预设下发脱敏)
- 预设快照(含密钥明文)仅存 `~/.openharness/presets.json`
- 「完全自主」模式默认关闭,UI 必须有红色警示
- 凭据文件读取只发生在 server 本机进程内,不向 web 端透出

## 6. AI 协作约定

- 关键决策用选项式提问(ask_user_question,推荐项标注 Recommended 放首位),不替用户拍板
- 长任务建 TODO 追踪进度;每轮收尾必须汇报:交付了什么、验证结果、遗留事项
- 服务重启/进程操作若影响用户正在使用的东西,先告知再动手
- 发现与需求无关的 bug(如 patchToml 区间 bug),顺手修复并在 CHANGELOG 记入 fix
