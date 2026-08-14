# Plan 002: 让未配对 tool call 的剥离按所属 assistant batch 配对

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 858d25cd..HEAD -- src/tool-protocol.ts test/tool-protocol.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED（必须保留同 batch 多 call 的重排/去重/缺失-result 合成行为）
- **Depends on**: none（与 001 文件不相交，可并行）
- **Category**: bug
- **Planned at**: commit `858d25cd`, 2026-08-14

## Why this matters

`analyzeToolProtocol` 的其余阶段（orphan 判定、重排、缺失-result 合成）都用 **batch-local** 语义：一个 toolResult 属于紧邻其前的那个 assistant batch，且前置 assistant 不能是 `error`/`aborted`。但末尾的 `stripUnpairedToolCalls` 用**全消息数组**的 toolCallId 全集判断「已配对」。当一条 `stopReason: "aborted"/"error"` 的旧 assistant tool call 与后续正常 batch 恰好重用同一 `toolCallId` 时，后者的合法 result 会把前者误判为已配对——aborted call 残留进最终 packet，交给 provider。代码注释（`tool-protocol.ts:281-282`）明说这一步的意图就是 "removes calls from aborted/error turns"，全局集合让它在 id 重用场景下失效。

触发罕见（主流 provider 的 toolCallId 基本唯一），所以**第一步是写复现测试确认**，确认后再修。

## Current state

`src/tool-protocol.ts`（`858d25cd`）：

- `:106-147` `stripUnpairedToolCalls`：

```ts
function stripUnpairedToolCalls(messages: AgentMessage[], repairs: ToolProtocolRepair[]): void {
  const pairedToolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
  }
  // ...向后遍历，assistant content 里 id 不在全局集合的 tool call 被剥离
}
```

- orphan 判定（≈:246-268）走的是 batch-local：`preceding.stopReason !== "error" && !== "aborted"` 且前置 assistant content 含同 id。
- 重排/合成阶段（≈:270-312）同样跳过 `error`/`aborted` assistant，且只为**紧随其后的连续 toolResult run** 合成缺失 result——这保证非 error assistant 的每个 call 在该阶段后都有 result。
- `:284` `stripUnpairedToolCalls(result, repairs)` 在末尾调用。
- 既有回归 `test/tool-protocol.test.ts:141-171` 只覆盖「aborted call 的 id 未被后续 batch 重用」的情形。

仓库约定：测试 `bun:test`；repair 记录形状 `{ kind: "stripped_unpaired_tool_call", toolCallId, toolName }` 不得改名（回执与测试在消费它）。

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| 单文件测试 | `bun test test/tool-protocol.test.ts` | 全绿 |
| 全部测试 | `bun test` | 全绿 |
| 类型检查 | `bun run typecheck` | exit 0 |

## Scope

**In scope**：
- `src/tool-protocol.ts`（仅 `stripUnpairedToolCalls` 及其私有辅助）
- `test/tool-protocol.test.ts`（追加用例）

**Out of scope**：
- `analyzeToolProtocol` 其余阶段（orphan/重排/合成/defects）
- `context-packet.ts`、任何锚点扫描（Plan 001 的地盘）
- repair 的 kind 字符串与既有 repair 形状

## Git workflow

- 两个 commit：`test(tool-protocol): reproduce cross-batch id reuse keeping aborted calls`（先红后绿的复现）→ `fix(tool-protocol): pair stripped calls with their owning assistant batch`。
- 提交身份 repo-local：`git -c user.name="KorenKrita" -c user.email="KorenKrita@gmail.com" commit`。不 push。

## Steps

### Step 1: 复现测试（先确认 bug 真实）

在 `test/tool-protocol.test.ts` 追加用例（样式照 :141-171 的 aborted-tool-call 回归）：构造消息序列——
1. assistant A：`stopReason: "aborted"`，content 含 tool call `{id: "X", name: "read"}`；
2. assistant B（正常）：content 含 tool call `{id: "X", name: "read"}`（**故意重用 X**）；
3. toolResult：`toolCallId: "X"`，紧跟 B。

断言（修复后的目标行为）：A 的 tool call 被剥离（repair 含 `stripped_unpaired_tool_call` 且 `toolCallId === "X"` 来自 A），B 与 result 完整保留，最终 `analyzeToolProtocol(...).messages` 中**不存在任何带 id X 且属于 A 的 call**，且 result X 紧跟 B。

先跑：`bun test test/tool-protocol.test.ts` → **新用例应当红**。若它意外绿了（现状已正确处理），这是 STOP 条件——报告后停，不改实现。

**Verify**: 新用例红 + 其余全绿。

### Step 2: 修复 `stripUnpairedToolCalls`

把全局集合换成 per-assistant 的「紧随其后的连续 toolResult run」配对：

```ts
function stripUnpairedToolCalls(messages: AgentMessage[], repairs: ToolProtocolRepair[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const batchResultIds = new Set<string>();
    let following = index + 1;
    while (following < messages.length && messages[following]!.role === "toolResult") {
      const id = messages[following]!.toolCallId;
      if (id) batchResultIds.add(id);
      following++;
    }
    // 既有逐 content 剥离逻辑不变，只是判据从全局集合换成 batchResultIds
  }
}
```

要点：该函数在重排/合成之后运行，非 error assistant 的 call 届时都有 result 在自己的 run 里，不受影响；error/aborted assistant 的未配对 call 被剥离——与无 id 重用时的现状一致，只是 id 重用时不再漏网。repair push、`strippedIndices`、空 content 时 `splice` 移除整条 assistant 的既有行为原样保留。

**Verify**: `bun test test/tool-protocol.test.ts` → 全绿（新用例转绿）；`bun test` → 全绿（`context-packet` / `tool-execution` / `deferred-refresh-runtime` 里的 protocol 相关 characterization 一字不改仍绿，重点看 "anchors on the latest repaired entry when an unclosed batch poisons the whole window, with bounded work" 这类依赖 aborted batch 行为的用例）。

## Test plan

- Step 1 的复现用例（跨 batch id 重用）。
- 追加边界：aborted assistant 后**没有**任何 result（现状已剥离）——回归保护；同 batch 多 call + 部分 result 在重排后存在——确认不误剥。
- 既有全部 protocol 测试不改一字。

## Done criteria

- [ ] `bun run typecheck` exit 0
- [ ] `bun test` exit 0，含新增跨 batch 重用用例
- [ ] `grep -n "pairedToolResultIds" src/tool-protocol.ts` 返回的全局集合模式已消失（或仅在 batch 局部作用域）
- [ ] `git status` 无越界文件
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- Step 1 复现用例意外通过（bug 不成立或已被修）。
- 修复后任何既有用例变红且一次合理修正无效。
- 发现需要在 `analyzeToolProtocol` 其他阶段改代码才能让新用例绿——越界，停。

## Maintenance notes

- review 重点：确认「非 error assistant 的 call 不受影响」（重排/合成阶段已保证其 run 内有 result）。
- 未来若 host 引入确定性 toolCallId（重试复用 id 变常见），此修复从防御变为必要。
