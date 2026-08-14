# Plan 001: 统一三处锚点扫描为一个 scanner module 并共享会话快照

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 858d25cd..HEAD -- src/checkpoint-tool.ts src/travel-tool.ts src/runtime-lifecycle.ts src/timeline-tool.ts src/context-packet.ts src/host-bridge.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED（三处语义差异必须原样保留为参数，不得抹平）
- **Depends on**: none
- **Category**: tech-debt + perf
- **Planned at**: commit `858d25cd`, 2026-08-14

## Why this matters

「往回找最近一条能重建合法上下文的锚点条目」这条规则（优先最新 protocol-complete；全部是 repaired 时回退最新 rebuildable repaired；rebuild 失败或空包一律跳过）目前**手抄了三份**：`checkpoint-tool.ts`（自动落点）、`travel-tool.ts`（回程票）、`runtime-lifecycle.ts`（compaction 前存档）。历史漂移已真实发生（b032357d 之前 lifecycle 份缺 fallback）；上一次补「空包不算锚点」规则（2db704f3）跨 3 个 src + 3 个 test 文件。同时每扫描一个候选就完整执行一次 `getEntries()` + 重建 ID Map（O(E)），最坏 200 个候选 = 200 次全量重建，恰发生在上下文最满时。本计划抽出唯一 scanner module，并把 per-candidate 的全量读取/索引收敛为一次共享快照；timeline 的 checkpoints 视图（1+N 次全量投影）一并改吃快照。

**不承诺的**：每个候选仍需各自跑 `buildSessionContext`（按 leaf 建 path）与 protocol 分析——那是语义本身。消除的是重复的 entries 读取与 Map 重建。

## Current state

文件与角色（均为 `858d25cd` 实测）：

- `src/checkpoint-tool.ts` — 自动落点扫描在 `execute` 内联（循环头见 :216 `for (; index >= 0 && inspected < ANCHOR_SEARCH_WINDOW; index--, inspected++)`；穷尽判定 :278）。特征：**skip 证据逐类记录**（`context_build_failed` 带 message / `empty_context_packet` / `protocol_invalid` 带 defects / `protocol_repaired` 带 repairs），选中后还取 `snippet`/`role` 进回执。
- `src/travel-tool.ts` — 回程票扫描（:491 `for (let index = startIndex, inspected = 0; index >= lowestIndex && inspected < ANCHOR_SEARCH_WINDOW; ...)`)。差异：有**硬下界** `lowestIndex`（on-path 折叠时票必须严格晚于 target：`const lowestIndex = resolved.fromOffPath ? 0 : targetBranch.length;`）；当 target packet 本身是 `repaired` 时 **repaired 候选直取**（`status !== "complete" && !(status === "repaired" && targetProtocolStatus === "repaired")`）；`!packet.ok || messages.length === 0` 静默跳过（不记证据）；无候选时返回 `no_protocol_complete_backup_target` 错误回执。
- `src/runtime-lifecycle.ts` — compaction 前扫描（:533 循环，:524-555）。最简变体：只取 `checkpointTargetId`，无证据记录，abort 时整个 handler return。
- `src/host-bridge.ts:186-217` — `buildSessionMessages(sm, leafId?)`：每次调用 `sm.getEntries()` 全量 + `new Map(entries.map(...))` + 纯函数 `buildSessionContext(entries, effectiveLeaf, byId)`（`buildSessionContext` 是 `@earendil-works/pi-coding-agent` 的**纯导入**，:9，无 capability 探测）。
- `src/context-packet.ts:387-411` — `rebuildAcmContextPacket(sm, leafId?)` = `buildSessionMessages` + `normalizeExistingAcmPacket`（protocol 分析，per-leaf 语义工作）。
- `src/timeline-tool.ts:628-689` — checkpoints 视图：`GXq` 行 rebuild current leaf 一次，`Dzj` 行 rebuild root，`VN6` 行循环内对每个 displayed checkpoint `rebuildAcmContextPacket`（本地 `cache` 仅按 entryId 去重）。

三处共有骨架（逐行核对一致）：

