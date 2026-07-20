# AGENTS.md - pi-context 项目知识库

## 概述

**pi-context** 是 [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) 的 fork，由 KorenKrita 独立维护。它为 Pi agent 提供主动上下文管理能力：agent 可以创建 recoverable save point、查看会话树，并通过 summary branch fold、rebase 或 rehydrate 上下文。

设计遵循道/术/度分层：CORE 注入压缩即智能的判断力（道）与 cadence 偏好（度），工具描述和 result cue 承载可执行机制（术），advanced Skill 只在复杂场景按需加载。guidance 不规定固定流程、后缀状态机或全局调用次数；agent 默认拥有 ACM 自主权，只有用户明确要求暂停 travel 时在所述范围内暂停。

项目暴露三个 ACM 工具：

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 给会话历史节点追加语义 checkpoint alias（save point） |
| `acm_timeline` | 输出 active path / checkpoints / search / tree 单一视图及 context HUD |
| `acm_travel` | 通过七槽 handoff 创建 summary continuation branch（fold / rebase / rehydrate） |

`src/context.ts` 另行注册 Pi 独有的 `/context` TUI 命令，与 ACM 工具职责分离；非 TUI mode 必须在进入 custom terminal UI 前给出 warning 并返回。

## 技术栈与版本契约

- TypeScript ESM（`module: esnext`、`moduleResolution: bundler`、`target: esnext`）；source-first 安全门启用 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`isolatedModules`、`verbatimModuleSyntax` 与 `erasableSyntaxOnly`
- Source-first：Pi 直接加载 `src/*.ts`，生产不依赖 `dist/`
- 工具参数 schema 使用 `@earendil-works/pi-ai` 的 TypeBox `Type.*`
- `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 的 peer/dev dependency 均精确固定为 **`0.80.7`**
- `test/host-fixture/` 也精确安装 Pi `0.80.7`，用于验证真实 host contract

不要把开发依赖与 host fixture 的精确版本改成 caret/tilde range。Live Agent Sync 不读取、报告或按宿主版本分支；它只探测当前运行时实际使用的能力，缺失或失败时返回 `unavailable` 并保留 persistent rebuild/reload fallback。

## 架构

### Composition root

`src/index.ts` 只负责：

1. 创建一个 `AcmSessionRuntime`
2. 注册 canonical prompt injection
3. 注册三个工具
4. 注册 lifecycle handlers

`ensureAcmCoreSegment()` 保留为可测试的 idempotent prompt producer，但 extension 入口始终注册 canonical prompt hook；不要重新引入 integrated-consumer bypass。

### Behavior-owned modules

| 路径 | 责任 |
|---|---|
| `src/checkpoint-tool.ts` | checkpoint schema、target resolution、placement evidence |
| `src/timeline-tool.ts` | strict single-view timeline、tree rendering、HUD 与 diagnostics |
| `src/travel-tool.ts` | handoff validation、travel evidence、sync scheduling |
| `src/handoff.ts` | structured handoff schema、validation、runtime facts composition 与 canonical durable text |
| `src/context-packet.ts` | LLM-bound packet reconstruction、tool protocol normalization 与 provenance-bound ACM continuation authority projection |
| `src/travel-coordinator.ts` | 单次 backup → branch → verify → compensate transaction |
| `src/host-bridge.ts` | readonly SessionManager 到公开 mutation/build capability 的唯一 guarded seam |
| `src/runtime.ts` | 按 SessionManager 隔离 usage、refresh、tool-call correlation、context nudge 与 live sync state |
| `src/runtime-lifecycle.ts` | context rebuild、hidden nudge delivery、tool end sync、usage、compaction、manual tree navigation、session cleanup |
| `src/context-usage-nudge.ts` | 30/50/70 档位分类与分级 ACM reminder 文案 |
| `src/live-agent-session-adapter.ts` | capability-probed live AgentSession association 与 message replacement |
| `src/lib.ts` / `label-journal.ts` / `entry-resolution.ts` / `tool-protocol.ts` | 可测试的 domain logic |
| `src/generated-guidance.ts` | 从 canonical guidance 派生的 runtime strings |
| `src/prompt-registration.ts` | idempotent ACM CORE prompt segment |

`src/context.ts` 和 `src/utils.ts` 属于 `/context` TUI，不应吸收 ACM tree mutation 或 live synchronization 逻辑。

## Host Bridge

`ctx.sessionManager` 的扩展类型是 readonly view，但 Pi `0.80.7` 的运行时对象公开 `appendLabelChange()` 和 `branchWithSummary()`。`buildSessionContext()` 则是 `@earendil-works/pi-coding-agent` 的公开 package export，不是 SessionManager 方法。

所有 guarded SessionManager capability access 必须集中在 `src/host-bridge.ts`；同一模块也封装 package-level `buildSessionContext()`，供 lifecycle 与 live-sync 路径复用。调用 mutation 前检查能力，调用后观察 journal/leaf/summary，不只相信 host 返回 ID。mutation outcome 明确区分 `applied`、`not_applied`、`indeterminate`。

Host Bridge 不保存跨操作的全局 rollback registry。backup rollback proof 只存在于一次 travel transaction 的 `LabelRollbackToken` 中。

## Checkpoint contract

- 默认 target 是 active branch 上最近的有意义 USER/AI message
- 跳过 tool result、system/custom、空 message、internal-tool-only assistant turn 等 transient entries
- 显式 node ID 可以指向任意 entry，但非 USER/AI target 会产生 warning
- alias 在整棵树内大小写敏感且唯一；同一 entry 可拥有多个 alias
- alias index 由全部 label journal entries 重放，不依赖 host 的单一 latest label view
- `target: "root"` 指第一个 top-level entry；多根时提示使用明确 checkpoint 或 node ID

不要用 `pi.setLabel()` 替代 journal mutation；它不提供本项目所需的显式 target + 多 alias replay contract。

## Timeline contract

`acm_timeline` 使用 strict `view` discriminator：

- `{ view: "active", limit?, verbose? }`
- `{ view: "checkpoints", limit?, filter? }`
- `{ view: "search", limit?, query }`
- `{ view: "tree", limit? }`

省略 `view` 等价于 `active`。旧参数 `list_checkpoints`、`full_tree`、`search` 以及竞争 boolean 组合不得重新引入。

默认 active 视图只展示 LLM 实际看到的 spine；off-path summary/compaction 以分支脚注呈现，不能伪装成线性历史。checkpoint view 按 target entry 聚合 aliases，`limit` 约束 entry 数量；每个 entry 只命名一个相关 alias 并报告其余 alias 数，filter/search 仍索引全部 aliases。search 在整棵树上做大小写不敏感匹配。

HUD 包含 official/cached usage、active node count、active summary depth、off-path summary count、nearest checkpoint distance、context refresh 与 live AgentSession sync diagnostics。

checkpoint view 额外显示 `root` structural candidate 和每个候选 travel 后的 projected summary depth。这些都是 topology evidence，不是 rebase safety verdict；语义完整性只能由 agent 的 cold-start 检查判断。

## Travel transaction

`acm_travel` 的顺序：

1. 解析 target，验证 structured handoff 的 `goal/state/evidence/external/exclusions/recover/next`，并生成唯一 canonical durable text；nested object 是首选 wire shape，provider 将该对象整体 JSON 序列化时允许精确 JSON fallback，但不接受自由文本 summary；rebase snapshot 还必须满足 cold start
2. prevalidate branch 与可选 backup alias
3. coordinator 追加 backup label，并持有 operation-scoped rollback token
4. 调用 `branchWithSummary(..., true)`
5. 验证真实 leaf、entry type、parent 与 summary
6. 明确未应用时补偿 backup；已应用或无法排除 mutation 时保留恢复证据
7. 只在 branch 明确成功时 schedule persistent context refresh 与 live AgentSession sync

travel 只改变 Pi session tree 和模型 context，不回滚文件、进程、浏览器、远端服务或其他外部副作用。

结果报告 raw evidence：usage before/estimated after、token delta、percentage-point delta、message counts/direction、summary-depth before/after/delta、summary entry、backup、refresh 与 live sync state。不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict。

## Semantic rebase 与 rehydrate

rebase 与 rehydrate 都是 agent 对现有 `acm_travel` 的高阶使用，不是新工具或 runtime mode。rebase 把所有 surviving state 合并成一个 authoritative handoff 并移动到**最早安全基底**；rehydrate 通过 save point + off-path travel + 返回 travel 取回单个归档细节。

- summary 堆叠或互相竞争时值得做 rebase check；这是 recognition cue，不是 required transition
- 候选从 earliest 到 latest 评估；`root` 是候选但不是默认 target
- cold start 是硬门槛：fresh agent 必须能只凭新 handoff 与 direct evidence pointers 执行 `NEXT`
- context pressure 不得降低 handoff 完整性要求
- native `compaction` 不计入 semantic summary depth；只有 `branch_summary` 计入
- runtime 只报告 summary depth、projected depth 和 deltas，不自动判断或执行 rebase
- runtime 不以 checkpoint 后缀、固定阶段名或固定调用顺序推断语义状态；cue 选择不得依赖名称后缀

## Context usage nudge contract

ACM context nudge 使用 Pi 公开的 hidden custom message channel，不修改工具结果：

- 每次 `context` event 根据 `ctx.getContextUsage()` 观察 active tokens、hard context window 与 hard usage；
- reminder 档位依据 `workingBudgetTokens = min(contextWindow, 400_000)` 和 `pressurePercent = tokens / workingBudgetTokens * 100` 分类；400K 及以下使用实际窗口，超过 400K 使用 400K cap；
- `usagePercent` 始终表示 hard-window usage，不得静默改为 working-budget pressure；message details、baseline state 与 timeline dashboard 分别暴露 `pressurePercent`、`workingBudgetTokens` 和 `policy`；
- 进入更高档位时只保留一个 pending reminder，档位固定为 30% / 50% / 70%；
- `tool_result` 消费 pending 并通过 `pi.sendMessage(..., { deliverAs: "steer" })` 发送；
- 若本次 run 没有后续 tool boundary，只在正常 `agent_end`（最后 assistant `stopReason === "stop"`）通过 `followUp` 兜底；
- custom message 使用 `display: false`，对 agent 可见但不在 Pi TUI 中展示，并明确标注为 ACM 自动提醒、不是用户请求；
- 普通 usage 回落不降低本周期 highest reached level；一次跳档只发送当前最高档；
- 明确成功的 `acm_travel`、`session_compact` 与手动 `/tree` 导航（`session_tree`）开启新周期；失败或 indeterminate travel 不重置；
- transition 后忽略可能仍然陈旧的即时 usage，以第一条真实 post-transition assistant prompt usage 建立无提醒 baseline；但明确成功的 `acm_travel` 会用 travel 结果验证过的落点估值 seed 新周期的 highest reached level（落点及以下档位保持静默），第一条真实 usage 只负责清除 pending 并持久化 baseline entry（记录真实 tokens 与 seeded 档位）——同 turn 回爬不得吞掉落点以上、本周期从未提醒过的档位；compaction 与手动 `/tree` 无落点估值，保持采样建立；
- reminder 只提高 ACM Judgment 的显著性，不把 pressure 转换成 summary/travel/rebase 许可；低 active context 是偏好，不得压过正确性、任务连续性、Representation Gain、cold start 与 recoverability。

## Persistent context rebuild

successful travel 后，`ContextRefreshRegistry` 按 SessionManager identity 记录 pending refresh。每次 `context` event：

1. 通过 `rebuildAcmContextPacket()` 从 active branch entries 重建 messages
2. 运行统一 tool-protocol analysis，并在原消息位置把 marker 与 persisted ACM travel provenance 同时匹配的 branch summary 投影为 authoritative hidden continuation；legacy/native/foreign summary 保持 archival
3. 成功后标记 rebuilt
4. 失败最多跨 turn 重试 3 次，并提供 actionable recovery guidance

`session_start` 会清理易失 runtime state，再扫描 active branch 上最近一个 cycle boundary（任意 `branch_summary` 或 native `compaction`——travel、手动 `/tree` summarize 与其他扩展的 fold 在 live 路径上都重置周期，restore 必须与之对齐）之后的记录：`acm:context-usage-state` custom entry 记录第一条真实 post-transition usage 已建立的 baseline 及当时最高档位，`acm:context-usage-reminder` custom message 记录后续已发送档位。baseline entry 通过 `pi.appendEntry()` 持久化且不进入 LLM context；两类记录共同恢复当前周期的 `baselinePending` 与 highest reached level。`session_shutdown` 只清理对应 SessionManager。`session_compact` 清理 host/runtime state 后立即开启一个等待真实 post-compaction usage baseline 的新提醒周期。

## Manual tree navigation

手动 `/tree` 导航绕过 `acm_travel`，host 自己重建 live messages，因此 `session_tree` handler 必须清空该 SessionManager 的易失 runtime state（refresh target、live sync ticket、cached usage、nudge state）并开启 baseline-only 提醒周期。

`session_before_tree` handler 在用户选择 plain "Summarize"（`userWantsSummary === true` 且无非空 `customInstructions`、`entriesToSummarize` 非空）时，以 `replaceInstructions: true` 注入 `TREE_SUMMARY_INSTRUCTIONS`，让 native branch summary 也生成七槽 handoff 形态；`buildTreeSummaryInstructions()` 会附加 abandoned branch tip 的 node ID 作为 Recover pointer 事实（summarizer 看不到 node ID）。用户提供的 instructions 永远优先；handler 不设置 `cancel`、`summary` 或 `label`，不做其他干预。

## Live AgentSession synchronization

Pi extension tool context没有 command-only `navigateTree()`，因此 `acm_travel` 不能直接复用 Pi 的��生 tree navigation。当前运行时若暴露可观察的 `AgentSession` lifecycle seam 与可替换的 `agent.state.messages`，则可在 travel 后同步 native stored context。

`src/live-agent-session-adapter.ts` 的约束：

- 只按实际 runtime capability 决定可用性；不读取、不显示、不比较宿主版本
- 在可包装的 `AgentSession.getContextUsage()` lifecycle seam 捕获 AgentSession ↔ SessionManager association；探测不得改变原方法行为
- 按 SessionManager object identity 索引；不使用 working directory、model、session path 或 global current-session
- 只保存 WeakMap/WeakRef，允许 session GC
- 安装 marker 是 process-wide 且幂等；重复 extension registration/reload 只包装一次，original method 每次调用恰好一次
- travel tool body 只 schedule；shared adapter 原子保存完整 `{ toolCallId, preferredLeafId }` ticket，只有匹配的 `tool_execution_end` 才 apply replacement
- replacement messages 必须通过 Context Packet 从 resulting active branch 重建，不能裁剪 pre-travel AgentSession array；marked ACM handoff 必须在原时间位置保持 authority，不得追加到 packet 末尾压过后续用户消息
- 后续 travel 仅覆盖同一 manager 的旧 pending ticket；不匹配的 tool end 不得消费 pending 或覆盖诊断
- unavailable/failed live sync 不回滚已验证的 travel；persistent context rebuild 继续生效，并提示 reload

公开 outcome：`unavailable`、`pending`、`applied`、`failed`、`skipped`。

如果未来 Pi 提供 tool-context 可调用的官方 atomic navigation/refresh interface，应删除这个 capability-probed adapter，改用官方接口；不要扩展成通用 private-access framework。

## Guidance ownership

- `docs/acm-judgment-contract.md`：ACM 判断语义与度的 canonical source
- `skills/context-management/CORE.md`：Judgment Contract 面向模型的 always-on projection，只含 `ACM:CORE` 标记段；修改必须可追溯到 contract
- `skills/context-management/TOOL-CONTRACTS.md`：术（tool mechanics text）的 canonical source——tool descriptions、prompt snippets、prompt guidelines、result cues、manual navigation summary instructions、recovery 文案
- `skills/context-management/SKILL.md`：advanced-only router
- `skills/context-management/references/`：target selection、archive recovery、exceptional recovery
- `src/generated-guidance.ts`：由 `bun run generate:guidance` 从 CORE projection 与 TOOL-CONTRACTS 生成的 runtime artifact，不应手工漂移

canonical 词汇固定为 working set、save point、handoff、hot set、cold start、fold、rebase、rehydrate、fork、sediment、thrash、anchor gravity、receipt。checkpoint 创建 recoverability；travel 执行 fold/rebase/rehydrate；三者都复用同一 travel mutation contract。不得重新引入 mandatory preflight、transition 表或后缀驱动的状态机。

## Tool prompt 与 TUI 呈现

三个 ACM 工具都必须显式提供 `promptSnippet`、以工具名开头的 `promptGuidelines`、`renderShell: "self"`、`renderCall` 和 `renderResult`；prompt metadata 全部来自 generated guidance（`PROMPT_SNIPPETS` / `PROMPT_GUIDELINES`），只保留每个工具最关键的触发/安全门，不复制完整 CORE。

self-shell 默认视图应紧凑展示调用意图和可判定 evidence；`expanded` 视图保留完整 raw tool result。renderer 只读取既有参数、`content` 与 `details`，不得改变发送给 LLM 的工具结果或 mutation contract；错误/indeterminate 结果不得套用成功样式。
所有来自 streaming 参数、host details 或 tool content 的动态文本，在进入自定义 `Text` renderer 前必须经过 `sanitizeTerminalText()`；保留换行和制表符，但不得把 C0/C1 终端控制字符带入 self-shell。

## 测试与验证

依赖与 runner 契约：

- 根目录提交 npm `package-lock.json`，因为 Pi 的 git package 安装会执行 `npm install --omit=dev`；不要删除或用未提交的 root `bun.lock` 取代它。
- 开发与测试使用 Bun。CI 固定 Node `24.16.0`、npm `11.13.0`、Bun `1.3.14`；`package.json` 的 Node 下限跟随 Pi `0.80.7` 的 `>=22.19.0` 契约。
- `bunfig.toml` 从根 `bun test` discovery 中排除 `test/host-fixture/**`。host fixture 必须通过自己的 frozen `bun.lock`、source build 和显式测试列表独立运行。
- 修改 `package.json` 后必须重新生成并提交 `package-lock.json`，并从 committed tree 验证一次 clean `npm ci --ignore-scripts`。

Focused：

```bash
bun test
bun run test:guidance
bun run typecheck
cd test/host-fixture
bun ./build-source.mjs
bun test ./<focused>.test.ts
```

完整 gate：

```bash
npm ci --ignore-scripts
bun run verify:acm
```

`verify:acm` 必须覆盖 generated-guidance check、全部 root tests、production TypeScript typecheck，以及 host fixture。不得退回只跑 guidance tests 的不完整 gate。

host fixture 必须覆盖 exact Pi version、canonical CORE prompt injection（`before_agent_start` 幂等注入与 generated prompt metadata 注册）、manual tree navigation（`session_before_tree` instructions merge 与 `session_tree` 周期重置）、`/context` 的 exact `ExtensionRunner` 注册与 `pi-tui` 渲染、adapter capability/installation、successful shrinking travel、in-flight tool pair、provider context、native compaction accounting、failure fallback、repeated travel、off-path restore、resume、lifecycle cleanup、multi-session/subagent isolation。

不要使用 `console.log`；用户可见 warning 使用 `ctx.ui.notify()`。
