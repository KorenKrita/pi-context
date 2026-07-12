# AGENTS.md - pi-context 项目知识库

## 概述

**pi-context** 是 [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) 的 fork，由 KorenKrita 独立维护。它为 Pi agent 提供主动上下文管理能力：agent 可以创建 recoverable checkpoint、查看会话树，并通过 summary branch 折叠、恢复或 rebase 上下文。

项目暴露三个 ACM 工具：

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 给会话历史节点追加语义 checkpoint alias |
| `acm_timeline` | 输出 active path / checkpoints / search / tree 单一视图及 context HUD |
| `acm_travel` | 通过七槽 handoff 创建 summary continuation branch |

`src/context.ts` 另行注册 Pi 独有的 `/context` TUI 命令，与 ACM 工具职责分离。

## 技术栈与版本契约

- TypeScript ESM（`module: Node16`、`target: ES2022`、`strict: true`）
- Source-first：Pi 直接加载 `src/*.ts`，生产不依赖 `dist/`
- 工具参数 schema 使用 `@earendil-works/pi-ai` 的 TypeBox `Type.*`
- `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 的 peer/dev dependency 均精确固定为 **`0.80.6`**
- `test/host-fixture/` 也精确安装 Pi `0.80.6`，用于验证真实 host contract

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
| `src/travel-coordinator.ts` | 单次 backup → branch → verify → compensate transaction |
| `src/host-bridge.ts` | readonly SessionManager 到公开 mutation/build capability 的唯一 guarded seam |
| `src/runtime.ts` | 按 SessionManager 隔离 usage、refresh、tool-call correlation 与 live sync state |
| `src/runtime-lifecycle.ts` | context rebuild、tool end sync、usage、compaction、session cleanup |
| `src/live-agent-session-adapter.ts` | capability-probed live AgentSession association 与 message replacement |
| `src/lib.ts` / `label-journal.ts` / `entry-resolution.ts` / `message-sanitizer.ts` | 可测试的 domain logic |
| `src/generated-guidance.ts` | 从 canonical guidance 派生的 runtime strings |
| `src/prompt-registration.ts` | idempotent ACM CORE prompt segment |

`src/context.ts` 和 `src/utils.ts` 属于 `/context` TUI，不应吸收 ACM tree mutation 或 live synchronization 逻辑。

## Host Bridge

`ctx.sessionManager` 的扩展类型是 readonly view，但 Pi `0.80.6` 的运行时对象公开：

- `appendLabelChange()`
- `branchWithSummary()`
- `buildSessionContext()`

所有 guarded capability access 必须集中在 `src/host-bridge.ts`。调用前检查能力，调用后观察 journal/leaf/summary，不只相信 host 返回 ID。mutation outcome 明确区分 `applied`、`not_applied`、`indeterminate`。

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

默认 active 视图只展示 LLM 实际看到的 spine；off-path summary/compaction 以分支脚注呈现，不能伪装成线性历史。checkpoint view 按 alias 逐项列出，search 在整棵树上做大小写不敏感匹配。

HUD 包含 official/cached usage、active node count、active summary depth、off-path summary count、nearest checkpoint distance、context refresh 与 live AgentSession sync diagnostics。

checkpoint view 额外显示 `root` structural candidate 和每个候选 travel 后的 projected summary depth。这些都是 topology evidence，不是 rebase safety verdict；语义完整性只能由 agent 的 cold-start 检查判断。

## Travel transaction

`acm_travel` 的顺序：

1. 解析 target，验证七槽 handoff：`Goal/State/Evidence/External/Exclusions/Recover/NEXT`；rebase snapshot 还必须满足 cold start
2. prevalidate branch 与可选 backup alias
3. coordinator 追加 backup label，并持有 operation-scoped rollback token
4. 调用 `branchWithSummary(..., true)`
5. 验证真实 leaf、entry type、parent 与 summary
6. 明确未应用时补偿 backup；已应用或无法排除 mutation 时保留恢复证据
7. 只在 branch 明确成功时 schedule persistent context refresh 与 live AgentSession sync

travel 只改变 Pi session tree 和模型 context，不回滚文件、进程、浏览器、远端服务或其他外部副作用。

结果报告 raw evidence：usage before/estimated after、token delta、percentage-point delta、message counts/direction、summary-depth before/after/delta、summary entry、backup、refresh 与 live sync state。不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict。

## Semantic rebase

rebase 是 agent 对现有 `acm_travel` 的高阶使用，不是新工具或 runtime mode。目标是把所有 surviving state 合并成一个 authoritative snapshot，并移动到**最早安全基底**。

- 触发 rebase check：summary 已堆叠、稳定 chain/subchain 完成、新目标将开始、context pressure 上升
- 候选从 earliest 到 latest 评估；`root` 是理想候选但不是默认 target
- cold start 是硬门槛：fresh agent 必须能只凭新 handoff 与 direct evidence pointers 执行 `NEXT`
- context pressure 不得降低 snapshot 完整性要求
- native `compaction` 不计入 semantic summary depth；只有 `branch_summary` 计入
- runtime 只报告 summary depth、projected depth 和 deltas，不自动判断或执行 rebase

## Persistent context rebuild

successful travel 后，`ContextRefreshRegistry` 按 SessionManager identity 记录 pending refresh。每次 `context` event：

1. 通过 Host Bridge 的 `buildSessionContext()` 从 active branch 重建 messages
2. 运行 `fixOrphanedToolUse()`
3. 成功后标记 rebuilt
4. 失败最多跨 turn 重试 3 次，并提供 actionable recovery guidance

`session_start`、`session_shutdown`、`session_compact` 只清理对应 SessionManager 的 runtime state。

## Live AgentSession synchronization

Pi extension tool context没有 command-only `navigateTree()`，因此 `acm_travel` 不能直接复用 Pi 的��生 tree navigation。当前运行时若暴露可观察的 `AgentSession` lifecycle seam 与可替换的 `agent.state.messages`，则可在 travel 后同步 native stored context。

`src/live-agent-session-adapter.ts` 的约束：

- 只按实际 runtime capability 决定可用性；不读取、不显示、不比较宿主版本
- 在可包装的 `AgentSession.getContextUsage()` lifecycle seam 捕获 AgentSession ↔ SessionManager association；探测不得改变原方法行为
- 按 SessionManager object identity 索引；不使用 working directory、model、session path 或 global current-session
- 只保存 WeakMap/WeakRef，允许 session GC
- 安装 marker 是 process-wide 且幂等；重复 extension registration/reload 只包装一次，original method 每次调用恰好一次
- travel tool body 只 schedule；shared adapter 原子保存完整 `{ toolCallId, preferredLeafId }` ticket，只有匹配的 `tool_execution_end` 才 apply replacement
- replacement messages 必须从 resulting active branch 重建，不能裁剪 pre-travel AgentSession array
- 后续 travel 仅覆盖同一 manager 的旧 pending ticket；不匹配的 tool end 不得消费 pending 或覆盖诊断
- unavailable/failed live sync 不回滚已验证的 travel；persistent context rebuild 继续生效，并提示 reload

公开 outcome：`unavailable`、`pending`、`applied`、`failed`、`skipped`。

如果未来 Pi 提供 tool-context 可调用的官方 atomic navigation/refresh interface，应删除这个 capability-probed adapter，改用官方接口；不要扩展成通用 private-access framework。

## Guidance ownership

- `skills/context-management/CORE.md`：normal-path guidance 的 canonical source
- `skills/context-management/SKILL.md`：advanced-only router
- `skills/context-management/references/`：target selection、archive recovery、exceptional recovery
- `src/generated-guidance.ts`：generated runtime artifact，不应手工漂移

canonical 词汇固定为 working set、boundary、handoff、archive、chain、burst、rebase、cold start、anchor gravity。checkpoint 创建 recoverability；travel 才 fold boundary；rebase 仍复用 travel mutation contract。

## 测试与验证

Focused：

```bash
bun run typecheck
cd test/host-fixture
bun ./build-source.mjs
bun test ./<focused>.test.ts
```

完整 gate：

```bash
bun run verify:acm
```

host fixture 必须覆盖 exact Pi version、adapter capability/installation、successful shrinking travel、in-flight tool pair、provider context、native compaction accounting、failure fallback、repeated travel、off-path restore、resume、lifecycle cleanup、multi-session/subagent isolation。

不要使用 `console.log`；用户可见 warning 使用 `ctx.ui.notify()`。