```ts
const packet = rebuildAcmContextPacket(sessionManager, candidate.id);
if (!packet.ok ...) continue;                    // checkpoint 记证据；另两处静默
if (packet.value.messages.length === 0) continue; // checkpoint 记 empty_context_packet
const status = packet.value.protocol.status;
if (status === "complete") { /* 选中，break */ }
if (status === "repaired" && repairedFallback === undefined) { /* 记 fallback */ }
```

仓库约定：TypeScript ESM source-first；错误处理走 Result 形状（`{ ok: false, error, message }`，见 `src/host-bridge.ts` 的 `failure()`/`success()`）；测试用 `bun:test`，样式参照 `test/tool-protocol.test.ts`。

必须保留的已记载语义（AGENTS.md）：两级回退以 invalid-only 为硬底；「rebuild 后 messages 为空的候选（repaired 或 complete）一律不算合法锚点」在 compaction、checkpoint、return-ticket 三处一致。

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| 全部测试 | `bun test` | 全绿（含既有 anchor characterization） |
| 类型检查 | `bun run typecheck` | exit 0 |
| 单测过滤 | `bun test test/anchor-scan.test.ts` | 新增用例全绿 |
| 完整 gate（最后跑一次） | `bun run verify:acm` | exit 0（含 host fixture，较慢） |

## Scope

**In scope**（只允许改这些）：
- `src/anchor-scan.ts`（新建）
- `src/host-bridge.ts`（新增 snapshot 构造；`buildSessionMessages` 原样保留）
- `src/context-packet.ts`（新增 snapshot 版 rebuild 入口）
- `src/checkpoint-tool.ts`、`src/travel-tool.ts`、`src/runtime-lifecycle.ts`（三处扫描改调 scanner）
- `src/timeline-tool.ts`（checkpoints 视图改吃快照）
- `test/anchor-scan.test.ts`（新建）、`test/tool-execution.test.ts`（仅允许追加 getEntries 计数断言，不改既有用例）

**Out of scope**（碰都不要碰）：
- `src/tool-protocol.ts` 的 protocol 分析逻辑本身
- 三处扫描的**用户可见回执文案与 details 字段**——逐字节保持现状（receipt 是有渲染级测试锁定的契约面）
- `src/fold-estimate.ts` 及 fold 投影的装配方式（另一项已搁置的工作）
- `src/lib.ts` 的任何拆动（Plan 004 的事）

## Git workflow

- 每个 Step 一个 commit；消息风格照仓库惯例（见 `git log --oneline`）：`refactor(anchor): ...`、`perf(timeline): ...`。
- 提交身份必须 repo-local：`git -c user.name="KorenKrita" -c user.email="KorenKrita@gmail.com" commit`。
- 不 push、不开 PR。

## Steps

### Step 1: 新建 `src/anchor-scan.ts`（scanner module）

导出（形状参照，命名可微调但语义固定）：

```ts
export interface AnchorScanSkip {
  id: string;
  reason: "context_build_failed" | "protocol_invalid" | "empty_context_packet" | "protocol_repaired";
  message?: string;
  repairs?: ToolProtocolRepair[];
  defects?: ToolProtocolDefect[];
}
export interface AnchorScanOptions {
  branch: readonly SessionEntry[];
  startIndex: number;          // 从这里（含）往回扫
  lowestIndex?: number;        // 硬下界，默认 0（travel 传 targetBranch.length 或 0）
  window: number;              // ANCHOR_SEARCH_WINDOW
  signal?: AbortSignal;
  acceptRepairedDirectly?: boolean; // travel：target packet 本身 repaired 时为 true
  rebuild: (entryId: string) => AcmPacketRebuildResult; // 快照或原实现注入
}
export interface AnchorScanResult {
  entryId: string | null;
  entry?: SessionEntry;               // 选中候选原对象（checkpoint 取 snippet/role 用）
  protocolStatus?: "complete" | "repaired";
  protocolRepairs?: ToolProtocolRepair[];
  normalizations: AcmProtocolNormalization[];
  skipped: AnchorScanSkip[];
  aborted: boolean;
  searchExhausted: boolean;   // !entryId && !aborted && inspected === window && index >= lowestIndex
  inspected: number;
}
export function scanProtocolAnchor(options: AnchorScanOptions): AnchorScanResult;
```

