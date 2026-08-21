# v0.7 Supervisor 编排层设计方案

> 状态:**M1 已交付(v0.7.0, 2026-08-21)**;M2(UI)/M3(增强)待实施。
> 实现与本文的偏差(实现时定稿):
> 1. **反思阶段只有 replan / abort 两个选项**(原文 retry/replan/abort):验收失败的**自动重试**(带失败反馈注入)由状态机直接执行,不耗 LLM 调用;重试耗尽后才进反思,此时 retry 已无意义。
> 2. **run 状态全程持久化并 WS 推送**(planning/awaiting_approval/executing/verifying/reflecting/finalizing),前端无需轮询。
> 3. **步骤轮次 ID**:重规划后的新步骤 stepId 带 `rK-` 前缀(如 r2-s1),与首轮 s1 隔离,避免 upsert 冲突。
> 4. **门禁跨重启**:awaiting_approval 的 run 重启后重建为可审批状态,approve 时重新解析 Provider 续跑(按设计原文实现)。
> 目标:让 OpenHarness 从「Agent 可观测控制面」升级为「带自研 Agent 循环的编排平台」——平台自己实现 Plan → Dispatch → Observe → Verify → Reflect 的 Supervisor 循环,把四个 CLI Coding Agent 变成循环里可调度的「工具」。
> 本文是设计定稿文档,实现节奏见 §10 分期交付。

---

## 1. 背景与动机

### 1.1 现状定位的短板

当前 README 的定位承诺是:**「不重新实现模型层 Agent(Planning / Tool Calling / Runtime 均为工具原生能力)」**。这个口径在 v0.6 是诚实且成立的——OpenHarness 做的是异构适配、任务生命周期、会话状态、实时观测与安全边界,本质是 **Agent 的运维控制面(看板 + 发射台)**。

但站在求职/面试视角,这有一个致命短板:**项目里没有任何一行自己实现的 Agent 循环**。面试官问「你的 Agent Loop 怎么处理工具调用失败?」「上下文怎么管理?」「规划怎么验收?」——现在的答案是「这些都是 CLI 工具原生做的」,这在 Agent 岗位面试里等于没有项目。`docs/resume-bullets.md` 也早已自我警告:❌ 把适配器模式包装成"自研 Agent 框架"。

### 1.2 升级思路

**不推翻现有定位,而是在其上加一层。** 控制面(适配/观测/生命周期)继续成立;新增的编排面(Supervisor)是平台**自己实现的 Agent**:自己调 LLM API、自己跑工具调用循环、自己做规划与验收。Worker Agent(CLI)不重造——它们降格为 Supervisor 眼中的「工具」。

升级后一句话定位:

> OpenHarness = **自研 Supervisor 编排引擎** + 多 Agent 可观测控制面。
> Supervisor 直连 LLM API 实现 Plan → Dispatch → Observe → Verify → Reflect 循环,把 Cursor / Claude Code / Codex / DeepSeek Harness 四个生产级 Coding Agent 当作可调度的工具,支持人在环审批与全自动两种模式,全程事件化可观测。

这样简历上的「多 Agent 编排」第一次有了字面意义上的实现,且与 360 等 JD 点名的「Agent 编排引擎」直接对应。

### 1.3 对标:clowder-ai 是怎么做的

