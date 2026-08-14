# Plan 005: 把 provider delivery 状态机从 AcmSessionRuntime 抽成独立 module

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 858d25cd..HEAD -- src/runtime.ts src/runtime-lifecycle.ts test/deferred-refresh-runtime.test.ts`
> On a mismatch, compare the "Current state" method inventory against the live
> code before proceeding; treat a mismatch as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED（大量方法搬家；签名与外部可见行为必须逐字不变）
- **Depends on**: 004（runtime.ts 的 import 届时已指向具名 module，避免两次改同一文件头）
- **Category**: tech-debt
- **Planned at**: commit `858d25cd`, 2026-08-14

## Why this matters

`src/runtime.ts`（538 行）的 `AcmSessionRuntime` 同时是五种状态的家：refresh 调度、**provider delivery 状态机**、usage/pressure 权威、gauge 节奏、boundary/ledger/travel-turn 计数。其中 provider delivery（travel 后 provider 切换的 pending→ready→active→fallback→cached_exhausted/rejected 相位与缓存 packet 管理）是唯一有真实内部状态机语义的大块：~16 个方法 + 3 个私有类型 + 2 个纯函数，全部围绕一个 `WeakMap<object, DeferredTravelRefreshState>`。把它抽成 `src/provider-delivery.ts` 后，相位转移规则集中一处可直测；`test/deferred-refresh-runtime.test.ts`（1429 行）继续通过不变的方法面（runtime 委托）全绿。

**范围修正（相对最初提案）**：gauge 周期那组方法（`shouldShowGaugeNow`/`isNewGaugeBoundary`/`confirmGaugeShown`/`resetGaugeCycle`/`gaugeState`）**不抽**——它们是 `context-gauge.ts` 深模块之上的 3 行转发，再包一层是 shallow module，删除测试不通过。usage/pressure 权威（`authoritativeContextPressure` 等）也**留在 runtime**——AGENTS.md 记载它是 gauge/HUD/checkpoint/travel 共用的唯一权威，且它天然桥接 delivery 状态与 usage 缓存。

## Current state

`src/runtime.ts`（`858d25cd`，全文已核）结构：

- 纯函数/私有类型（与 delivery 强相关）：`stableMessageMatch`（:45-53）、`suffixAfterKnownPrefix`（:54-68）、`DeferredTravelRefreshState`（:10-20）、`CachedProviderPacket`（:22-29）、`ContextUsageInput`（:31-36）。
- 相位类型（导出）：`ProviderDeliveryPhase`（:73-80）、`ContextDeliveryPhase`（:88-102）、`ProviderDeliveryStatus`（:104-112）。
- delivery 方法（只读写 `deferredTravelRefresh` map 与 `liveAgentSessions` adapter）：`deferPostTravelRefresh`、`getContextDeliveryPhase`、`getProviderDeliveryStatus`、`markProviderCutoverReady`、`getPendingTravelToolCallId`、`activateProviderPacket`、`recordProviderDeliveryFailure`、`getCachedProviderPacket`、`mergeCachedProviderPacket`、`cacheProviderFallbackPacket`、`shouldRebuildProviderContext`、`isProviderDeliveryActive`、`markProviderUsageObserved`、`keepDeferredRefreshThroughToolExecution`、`settleDeferredRefresh`、`getLiveAgentSyncStatus`、私有 `nativeReplacementApplied`。
- **跨状态方法（留在 runtime，做委托编排）**：
  - `rejectProviderCutover`：改 delivery 票据为 rejected **并**清理 `contextRefresh`/`refreshTargets`/`cachedUsage`/gauge cycle/adapter；
  - `resetUsageForModelChange`：清 usage + gauge **并**重置票据的 `providerUsageObserved`；
  - `clear`：清全部五类 store；
  - `scheduleRefresh`/`getRefreshTarget`（refresh 调度，留）；
  - `authoritativeContextPressure`/`isProviderUsageAuthoritative`（pressure 权威，留；读 delivery 的 `getProviderDeliveryStatus` 与 `nativeReplacementApplied`）。
- 外部使用点（搬家时必须保持可达）：`runtime.liveAgentSessions` 在 `runtime-lifecycle.ts:570` 被直接调用（`pruneNonContinuableTail`）；相位类型被 runtime-lifecycle/timeline/travel 导入（以 `grep -rn "ProviderDeliveryPhase\|ContextDeliveryPhase\|ProviderDeliveryStatus" src/ test/` 现场清单为准）。

仓库约定：类 + WeakMap keyed by `session: object`；注释承载大量决策语义，**搬家时注释随方法走、一字不丢**。

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| 类型检查 | `bun run typecheck` | exit 0 |
| 全部测试 | `bun test` | 全绿（1429 行 delivery 套件不改一字） |
| 引用清单 | `grep -rn "ProviderDeliveryPhase\|ContextDeliveryPhase\|ProviderDeliveryStatus\|liveAgentSessions" src/ test/` | 开工前拉取 |

## Scope

**In scope**：
- `src/provider-delivery.ts`（新建）
- `src/runtime.ts`（delivery 方法改委托；对外方法签名、类型 re-export 保持）
- `src/index.ts` 仅当其 import 需要跟随时

**Out of scope**：
- `src/context-gauge.ts`、`src/context-pressure.ts`、`src/boundary-ledger.ts`（已是深模块，不动）
- `src/runtime-lifecycle.ts`（除非 import 行需要加 `provider-delivery.js` 的类型——允许且仅允许 import 行改动）
- `test/deferred-refresh-runtime.test.ts`（**一字不改**，它是 characterization gate）
- `authoritativeContextPressure` 及 pressure 语义（已记载的单一权威，原地不动）

## Git workflow

- 单 commit：`refactor(runtime): extract the provider delivery state machine into its own module`。
- 提交身份 repo-local：`git -c user.name="KorenKrita" -c user.email="KorenKrita@gmail.com" commit`。不 push。

## Steps

### Step 1: 新建 `src/provider-delivery.ts`

把 Current state 列出的 delivery 私有类型、纯函数、相位类型、以及 `deferredTravelRefresh` map + 相关方法**原样**搬入一个 `export class ProviderDelivery`。构造函数注入 `LiveAgentSessionAdapter`：

```ts
export class ProviderDelivery {
  constructor(private readonly liveAgentSessions: LiveAgentSessionAdapter) {}
  private readonly tickets = new WeakMap<object, DeferredTravelRefreshState>();
  // 搬入的方法签名不变，`this.deferredTravelRefresh` 改为 `this.tickets`，
  // `this.liveAgentSessions` 保留；原方法内的 this.cachedUsage 等跨 store 引用不存在于这批方法中（已核对）
}
```

相位移入的方法里有两处例外要拆开：
- `rejectProviderCutover` 拆成 `ProviderDelivery.rejectTicket(session, toolCallId): boolean`（只做票据置 rejected + `liveAgentSessions.clear` + 构造 skipped sync outcome——即现 :312-345 中 touch deferred/adapter 的部分）与 runtime 侧保留的编排（`contextRefresh.clear`/`refreshTargets.delete`/`cachedUsage.delete`/`resetGaugeCycle` 后调 `rejectTicket`）。
- `deferPostTravelRefresh` 里 `this.scheduleRefresh(...)` 与 `this.cachedUsage.delete(session)` 两行留在 runtime 编排方法里；`ProviderDelivery.defer(session, toolCallId)` 承担其余（schedule liveAgentSessions + 写票据）。
- 类型 `ProviderDeliveryPhase`/`ContextDeliveryPhase`/`ProviderDeliveryStatus` 从 provider-delivery.ts 导出；`runtime.ts` 保留 `export type { ... } from "./provider-delivery.js"` 兼容再导出，现有 import 方零改动（除非你想顺手改直——可以，但必须全仓一致）。

同时给 ProviderDelivery 暴露 runtime 编排所需的两个只读探针：`nativeReplacementApplied(session): boolean`、`clearUsageObserved(session): void`（`resetUsageForModelChange` 用）以及 `forget(session): void`（`clear` 用）。

**Verify**: `bun run typecheck` → exit 0（新旧并存，runtime 尚未接线）。

### Step 2: runtime 改委托

`AcmSessionRuntime` 构造函数创建 `private readonly delivery = new ProviderDelivery(liveAgentSessions)`；原 16 个 delivery 方法变成单行委托（签名、JSDoc 一字不变）；三个跨状态方法按 Step 1 的拆分重写为编排；`readonly liveAgentSessions` 保留指向同一 adapter（`runtime-lifecycle.ts:570` 不受影响）。

**Verify**: `bun run typecheck` → exit 0；`bun test` → 全绿，特别是 `test/deferred-refresh-runtime.test.ts` 不改一字全绿。

### Step 3:（可选加分）ProviderDelivery 直测

在 `test/provider-delivery.test.ts` 写 3-5 个相位机直测（defer→markCutoverReady→activate 的正向链；rejected 后各探针读数；merge 的前缀缝合），stub 注入 `LiveAgentSessionAdapter`。样式照 `test/deferred-refresh-runtime.test.ts` 的构造手法但直打新类。

**Verify**: `bun test test/provider-delivery.test.ts` → 全绿。

## Test plan

- characterization：既有 1429 行 delivery 套件 + 全量 `bun test`，一字不改。
- 新增：Step 3 的相位直测（可选但推荐）。

## Done criteria

- [ ] `bun run typecheck` exit 0
- [ ] `bun test` exit 0（含未改动的 `deferred-refresh-runtime.test.ts`）
- [ ] `grep -n "deferredTravelRefresh" src/runtime.ts` 无结果（票据 map 只活在 provider-delivery.ts）
- [ ] `grep -rn "liveAgentSessions" src/runtime-lifecycle.ts` 的 :570 调用点无需改动即仍编译通过
- [ ] `git status` 无越界文件
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 搬家中发现某 delivery 方法还引用了 cachedUsage/gauge/refresh 等跨 store（Current state 声称只有 reject/defer 两处例外）——出现了计划未覆盖的耦合，报告后停。
- `deferred-refresh-runtime.test.ts` 任何用例变红（它测的就是这批方法的对外行为，变红=行为漂移）。
- 相位类型的消费方比现场清单多出 test/host-fixture 侧引用。

## Maintenance notes

- 今后改 provider 相位语义只碰 `src/provider-delivery.ts`；runtime 只做跨 store 编排。
- gauge/pressure/ledger 留在 runtime 是**决定**不是遗漏（见 Why this matters 的范围修正）；若未来 gauge 逻辑膨胀出真实状态机，再评估独立。
- review 重点：`git diff` 中 runtime.ts 的方法体应只剩委托行；provider-delivery.ts 与原文逐行对照（注释必须随行）。