规则（与三处现状逐条对齐）：complete 即选中；repaired 记为首个 fallback 后继续（`acceptRepairedDirectly` 时直取）；`!ok` / 空包 / invalid 各记 skip；loop 结束无选中且非 aborted 且有 fallback → 用 fallback，并把它自己的 skip 条目从 `skipped[]` 移除（checkpoint 现行为）；abort 置 `aborted` 立即返回。**skip 证据无条件收集**——travel/lifecycle 只是忽略，行为不变。

**Verify**: `bun run typecheck` → exit 0（新文件无人引用也须编译通过）。

### Step 2: 快照 seam（`host-bridge.ts` + `context-packet.ts`）

- `host-bridge.ts` 新增：

```ts
export interface SessionSnapshot {
  readonly entries: readonly SessionEntry[];
  readonly byId: ReadonlyMap<string, SessionEntry>;
  /** 单 leaf 消息构建；复用快照的 entries/byId，不重复读 host。 */
  messagesAt(leafId: string): HostResult<AgentMessage[], { leafId: string | null; cause: string }>;
}
export function createSessionSnapshot(sm: ReadonlySessionManager): HostResult<SessionSnapshot, ...>;
```

  实现里 `messagesAt` 直接用 `buildSessionContext(entries, leafId, byId)`（try/catch 结构照抄 `buildSessionMessages` :205-217 的两个 catch 分支与错误文案，只是不再 `getEntries()`/建 Map）。
- `context-packet.ts` 新增 `createAcmPacketSnapshot(sm)`：包住 `createSessionSnapshot`，暴露 `rebuild(leafId: string)` = `messagesAt` + `normalizeExistingAcmPacket(result.value, activeEntries)`（activeEntries 取法照抄 `rebuildAcmContextPacket` :398-407 的 `getBranch(leafId)` 分支）。现有 `rebuildAcmContextPacket` 原样保留（无 leaf/当前 leaf 的调用点继续走它）。

**Verify**: `bun run typecheck` → exit 0；`bun test` → 全绿（无行为变化）。

### Step 3: 三处扫描换用 scanner（每处一个 commit）

共同形态：`const scan = scanProtocolAnchor({ branch, startIndex, window: ANCHOR_SEARCH_WINDOW, signal, rebuild: snapshot.rebuild, ...差异参数 })`，然后各调用方只做**自己已有**的回执/落点逻辑。

- `checkpoint-tool.ts`（:216 起的内联扫描）：`skipped` 证据、`protocolStatus`/`protocolRepairs`/`normalizations`、`snippet`/`role`（用 `result.entry` 调既有的 `getMessageRoleLabel`/`describeEntrySnippet`）、`searchExhausted`、`aborted` 全部改从 scan 结果取。错误回执文案与 `details.skipped` 结构**逐字段不变**（`SkippedCheckpointAnchor` 的四类 reason 值不变）。
- `travel-tool.ts`（:491 起）：传 `lowestIndex` 与 `acceptRepairedDirectly: targetProtocolStatus === "repaired"`；scan 前 `signal.aborted` 检查与 scan 后的 `no_protocol_complete_backup_target` 回执、`backupEntryId !== originId` 的 notify 保持在 travel-tool 内不动。`backupProtocolStatus` 等赋值改读 scan 结果。
- `runtime-lifecycle.ts`（:533 起）：只取 `scan.entryId`；scan 前 abort 检查照旧（整个 handler return）；无 entryId 时的 notify 文案不变。
- 三处的 `rebuild` 均来自同一 `createAcmPacketSnapshot(sessionManager)`（在扫描开始前创建一次）。