对标仓库:[zts212653/clowder-ai](https://github.com/zts212653/clowder-ai)(TypeScript/pnpm monorepo,与我们同构)。关键发现:

**(a) 平台层内置「原生 Agent Provider」,不套 CLI。**
`packages/api/src/domains/cats/services/agents/providers/catagent/CatAgentService.ts`:

- **直连 Anthropic Messages API + SSE 流式**,不经过任何 agent CLI;
- **自己实现 Agentic Loop**:`MAX_TOOL_TURNS = 15`,循环执行「模型输出 tool_use 块 → 本地工具注册表执行 → 结果回填 → 下一轮」,直到 stop_reason 终止或轮次耗尽;
- **自带工具注册表**(`catagent-read-tools.ts`):read_file / list_files / search_content,全部**只读**;
- **工具入参 schema 校验**(`catagent-tool-guard.ts` 的 `validateToolInput`):非法入参直接报 error,不执行;
- **结构化工具执行结果**:`{ id, name, content, status: 'ok' | 'error' }`,status 由执行边界判定而非内容字符串启发式(他们注释里明说这是修过的诚实性 bug KD-38);
- 凭证独立解析(`catagent-credentials.ts`)。

**(b) 三层职责原则(README 明文)**:

| 层 | 负责 | 不负责 |
|---|---|---|
| Model | 推理、生成、理解 | 长期记忆、纪律 |
| Agent CLI | 工具使用、文件操作、命令 | 团队协作、评审 |
| Platform | 身份、协作、纪律、审计 | 推理(模型的事) |

**(c) SOP Guardian 用机器可检查的规则落纪律。**
`sop-definitions/development.yaml`:阶段(lane)→ hard_rules(blocker/warn)→ predicate(git_state / env_check / command_pattern / changed_files_require_command / manual_only)。能机器检查的落代码,不能的显式标 manual_only。

**(d) A2A 与门禁。** @mention 路由派发、跨模型交叉评审、设计门禁(design gate)、Need Audit(PRD → 意图卡 → 风险 → 切片计划)。

**结论**:clowder-ai 验证了「平台层直连 API 自写 Agent 循环 + CLI 当工人」这条路线的可行性。我们做得更聚焦:**Supervisor 的工具不是 read_file 这种本地只读工具,而是「派发任务给 CLI Agent」本身**——编排即工具调用,这是比 Clowder 的 CatAgent 更纯粹的「多 Agent 编排引擎」故事。

---

## 2. 总体架构

```
                                    ┌──────────────────────────┐
                                    │        浏览器(React)      │
                                    │  编排 Tab:目标输入 → 计划审批 │
                                    │  → 步骤看板 → 门禁卡 → 报告  │
                                    └────────────┬─────────────┘
                                         REST / WebSocket
┌──────────────────────────────────────────────▼───────────────────────────────┐
│                            OpenHarness Server                                 │
│                                                                               │
│  ┌───────────────────────────── SupervisorManager ─────────────────────────┐  │
│  │                                                                         │  │
│  │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───────┐ │  │
│  │   │  Plan    │──▶│  Gate    │──▶│ Dispatch │──▶│ Observe  │──▶│Verify │ │  │
│  │   │ (LLM)    │   │(人在环审批)│   │ (工具执行) │   │(事件/结果) │   │(LLM)  │ │  │
│  │   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └───┬───┘ │  │
│  │        ▲              │                            ▲            │      │  │
│  │        │              ▼                            │     通过 ▶ Finalize│  │
│  │        │        ┌──────────┐                       │     不通过:      │  │
│  │        └────────│ Reflect  │◀──────────────────────┘     重试/重规划    │  │
│  │   预算/轮次边界 │ (LLM)    │                                            │  │
│  │   └────────────┴──────────┘                                            │  │
│  │                                                                         │  │
│  │   工具注册表(Supervisor 的"工具" = 现有能力的封装):                         │  │
│  │   dispatch_task ──▶ TaskManager.start/enqueue(4 个 CLI Agent)            │  │
│  │   dispatch_parallel / review_output / query_events /                    │  │
│  │   read_session / memory_read / memory_write / finalize                  │  │
│  └──────────────────────────────┬──────────────────────────────────────────┘  │
│                                 │ 复用                                          │
│  ┌──────────────┐  ┌────────────▼─┐  ┌────────────┐  ┌────────────────────┐  │
│  │ LLM Provider │  │ TaskManager  │  │ EventBus   │  │ Store(SQLite)       │  │
│  │ OpenAI兼容 + │  │ (发射/排队/打断)│  │ (WS 广播)   │  │ supervisor_runs/   │  │
│  │ Anthropic    │  └──────────────┘  └────────────┘  │ steps + 现有表       │  │
│  └──────────────┘                                    └────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
```

设计原则:

1. **编排即工具调用**:Supervisor 的 LLM 循环里,`dispatch_task(claude, "...")` 和普通 Agent 的 `read_file()` 是同一种东西——带 schema 的工具调用。面试一句话能讲清「Agent 编排引擎」的本质。
2. **全面复用,不重造**:派发走 TaskManager、观测走 EventBus、记忆走 MemoryStore、持久化走 Store。Supervisor 是薄薄一层循环 + 工具注册表 + Provider。
3. **平台自己的活动也事件化**:Supervisor 的每次规划、工具调用、观察、反思都是 HarnessEvent,进自己的活动流——「可观测控制面」的 DNA 用在自己身上,这是对 CLI 工具编排水位(谁在干、干到哪、花了多少)的降维打击,也是差异化卖点。
4. **默认人在环**:与现有「完全自主默认关闭」的安全口径一脉相承。

---

## 3. LLM Provider 层

参考 Clowder `CatAgentService`(直连 API + 自写循环),但 Provider 抽象成两种协议都支持:

```ts
// packages/server/src/supervisor/provider.ts
export interface LlmProvider {
  /** 单轮补全(非流式即可,Supervisor 不需要逐 token 流) */
  complete(req: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    tools?: ToolSchema[];          // OpenAI 格式 function calling
    toolChoice?: 'auto' | 'none';
    maxTokens?: number;
    temperature?: number;
  }): Promise<LlmResponse>;        // { text?, toolCalls?: ToolCall[], usage }
}

export type LlmResponse = {
  text: string | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  usage: { input: number; output: number };
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
};
```

- **OpenAICompatibleProvider**: `{ baseUrl, apiKey, model }`,POST `/chat/completions`。DeepSeek / Qwen / GLM / Kimi / 本地 Ollama 全覆盖。这是主推路径(用户有 DeepSeek API 经验,面试故事顺)。
- **AnthropicProvider**:Messages API,tool_use 块协议单独适配(Clouder 同款)。

**凭证管理**:复用现有配置体系——新增 `supervisor` 配置组(provider/baseUrl/model/apiKey),apiKey 为 secret 字段:零回显、预设快照仅存本机,与四个 Agent 的密钥管理同一套代码路径(配置页加一组字段即可)。未配置时编排 Tab 显示引导,不阻塞其他功能。

**成本口径**:每次 complete 的 usage 累计进 run 记录;Supervisor 自身消耗与 Worker(CLI)消耗在用量账本里分列(现有 usage 聚合按 agent 维度,Supervisor 记为独立行)。

---

## 4. Supervisor 循环(核心状态机)

### 4.1 状态机

```
created → planning → planning_gate ──approve──▶ executing ◀─┐
              │                   ──reject──▶ failed        │
              │                                              │
              │            ┌──(还有未完成步骤)── executing ──┘
              │            ▼
              │        step_done ──▶ verifying ──pass──▶ 下一步 / all_done ──▶ finalizing ──▶ done
              │            │              ──fail──▶ reflecting ──retry──▶ executing(重试该步)
              │            │                            ──replan──▶ planning(保留已完成结果)
              │            │                            ──abort──▶ failed
              │            └─(轮次/预算耗尽)──▶ failed
              └─(规划失败/超时)──▶ failed
```

- `planning`:调 LLM 产出结构化计划(JSON schema 约束):步骤列表,每步含 `{ id, title, agent, prompt, acceptanceCheck, dependsOn? }`。
- `planning_gate`:人在环模式的强制审批点(见 §6);全自动模式跳过。
- `executing`:逐步(或按依赖并行)把步骤经 TaskManager 派发给对应 CLI Agent。
- `verifying`:步骤收尾后,把「步骤目标 + Worker 产出摘要」交给 LLM 验收(通过/不通过 + 理由);轻量步骤可标记 `autoCheck: true` 跳过 LLM 验收(只看任务 exit 状态),省 token。
- `reflecting`:验收不通过时,LLM 决定 retry(原样重发,附失败原因)/ replan(回到 planning,携带已完成结果与失败上下文)/ abort。**retry 每步上限 2 次,replan 每run上限 2 次**——防死循环。
- `finalizing`:全部通过后,LLM 汇总各步产出 → 最终报告(Markdown),写入 run 记录并推送。

### 4.2 边界(防失控,全部可配置)

| 边界 | 默认 | 说明 |
|---|---|---|
| `maxSteps` | 8 | 计划步骤数上限,超出截断报错 |
| `maxToolTurns` | 40 | Supervisor 循环总轮次上限(Clowder 是 15,我们工具少给宽些) |
| `maxRetriesPerStep` | 2 | 单步重试上限 |
| `maxReplans` | 2 | 重规划上限 |
| `tokenBudget` | 200k | run 级 token 预算(Supervisor 自身),超出中止 |
| `stepTimeoutMs` | 30 分钟 | 单步 Worker 任务超时(继承 TaskManager 打断) |
| `maxParallel` | 2 | 同时派发的 Worker 数 |

### 4.3 上下文管理

- 每步传给 LLM 的上下文 = 系统提示(角色 + 工具说明 + 输出契约)+ 目标 + 当前计划状态 + 已完成步骤的**摘要**(标题 + 结论,不传全文)+ 本步相关观察。
- Worker 产出全文可能很大:入库时保存全文,传 LLM 前截断(每步摘要上限约两千字符,复用 `truncate` 思路);`read_session` 工具允许 Supervisor 主动拉全文片段。
- 失败上下文:验收失败时,把「验收理由 + Worker 输出尾部」注入重试 prompt。

---

## 5. 工具协议(编排即工具调用)

```ts
// packages/server/src/supervisor/tools.ts
interface SupervisorTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
  execute(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult>;
}
type ToolResult = { ok: boolean; output: string };  // output 截断到 ~4000 字符回填 LLM
```

| 工具 | 参数 | 实现 | 说明 |
|---|---|---|---|
| `dispatch_task` | `agent, prompt, cwd, stepId?` | TaskManager.start + 等待收尾 | 阻塞至任务结束,返回产出摘要与 exit 状态 |
| `dispatch_parallel` | `tasks: [{agent, prompt, stepId?}]` | Promise.all + 并发上限 | 互不依赖的步骤并行(默认 2) |
| `review_output` | `taskId, reviewer` | 对产出发起评审任务 | 跨模型交叉评审(Clowder 同款故事:claude 写、codex 审) |
| `query_events` | `agent?, kind?, since?, q?` | Store 事件查询 | Supervisor 查看全域活动(观察面复用) |
| `read_session` | `sessionId, agent, tail?` | 会话档案读取 | 拉某会话尾部全文,深挖 Worker 产出 |
| `memory_read` / `memory_write` | — | MemoryStore | 团队共享记忆读写 |
| `finalize` | `report` | 收尾 | 退出循环,报告落库 |

**入参校验**(对标 `catagent-tool-guard`):执行前按 `parameters` schema 校验,非法入参返回 `{ ok: false, output: 'Error: invalid arguments ...' }` 回填 LLM 让它自纠,不 throw——循环不因单次坏调用崩掉。

**工具执行状态归因**:status 由执行边界(dispatch 是否成功、任务 exit 状态)判定,不做内容字符串启发式(Clowder KD-38 教训直接吸收)。

---

## 6. 人在环门禁(两种模式)

用户已确认:**两种模式可切换**。

| | 人在环(默认) | 全自动 |
|---|---|---|
| 计划审批 | 强制:计划生成后 run 挂起 `planning_gate`,WS 推送审批卡 | 跳过 |
| 步骤审批 | 可选:步骤标记 `needsApproval`(默认 false) | 无 |
| 重规划审批 | 强制:replan 后的新计划再次过 gate | 无 |
| 开关位置 | 编排 Tab 默认;run 级也可指定 | 红色警示 + localStorage 记忆(与「完全自主」同款交互) |
| API | `POST /api/supervisor/runs/:id/approve` `{ action: 'approve' \| 'reject' \| 'edit', plan? }` | — |

门禁挂起不占线程:run 状态持久化为 `awaiting_approval`,服务重启后恢复继续(与任务恢复同款逻辑)。

---

## 7. 持久化与事件

### 7.1 新表

```sql
CREATE TABLE supervisor_runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL,              -- 'hitl' | 'auto'
  state TEXT NOT NULL,             -- created/planning/awaiting_approval/executing/verifying/reflecting/finalizing/done/failed/stopped
  plan_json TEXT,                  -- Plan(步骤数组)
  report TEXT,                     -- 最终报告
  error TEXT,
  usage_json TEXT,                 -- { input, output } Supervisor 自身消耗
  created_at INTEGER, ended_at INTEGER
);
CREATE TABLE supervisor_steps (
  run_id TEXT, step_id TEXT,
  title TEXT, agent TEXT, prompt TEXT, acceptance_check TEXT,
  state TEXT,                      -- pending/approved/running/done/failed/skipped
  task_id TEXT,                    -- 关联 TaskManager 任务
  attempt INTEGER, verify_result TEXT, verify_reason TEXT,
  PRIMARY KEY (run_id, step_id)
);
```

### 7.2 事件接入

Supervisor 的活动以 HarnessEvent 进统一流水线(`agent` 复用四 Agent 值,`meta.supervisorRunId` 归因),新增 EventKind:`plan-created` / `gate-waiting` / `verify-passed` / `verify-failed` / `replan` / `run-finalized`(前端活动流筛选器同步加)。WS 推送 `supervisor` 类型消息(run/steps 状态变更),编排 Tab 实时刷新。

---

## 8. API 与 UI

### 8.1 API

```
POST   /api/supervisor/runs            { goal, cwd, mode }         → 创建并启动
GET    /api/supervisor/runs            → 历史列表
GET    /api/supervisor/runs/:id        → run + steps 详情
POST   /api/supervisor/runs/:id/approve { action, plan? }           → 门禁审批
POST   /api/supervisor/runs/:id/stop                                → 中止(打断进行中任务)
GET    /api/supervisor/config          → Provider 配置 schema(密钥零回显)
PUT    /api/supervisor/config          → 写入配置
```

### 8.2 UI(编排 Tab)

- **发起区**:目标输入 + 目录选择 + 模式开关(人在环/全自动,全自动红框警示)+ 预算展示。
- **Run 视图**:计划步骤看板(状态贴纸:待审批/进行中/已验收/失败重试中)、门禁审批卡(计划 diff,可编辑后批准)、每步关联任务深链(点击进会话档案看 Worker 全过程)、最终报告(Markdown 渲染,复用 MdBody)。
- **历史列表**:run 卡片(目标/状态/耗时/Supervisor token 消耗)。
- 漫画风融入:Supervisor 定位为「指挥官」角色(第五位成员),视觉与四特工一致。

---

## 9. 测试与安全

### 9.1 测试(CI 无 API Key 可跑)

1. **MockProvider**:脚本化 LLM 响应(第 N 轮返回什么 toolCalls/text),驱动全循环单测:
   - 计划生成 → 门禁挂起 → 批准 → 派发(mock TaskManager)→ 验收通过 → 报告;
   - 验收失败 → 重试 → 重规划 → 预算耗尽中止;
   - 非法工具入参自纠;轮次上限;并发上限。
2. **工具层单测**:schema 校验、输出截断、状态归因。
3. **Provider 单测**:OpenAI 兼容格式解析(用 nock/undici mock HTTP)、Anthropic tool_use 块解析。
4. **状态机单测**:每态迁移的合法/非法路径(对标现有任务状态机测试)。
5. **真实冒烟**(本机手动,不进 CI):DeepSeek API 真跑一个双步骤 run(规划 → claude 执行 → 验收 → 报告)。

### 9.2 安全边界(继承现有口径)

- 服务仅 127.0.0.1;Supervisor API Key 零回显,预设仅存本机;
- 全自动默认关闭,红色警示 + 显式开启;
- Worker 派发不自动继承 bypassPermissions:Supervisor 发起的任务默认保守模式,「完全自主」需 run 级再显式开启(双层确认);
- 预算/轮次/超时硬边界在代码层强制,不依赖 prompt 自觉;
- SOP 思路(Clowder 借鉴):把「红线」做成代码检查而非 prompt 约定——例如 Supervisor 禁止把 `.env`/`presets.json` 内容写进 prompt(路径黑名单过滤工具)。

---

## 10. 分期交付

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 后端循环** | Provider(OpenAI 兼容)+ 状态机 + 工具注册表(dispatch_task/query_events/memory/finalize)+ 持久化 + REST/WS + MockProvider 全链路单测 | 单测绿;真实 DeepSeek 冒烟 run 成功 |
| **M2 门禁与 UI** | 人在环 gate + approve API + 编排 Tab(发起/Run 视图/审批卡/报告)+ 活动流新事件类型 | 浏览器端到端:发起 → 审批 → 派发 → 报告 |
| **M3 编排增强** | dispatch_parallel + review_output(交叉评审)+ read_session + 用量账本 Supervisor 分列 + 全自动模式警示交互 | 并行 run + 交叉评审 run 实测 |

每个里程碑独立可交付、独立 commit,保持现有「反馈闭环 → TODO 回标 → CHANGELOG」节奏。

---

## 11. 口径升级预览(实现验证后启用)

- README 定位段:「不重新实现模型层 Agent」→「**Worker Agent 不重造;平台自身实现 Supervisor 编排循环**(直连 LLM API 的 Plan → Dispatch → Observe → Verify → Reflect)」;
- `resume-bullets.md` 新增第 6 条(草稿,实测数字落地后定稿):
  > 6. 自研 Supervisor 编排层:直连 LLM API(OpenAI 兼容 / Anthropic 双协议)实现规划-派发-观察-验收-重规划 Agent 循环,将 4 个 CLI Coding Agent 封装为 schema 校验的工具调用,支持人在环审批与全自动双模式,轮次/重试/Token 预算硬边界 + 全链路事件可观测(复核:`packages/server/src/supervisor/`)。
- 简历 V3 项目经历 OpenHarness 条目重写(能力落地 + 冒烟数据后);「项目介绍」从「可观测控制面」升级为「多 Agent 编排引擎 + 可观测控制面」。
- 禁用口径相应更新:原第 3 条「不要包装成自研 Agent 框架」改为「**Supervisor 循环是真实实现,可现场演示;但 Worker Agent 的 Planning/Tool Calling 仍为 CLI 原生——两层都要讲清,不混为一谈**」。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 计划质量差,演示翻车 | 计划 schema 约束 + 示例 few-shot;人在环审批本来就把关;演示用例选确定性任务(如「调研+实现+评审」三步) |
| Worker 产出超长撑爆上下文 | 全文入库、摘要进循环 + read_session 按需拉取 |
| 全自动模式被滥用 | 双层确认 + 预算硬边界 + 默认关闭,与现有安全口径一致 |
| 工期 | M1/M2/M3 独立交付,每期都是可用状态;M1 完成即具备面试演示的最小闭环(可经 curl 演示) |
