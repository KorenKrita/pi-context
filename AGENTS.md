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
- `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 的 peer/dev dependency 均精确固定为 **`0.81.1`**
- `test/host-fixture/` 也精确安装 Pi `0.81.1`，用于验证真实 host contract

不要把开发依赖与 host fixture 的精确版本改成 caret/tilde range。Live Agent Sync 不读取、报告或按宿主版本分支；它只探测当前运行时实际使用的能力，缺失或失败时保留 persistent rebuild/reload fallback。successful travel 的 replacement boundary 必须是 `agent_settled`，不是 matching `tool_execution_end` 或 `agent_end`。

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
| `src/travel-tool.ts` | handoff validation、travel evidence、settled-boundary refresh/sync scheduling |
| `src/handoff.ts` | structured handoff schema、validation、runtime facts composition 与 canonical durable text |
| `src/context-packet.ts` | LLM-bound packet reconstruction、tool protocol normalization 与 provenance-bound ACM continuation authority projection |
| `src/travel-target-facts.ts` | mutation 前的 target protocol/topology facts 与 warning classification；只把 invalid identity 作为固定 hard floor |
| `src/travel-coordinator.ts` | 单次 backup → branch → verify → compensate transaction |
| `src/host-bridge.ts` | readonly SessionManager 到公开 mutation/build capability 的唯一 guarded seam |
| `src/runtime.ts` | 按 SessionManager 隔离 usage、refresh、tool-call correlation、context nudge 与 settled sync state |
| `src/runtime-lifecycle.ts` | context rebuild、hidden nudge delivery、tool end/settled sync、usage、compaction、manual tree navigation、session cleanup |
| `src/context-usage-nudge.ts` | 30/50/70 档位分类与分级 ACM reminder 文案 |
| `src/live-agent-session-adapter.ts` | capability-probed live AgentSession association 与 settled-boundary message replacement |
| `src/lib.ts` / `label-journal.ts` / `entry-resolution.ts` / `tool-protocol.ts` | 可测试的 domain logic |
| `src/generated-guidance.ts` | 从 canonical guidance 派生的 runtime strings |
| `src/prompt-registration.ts` | idempotent ACM CORE prompt segment |

`src/context.ts` 和 `src/utils.ts` 属于 `/context` TUI，不应吸收 ACM tree mutation 或 live synchronization 逻辑。

## Host Bridge

`ctx.sessionManager` 的扩展类型是 readonly view，但 Pi `0.81.1` 的运行时对象公开 `appendLabelChange()` 和 `branchWithSummary()`。`buildSessionContext()` 则是 `@earendil-works/pi-coding-agent` 的公开 package export，不是 SessionManager 方法。

所有 guarded SessionManager capability access 必须集中在 `src/host-bridge.ts`；同一模块也封装 package-level `buildSessionContext()`，供 lifecycle 的 persistent rebuild、live adapter 与 preview 复用。调用 mutation 前检查能力，调用后观察 journal/leaf/summary，不只相信 host 返回 ID。mutation outcome 明确区分 `applied`、`not_applied`、`indeterminate`。

Host Bridge 不保存跨操作的全局 rollback registry。backup rollback proof 只存在于一次 travel transaction 的 `LabelRollbackToken` 中。

## Checkpoint contract

- 默认 target 是当前 `acm_checkpoint` assistant batch 之前最新的 protocol-complete active-branch leaf；它通常是已完成的 `toolResult`，也可以是其他能原样重建 provider packet 的 session entry
- checkpoint 名称表达语义状态，物理 anchor 表达可恢复边界；不得为了把标签放在 USER/AI 节点而丢弃已完成 tool results 或在恢复时合成 `[Interrupted by context travel]`
- 若紧邻 prefix 需要普通 protocol repair，向前寻找更早的 protocol-complete leaf；找不到时不写 label，并返回 repairs/defects evidence
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

HUD 包含 official/cached usage、active node count、active summary depth、off-path summary count、nearest checkpoint distance、context refresh 与 settled-boundary live AgentSession sync diagnostics。

checkpoint view 额外显示 `root` structural candidate、每个候选 travel 后的 projected summary depth，并只把 trusted ACM summary + unique finalized applied receipt transaction 中的 `backupCurrentHeadAs` alias 标为 `[raw archive]`；foreign/native/marker-like details 不得获得该类型。Raw archive alias 指向 pre-travel 原始路径，通常用于 restore/rehydrate 且可能扩大 context，不得把它当 fold/rebase base；后两者仍应选择 sediment 之前的 clean ancestor。同一 entry 有多个 alias 时，任一 raw alias 都必须在 active/search/tree/checkpoints 保留节点级 raw marker，search 优先显示实际命中的 alias。这些都是 topology evidence，不是 rebase safety verdict；语义完整性只能由 agent 的 cold-start 检查判断。Schema 不拒绝大的 caller limit，但每次调用使用 context-window-derived entry + character budgets 约束 rebuild/output work，动态 alias/query 在呈现层截断且 node ID 放在前面，details 返回 requested/effective limits、entry/character budget 与 truncation evidence；需要更多结果时用 filter/query 缩小，而不是一次展开整棵大 session。

## Travel transaction

`acm_travel` 的顺序：

1. 解析 target，验证 structured handoff 的 `goal/state/evidence/external/exclusions/recover/next`，并生成唯一 canonical durable text；nested object 是首选 wire shape，provider 将该对象整体 JSON 序列化时允许精确 JSON fallback，但不接受自由文本 summary；同时构造独立 target facts（protocol status/repairs/defects、surviving open user、assistant tool batch、branch summary、off-path）；`invalid` target packet 在 mutation 前硬拒绝，其他 hazards 只作为结构 warning，rebase snapshot 仍由 agent 做 cold start
2. prevalidate branch 与可选 backup alias
3. coordinator 追加 backup label，并持有 operation-scoped rollback token
4. 调用 `branchWithSummary(..., true)`
5. 验证真实 leaf、entry type、parent 与 summary
6. 明确未应用时补偿 backup；已应用或无法排除 mutation 时保留恢复证据
7. branch 明确成功时 schedule persistent context refresh 与 per-SessionManager live AgentSession sync ticket；matching `tool_execution_end` 只关联 receipt，不得切换 provider 或替换 native messages。`tool_result` interception 仍可被后置 extension 改写，也不授权切换；下一次 `context` 只认 event messages 或 persisted branch 中 matching、non-error、`mutationStatus: applied` 的 finalized `toolResult`，随后立即从 latest active leaf 交付 protocol-valid Context Packet。finalized error 或 untrusted receipt 必须取消 provider cutover 与尚未应用的 native replacement ticket；finalized receipt 缺失或暂时不可读取时，两张 ticket 均保持 pending。Context Packet 是唯一 NEXT authority，正常 cutover 不另发 steer。originating assistant run 与其 automatic retry/tool loop 始终保留当前 native messages；仅 `agent_settled` 才把 native AgentSession replacement 应用到最新 verified active leaf。`agent_end`（尤其 provider error）不是 release/apply signal。`indeterminate` mutation只 schedule persistent observation refresh，不创建 settled ticket、不宣称 travel 成功，也不重置 reminder cycle；明确失败或 `not_applied` 两者都不 schedule

Travel tool batch 之前若 latest user turn 尚无 visible assistant response，runtime 记录 `currentUserTurnOpen: true` 作为结构事实并持久化到 summary details。Context Packet 与 success receipt 必须明确：该 user turn 仍欠 visible delivery，State 不是交付，等待下一请求的 NEXT 不足以完成本轮。Runtime 不推断答案内容；已有 visible response 时该 flag 为 false。

travel 只改变 Pi session tree 和模型 context，不回滚文件、进程、浏览器、远端服务或其他外部副作用。

结果报告 raw evidence：usage before/estimated after、token delta、percentage-point delta、message counts/direction、summary-depth before/after/delta、summary entry、backup、persistent refresh 与 settled-boundary live sync state。不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict。

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

ACM context nudge 分双通道：完整档位提醒走 Pi 公开的 hidden custom message channel；一行式结构 cue（仪表/burst）以定界后缀追加到普通工具结果文本，`acm_*` 工具结果与 error 结果永不装饰：

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
- **reminder 正文是事实，不是分档论证**：三档共用同一段文本（档位穿越 + 数字 + 一句「这是事实，不是 move 许可」），不再按 30/50/70 递进劝导，70 档也不再标注 `Final reminder`。分档散文曾使 nudge 成为与 CORE 竞争的第四个 guidance owner，并重新引入 FM-08 的动作梯度（压力升高被读成 travel 许可升高）；仪表后缀上线后，分档散文的边际信息量为零，只剩梯度。判断语义只属于 CORE，本通道只负责让弱模型也能结构化地拿到压力事实。

### 确定性打断器（syntax-only triggers）

`src/acm-trigger-detector.ts` 为 nudge 系统提供纯句法打断器；host 只递结构事实与候选（判断题形态），语义裁决永远留给模型；检测器是烟雾报警器——高召回低精度，误报成本由模型判断兜住，不引入外源判定模型：

- **压力仪表**：pressure ≥30% 且距本周期上次发射 ≥8pp 时，在当前工具结果尾部追加一行 `[ctx: N% · ↑Δpp · next tier in Mpp]`；<30% 完全沉默（巡航保护）；基准随发射移动（按变化发，不按状态发），周期边界重置；provider-active 时 pressure 来自实际 provider usage，与档位提醒同一 authority 顺序；
- **read burst**：连续 ≥8 次读取类工具（`read`/`grep`/`find`/`glob`/`ls`）在阈值穿越那条结果上就地追加判断题后缀（含最近 save point 名称与距离，lookup 失败降级为纯 burst 事实）；每 run 至多一发；非读取工具与 ACM 工具打断连读计数；tool_result patch 只能装饰当前正在定稿的结果，「burst 结束后补注入」物理不可行，由跨档提醒与模型自发覆盖；
- **run 边界 cue**（新请求/阶段收尾共享一个信号）：run 内工具完成数 ≥8 且无新 save point 时，`before_agent_start`（新请求压旧任务）或正常 `agent_end`（阶段收尾，pending tier reminder 优先）注入一行 hidden 判断题（`display: false`，`customType: "acm:trigger-cue"`）；**每周期至多一发**：触发即哑火，仅真实 save-point 行动（`acm_checkpoint`/`acm_travel` 完成）或周期边界重新武装——提醒是提醒，不是闹钟贪睡；
- **仲裁**：同一条工具结果上 tier reminder > burst > gauge，至多一个后缀；tier reminder 发射时该结果不再装饰；
- 后缀会永久留在持久化工具结果中（定稿后不再变，不破坏 prompt cache），这是「为激活付出少量永久 token」的已知交换；
- 阈值（8 次 / 8pp / run 活动 8）是 assay 待测变量，不是定论；调参只动 `acm-trigger-detector.ts` 顶部常量，不动骨架；
- **配对实验 kill switch**：`ACM_TRIGGERS_DISABLED=1` 时三个打断器表面（gauge/burst/run 边界 cue）在 runtime 消费点全部静默，构成配对回放的对照臂；档位提醒（30/50/70）属于触发器之前的 baseline 契约，不受该开关影响。开关按调用时读取环境，不缓存。

## Post-mutation persistent observation 与 settled live sync

明确成功的 travel 后，`ContextRefreshRegistry` 按 SessionManager identity 记录 pending refresh，同时 live adapter 记录同一 manager 的 pending ticket。provider delivery 与 native replacement 分离：finalized receipt 后的首个 `context` 立即交付 persisted Context Packet，native array 仍等待 idle `agent_settled`；finalized error receipt 取消两张 ticket 并进入可观察的 `receipt_rejected`。provider-active 期间每次 context 从 latest leaf rebuild；成功 packet 同时保存 source cursor。临时失败只在 source/cached prefix 可验证时合并 post-cutover tail，否则降级为当前 protocol-valid fallback，不能继续把旧 cache 称为 active。persistent rebuild 最多三次，之后保留 cache 为 `cached_exhausted` 并停止自动读取/warning，直到新 travel、lifecycle reset 或 reload；cached-exhausted 仍交付已验证 packet，因此实际 provider `turn_end` usage 继续更新 reminder/HUD。每次 travel 先清除上一 provider epoch 的 cached usage；provider-active reminder pressure 只使用实际 provider `turn_end` usage，native `ctx.getContextUsage()` 仅作 estimate。`indeterminate` mutation 只记录 pending observation refresh；明确失败或 `not_applied` 不登记。只有 `agent_settled` 才从最新 verified active leaf 应用 native AgentSession replacement；`agent_end` error/aborted 不解锁该路径。persistent rebuild 对 success refresh 或 indeterminate observation 按以下步骤验证或恢复 Context Packet：

1. 通过 `rebuildAcmContextPacket()` 从 active branch entries 重建 messages
2. 运行统一 tool-protocol analysis，并在原消息位置把 marker 与 persisted ACM travel provenance 同时匹配的 branch summary 投影为 authoritative hidden continuation；legacy/native/foreign summary 保持 archival。只有 packet 中存在唯一完整 message match、与该 trusted summary 的 entry/target/origin/必需 toolCall provenance 精确匹配、且 finalized details 明确为 non-error、无 domain error、`mutationStatus: applied` 的孤立 ACM receipt 才作为安全 normalization 移除；同 ID foreign/identical duplicate、untrusted receipt 与任何普通 repair 仍保持 repaired/invalid evidence
3. 成功后标记 rebuilt
4. 失败最多跨 turn 重试 3 次，并提供 actionable recovery guidance

adapter unavailable/failed 不回滚已验证 travel，persistent rebuild 仍最多跨后续 turn 重试 3 次并给出 actionable recovery guidance。`session_start` 会清理易失 runtime state，再扫描 active branch 上最近一个 cycle boundary（任意 `branch_summary` 或 native `compaction`——travel、手动 `/tree` summarize 与其他扩展的 fold 在 live 路径上都重置周期，restore 必须与之对齐）之后的记录：`acm:context-usage-state` custom entry 记录第一条真实 post-transition usage 已建立的 baseline 及当时最高档位，`acm:context-usage-reminder` custom message 记录后续已发送档位。baseline entry 通过 `pi.appendEntry()` 持久化且不进入 LLM context；两类记录共同恢复当前周期的 `baselinePending` 与 highest reached level。`session_shutdown` 只清理对应 SessionManager。`session_compact` 清理 host/runtime state 后立即开启一个等待真实 post-compaction usage baseline 的新提醒周期。

## Manual tree navigation

手动 `/tree` 导航绕过 `acm_travel`，host 自己重建 live messages，因此 `session_tree` handler 必须清空该 SessionManager 的易失 runtime state（refresh target、live sync ticket、cached usage、nudge state）并开启 baseline-only 提醒周期。

`session_before_tree` handler 在用户选择 plain "Summarize"（`userWantsSummary === true` 且无非空 `customInstructions`、`entriesToSummarize` 非空）时，以 `replaceInstructions: true` 注入 `TREE_SUMMARY_INSTRUCTIONS`，让 native branch summary 也生成七槽 handoff 形态；`buildTreeSummaryInstructions()` 会附加 abandoned branch tip 的 node ID 作为 Recover pointer 事实（summarizer 看不到 node ID）。用户提供的 instructions 永远优先；handler 不设置 `cancel`、`summary` 或 `label`，不做其他干预。

## Live AgentSession synchronization

Pi extension tool context没有 command-only `navigateTree()`，因此 `acm_travel` 不能直接复用 Pi 的原生 tree navigation。runtime 仅在可观察的 `AgentSession` lifecycle seam 与可替换 `agent.state.messages` 都存在时启用 adapter；adapter 只负责两类明确的 live-state 操作：在 settled boundary 将 latest verified active leaf 的 Context Packet 写入 native live state，以及在 host 已判定 overflow recovery `willRetry`、且 await `session_compact` 的窄窗口中移除不可续写的 trailing assistant messages。

`src/live-agent-session-adapter.ts` 的约束：

- 只按实际 runtime capability 决定可用性；不读取、不显示、不比较宿主版本；
- 在可包装的 `AgentSession.getContextUsage()` lifecycle seam 捕获 AgentSession ↔ SessionManager association；探测不得改变原方法行为；
- 按 SessionManager object identity 索引；不使用 working directory、model、session path 或 global current-session；
- 只保存 WeakMap/WeakRef，允许 session GC；安装 marker process-wide 且幂等；
- travel 先 schedule 完整 `{ toolCallId, preferredLeafId }` ticket；matching `tool_execution_end` 只确认 pair，不 apply replacement；
- `agent_settled` 是 travel replacement 的唯一 apply boundary：它从**最新** verified active leaf rebuild，不能裁剪 pre-travel AgentSession array，也不能在 originating run 或 automatic retry 中提前替换；`agent_end` error/aborted 不是替换许可；
- 唯一例外是 host 自己已决定 automatic overflow retry 且 await `session_compact` 的边界：adapter 可只从 live array 尾部移除 `role === "assistant"` 的不可续写消息，session history 保持不变。Pi `0.81.1` 的 host 只移除 `stopReason === "error"`，但其 silent-overflow 判定也会产生 `stopReason === "length"`、output 0；不修复会让 `agentLoopContinue` 抛 `Cannot continue from message role: assistant`；
- 后续 travel 仅覆盖同一 manager 的旧 pending ticket；不匹配 completion 不得消费 pending 或覆盖诊断；
- unavailable/failed live sync 不回滚已验证 travel；persistent context rebuild 继续生效，并提示 reload。

同步公开 outcome：`unavailable`、`pending`、`applied`、`failed`、`skipped`；overflow-retry 尾部修复另行返回 `pruned`、`noop` 或 `unavailable`，只供 lifecycle handler 记录/降级。若未来 Pi 提供 tool-context 可调用的官方 atomic navigation/refresh interface 或修复 automatic overflow retry，应删除对应 capability-probed replacement/repair，而不是维护双路径；不要扩展成通用 private-access framework。

## Guidance ownership

- `docs/acm-judgment-contract.md`：ACM 判断语义与度的 canonical source
- `skills/context-management/CORE.md`：Judgment Contract 面向模型的 always-on projection，只含 `ACM:CORE` 标记段；修改必须可追溯到 contract
- `skills/context-management/TOOL-CONTRACTS.md`：术（tool mechanics text）的 canonical source——tool descriptions、prompt snippets、prompt guidelines、result cues、manual navigation summary instructions、recovery 文案
- `skills/context-management/SKILL.md`：advanced-only router
- `skills/context-management/references/`：target selection、archive recovery、exceptional recovery
- `src/generated-guidance.ts`：由 `bun run generate:guidance` 从 CORE projection 与 TOOL-CONTRACTS 生成的 runtime artifact，不应手工漂移

Exact advanced pointers 必须经过 Pi `getCommands()` availability selector：只有当前 session 实际提供 `skill:context-management` 时，timeline/rebase、name collision、rollback/indeterminate/refresh-exhausted 等 observable condition 才追加对应 reference pointer；不可用时只返回 base recovery facts，不向模型暴露不存在的 Skill/path 并要求它自行搜索。

canonical 词汇固定为 working set、save point、handoff、hot set、cold start、fold、rebase、rehydrate、fork、sediment、thrash、receipt。这些词都借用模型已有先验；不要新造没有预训练先验的术语（旧词 anchor gravity 已因此删除，target 选择直接用白话表述）。checkpoint 创建 recoverability；travel 执行 fold/rebase/rehydrate；三者都复用同一 travel mutation contract。不得重新引入 mandatory preflight、transition 表或后缀驱动的状态机。

### 强弱模型分层

Judgment Contract 的模型期望分两层，guidance 文本按强模型写，弱模型靠结构保底：

- **道（CORE）按强模型写**：判断过程、move 组合与 cadence 留给模型自主发挥；不为弱模型在 CORE 里增加步骤化规则、阈值或固定流程。给强模型的文本以判断语义为主，反例只留行为层面的（如 results-only report），不列举流程错误。
- **弱模型的 floor 靠结构，不靠更多散文**：schema 约束（minLength、pattern、additionalProperties、七槽必填）、result cues（就地、就时的下一步提示）、context nudge（分档提醒）与 runtime 的机械安全（rollback、evidence、indeterminate 区分）共同构成弱模型能稳定完成正收益 move 的保底。弱模型理解不了的东西，加更多 CORE 散文也没用；若发现 floor 不足，优先加强结构面（schema/cue/nudge/runtime 拦截），不加长教义。
- **层间不串到对方的家**：道的修改必须可追溯到 judgment contract；结构面的修改不引入新教义，只陈述机械事实与即时 affordance。

## Tool prompt 与 TUI 呈现

三个 ACM 工具都必须显式提供 `promptSnippet`、以工具名开头的 `promptGuidelines`、`renderShell: "self"`、`renderCall` 和 `renderResult`；prompt metadata 全部来自 generated guidance（`PROMPT_SNIPPETS` / `PROMPT_GUIDELINES`），只保留每个工具最关键的触发/安全门，不复制完整 CORE。

self-shell 默认视图应紧凑展示调用意图和可判定 evidence；`expanded` 视图保留完整 raw tool result。renderer 只读取既有参数、`content` 与 `details`，不得改变发送给 LLM 的工具结果或 mutation contract；错误/indeterminate 结果不得套用成功样式。
所有来自 streaming 参数、host details 或 tool content 的动态文本，在进入自定义 `Text` renderer 前必须经过 `sanitizeTerminalText()`；保留换行和制表符，但不得把 C0/C1 终端控制字符带入 self-shell。

## 测试与验证

依赖与 runner 契约：

- 根目录提交 npm `package-lock.json`，因为 Pi 的 git package 安装会执行 `npm install --omit=dev`；不要删除或用未提交的 root `bun.lock` 取代它。
- 开发与测试使用 Bun。CI 固定 Node `24.16.0`、npm `11.13.0`、Bun `1.3.14`；`package.json` 的 Node 下限跟随 Pi `0.81.1` 的 `>=22.19.0` 契约。
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

行为评测已退役（2026-07-27，用户决定）：跑真实模型的评测装置（showroom 样板间、longrun 配对、skeleton 骨架提取、cost model、评测安全件）已整体删除。理由：维护成本远超产出，迭代判据改为设计讨论与人工使用体感。完整装置与全部历史证据保留在 git tag `eval-archive`（commit 133ff9b6）；历史 evidence 是当时 checkout 的 receipt，其结论不自动外推到当前 guidance。

- 触发器阈值（burst、Δpp、武装阈值、哑火语义）的常量在 `src/acm-trigger-detector.ts` 顶部；调整需在 commit message 或 implementation-notes 中记录动机。

host fixture 必须覆盖 exact Pi version、canonical CORE prompt injection（`before_agent_start` 幂等注入与 generated prompt metadata 注册）、manual tree navigation（`session_before_tree` instructions merge 与 `session_tree` 周期重置）、`/context` 的 exact `ExtensionRunner` 注册与 `pi-tui` 渲染、adapter capability/installation、protocol-complete automatic checkpoint anchoring、successful shrinking travel、finalized receipt ordering（后置 handler 改 error 不 cutover、无重复 NEXT steer）、trusted applied receipt normalization、in-flight tool pair、originating-run 与 automatic-retry tool continuity、matching `tool_execution_end` 不 apply、provider-before-settled cutover、`agent_settled` 从 latest active leaf apply、`agent_end` error 不 release、persistent rebuild/cache cursor/fallback/cached exhaustion、provider actual usage authority、native compaction accounting、repeated travel with a new raw backup、off-path restore、resume、lifecycle cleanup、multi-session/subagent isolation。

不要使用 `console.log`；用户可见 warning 使用 `ctx.ui.notify()`。