**Verify**: `bun test` → 全绿。重点确认这些既有用例**未改一字仍绿**：`test/tool-execution.test.ts` 中 "a clean target still folds when mid-span damage leaves only repaired ticket candidates"、"a complete candidate still wins over a newer repaired one for the return ticket"、"automatic checkpoint skips empty repaired candidates and writes no label"、"return-ticket scan skips empty repaired candidates and aborts without mutating"、"a repaired target keeps the newest repaired ticket candidate over an older complete one"、"anchors on the latest repaired entry when an unclosed batch poisons the whole window, with bounded work"；`test/deferred-refresh-runtime.test.ts` 的 compaction fallback 用例。

### Step 4: checkpoints 视图吃快照（`timeline-tool.ts:628-689`）

进入 checkpoints 分支时创建一次 `createAcmPacketSnapshot(sessionManager)`；`GXq`（current leaf，leafId 是显式 id）、`Dzj`（root）、循环内 `VN6`（每个 displayed checkpoint）的 `rebuildAcmContextPacket(sessionManager, id)` 全部换成 `snapshot.rebuild(id)`。既有 per-entryId `cache` 保留。current-leaf rebuild 若当前代码传的是显式 leafId（是：`rebuildAcmContextPacket(sessionManager, leafId)`），直接换；若发现任何调用依赖「无参=当前 leaf」语义，那处保留原函数并记录在提交信息里。

**Verify**: `bun test` → 全绿（timeline checkpoints/HUD 相关用例不改仍绿）。

### Step 5: getEntries 调用计数测试

在 `test/tool-execution.test.ts` 追加一个用例（样式照 :1163 的 bounded-work 用例的 mock 手法）：构造带未闭合 tool batch 的 branch，跑一次自动 checkpoint，断言扫描期间 mock sessionManager 的 `getEntries()` 被调用次数为一个**常数**（快照一次 + 既有回执路径的固定次数——先跑通再写下实测常数，并在断言旁注释该常数构成），而不是随候选数线性增长。

**Verify**: `bun test test/tool-execution.test.ts` → 全绿。

## Test plan

- 新建 `test/anchor-scan.test.ts`（样式参照 `test/tool-protocol.test.ts`）：直打 scanner interface，覆盖——complete 胜过更新的 repaired；全 repaired 时取最新 fallback 且其 skip 条目被移出；`!ok` 与空包分别记 `context_build_failed`/`empty_context_packet` 并跳过；invalid 记 defects 跳过；`acceptRepairedDirectly` 直取；`lowestIndex` 下界（下界之下的候选不看）；window 耗尽置 `searchExhausted`；signal abort 中途返回 `aborted`。rebuild 用注入的 stub（不需要真 SessionManager）。
- 既有 characterization 见 Step 3 的 Verify 列表——**一个都不许改**。

## Done criteria

- [ ] `bun run typecheck` exit 0
- [ ] `bun test` exit 0，含 `test/anchor-scan.test.ts` 全部新用例
- [ ] `grep -n "repairedFallback" src/checkpoint-tool.ts src/travel-tool.ts src/runtime-lifecycle.ts` 无结果（fallback 逻辑只活在 scanner 里）
- [ ] `grep -cn "rebuildAcmContextPacket(sessionManager," src/timeline-tool.ts` 中 checkpoints 分支不再出现逐候选调用（current/root/N 处全走 snapshot.rebuild）
- [ ] `git status` 无 Scope 之外文件改动
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 任一 "Current state" 引用的行号/代码与现场不符（drift）。
- Step 3 后任何列出的 characterization 用例变红——说明 scanner 抹平了某处语义差异；**不要改测试**，回头对齐 scanner。
- 发现三处之外还有第四处同构扫描。
- 快照化导致任一回执 details 字段（如 `skipped`、`backupProtocolStatus`）与现状不一致。

## Maintenance notes

- 今后锚点规则（比如新增一种 skip 原因）只改 `src/anchor-scan.ts` + 直测；三个调用方只在回执层感知。
- 若未来引入「跨候选共享 path 投影」的更深优化，快照 `SessionSnapshot` 是落点。
- 已明确不在本计划：fold 投影装配的三处统一（搁置）；回执文案重构（搁置）。
