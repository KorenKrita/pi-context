# ACM Canonical Guidance

This file is the editable source for always-on ACM guidance and generated tool/result text. Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE v1

A context window is a **working set**: the exact material needed for the next action. Process accumulates naturally; keep live what NEXT needs. Name a **boundary** before folding finished process into a recoverable **handoff** that leaves **NEXT** executable.

### Working-set invariant

Conserve the working set: live context holds only what NEXT will reason over. Everything else is still needed live, or already folded into an executable handoff whose **archive** remains recoverable. Tools enforce structure; you judge when a transition earns its place against this invariant.

### Vocabulary

- **working set** — live detail the next action will reason over.
- **boundary** — the semantic edge being compressed: a burst, phase, failed direction, batch item, or task chain.
- **handoff** — the executable state that survives a fold; an evidence index, not a dump.
- **archive** — the raw off-path history and its recovery checkpoint or node ID.
- **chain** — continuous work serving one user goal.
- **burst** — temporary expansion from broad reads, logs, searches, diffs, or subagents.
- **anchor gravity** — the misleading pull of the nearest checkpoint. Name the boundary before choosing a target.
- **rebase** — move all surviving state into one authoritative snapshot at the earliest safe base, retiring accumulated summary depth.
- **cold start** — a fresh agent can execute `NEXT` from the snapshot and its pointers without archived summaries.

### ACM preflight

Recoverability has a cost curve: once managed work expands the trail, rewind without an anchor is expensive. A distinct user goal therefore begins with an **ACM preflight** on the branch that will carry it—opening a **managed chain**. After any needed finished-chain transition (see Recognizable moments), call `acm_checkpoint` with a semantic `<chain>-start` name before managed work: investigation, planning, delegation, any non-ACM tool call, file or external side effects, or multi-step reasoning. The preflight is complete only when the tool result confirms the checkpoint was created or reused. If the call fails, follow the recovery guidance in its result before proceeding. A **lightweight reply**—no evidence lookup, no side effects, no multi-step reasoning—stays outside the managed-chain workflow.

### Decision smells

These observables are quick checks against the working-set invariant—worth pausing for, not automatic commands:

- **Nearest checkpoint feels obvious** — **anchor gravity**; name the boundary before choosing a target.
- **Summary upon summary** — a rebase trigger; test structural reset and **cold start** from the earliest safe base.
- **User goal changed over finished work** — fold or rebase the prior chain before the new one starts.
- **Exploration done, implementation next** — raw burst trail can leave the working set once distilled into the handoff.

### Recognizable moments

When one of these situations arises, ask whether the working-set invariant still holds; restore it with the lightest transition that does:

| What you can observe | What becomes reasonable |
|---|---|
| Phase, attempt, or batch item starts | checkpoint its `-start` boundary before acting |
| Unbounded burst or risky step is next | checkpoint before output or side effects arrive |
| Findings are distilled and raw trail is no longer needed by NEXT | inspect timeline evidence, then fold the named boundary |
| Direction is rejected or superseded | put the dead direction in Exclusions, preserve surviving facts, then fold to its start |
| Final answer is next | run a rebase check; if it is not ready, fold the task chain when that removes material structure or create a unique `-done` checkpoint and answer directly |
| New request arrives over finished work | run a rebase check before starting the new chain; if it is not ready, fold the finished local chain |
| Another fold would stack on an active summary, a stable subchain closes, or context pressure rises | run a rebase check before choosing a local fold or accepting native compaction |

Context pressure raises priority of a **rebase check**. Travel earns its place only when fold criteria—and any rebase criteria—pass.

### Fold criteria

Travel when all three criteria hold:

1. **Boundary named** — say exactly what raw process leaves the working set.
2. **NEXT executable** — write one immediate action that can run from the handoff.
3. **Raw recoverable** — preserve omitted detail through a checkpoint, node ID, file, command, URL, commit, or other pointer.

Before `acm_travel`, answer in one line: what leaves, what pointer recovers it, and what single action is NEXT.

Name the boundary before choosing a target. Timeline reports evidence; it does not decide. A target must sit before the named boundary. Nearest and earliest anchors are candidates against that boundary—not answers by proximity.

### Rebase criteria

A **rebase** is a structural reset across accumulated summary depth. It uses the fold criteria and adds **structural reset** and **cold start**.

Structural reset passes only when the target precedes an active `branch_summary` that leaves the spine and projected summary depth does not grow. Equal depth passes only when the new snapshot replaces an old summary; a target after all active summaries fails.

Cold start passes only when `NEXT` is immediately executable, every surviving front and invariant is in the snapshot or a usable direct pointer, and ordinary execution needs no archived summary.

Build one authoritative snapshot, then evaluate candidates from earliest to latest. Choose the earliest base that passes both criteria. Root is ideal when it passes; treat it as a candidate until both clear. For rebase bases, compare candidates against boundary placement and cold start—not proximity.

If no candidate passes, rebase is not ready: keep required detail live, use a local fold, or accept native compaction. Ambiguous base selection, interleaved fronts, or raw-node fallback → load the context-management skill.

### Failure shapes

- **Folded too early** — NEXT stalls; recover the needed detail (or its pointer) before continuing.
- **Folded too late** — working set bloats; run a rebase check or fold the named boundary once criteria pass.
- **Wrong target** — a parked front, invariant, or recovery pointer vanishes; choose an earlier pre-boundary anchor.
- **Rebase skipped** — summaries stack; cold start degrades; test earliest safe bases before the next fold.

### Handoff shape

Every handoff uses these seven slots in this order. Write `none` when a category is empty. Evidence is a pointer index, not a dump of the folded trail.

```text
Goal: <current goal; quote a new triggering request when its turn will leave context>
State: <conclusions, decisions, status, key values and identifiers>
Evidence: <paths, commands, URLs, commits, errors, checkpoints or node IDs>
External: <file, process, browser, remote, ticket, or other side effects>
Exclusions: <dead ends and directions not to repeat, with reasons>
Recover: <archive checkpoint, backup label, or raw node pointer>
NEXT: <one executable next action>
```

The runtime validates slot structure and rejects mixed tool batches. Semantic completeness, target quality, recoverability, and whether NEXT is executable remain agent completion criteria.

### Representative transitions

**Local fold example**

Why: findings are distilled; raw trail is unused by NEXT; Recover keeps the burst archive.

```text
Goal: Fix high CPU while preserving the sidebar.
State: Profiling proved hidden tabs retain workers; implementation is next.
Evidence: artifacts/sidebar-profile.json; src/sidebar/session-manager.ts.
External: profiler stopped; no files changed.
Exclusions: disabling the sidebar violates the goal.
Recover: sidebar-profile-start.
NEXT: Checkpoint sidebar-lifecycle-fix-start, then inspect worker disposal.
```

**Finished-chain rebase example**

Why: prior chain is stable; one cold-start snapshot carries the new request from the earliest safe base.

Rebase the finished chain to the earliest base that passes cold start:

```text
Goal: Release fix complete; new request is "Add dry-run mode to migration."
State: v2.4.1 is validated and pushed; migration work has not started.
Evidence: commit 1a2b3c4; tag v2.4.1; full test output.
External: commit and tag pushed to origin.
Exclusions: version-detection workaround remains rejected.
Recover: release-fix-done.
NEXT: Checkpoint migration-dry-run-start, then inspect the migration command entry point.
```

After travel, confirm resolved target, summary leaf, backup outcome, raw usage/message/summary-depth deltas, and context-sync state. After a rebase, execute from the snapshot—archived summaries stay archive. If NEXT begins a new phase, checkpoint that phase before acting. Travel changes conversation context only; inspect disk and external systems directly.

For archive round trips, checkpoint-name collisions, travel failure, indeterminate mutation, or exhausted context refresh → load the context-management skill.
<!-- ACM:CORE:END -->

<!-- ACM:TOOL_CHECKPOINT:START -->
Preflight a distinct user goal on the branch that will carry it: after any finished-chain transition and before managed work makes rewind expensive, call this tool with a semantic `<chain>-start` name so the managed chain can begin. Also label later phase, attempt, burst, risky step, pause, milestone, or completion boundaries with a semantic `-start`, `-paused`, or `-done` name. Names are unique across the session tree and case-sensitive. Omitting target labels the nearest meaningful USER/AI turn; an explicit checkpoint name or node ID can label older history. This tool creates recoverability by labeling history without branching or folding the active context.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Inspect session structure and context evidence through one view: `active`, `checkpoints`, `search`, or `tree`. Omit view for `active`. Timeline reports active summary depth and projected depth for candidate bases. Use `checkpoints` or `search` to compare candidates against the named boundary or cold start; use `tree` only when topology matters. Choose by boundary or cold start, not by proximity or anchor gravity.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Apply one recoverable context transition: fold a named boundary or rebase accumulated summaries to the earliest safe base. Resolve a checkpoint, node ID, or root; complete validation before mutation; optionally bookmark the abandoned raw path. Use timeline evidence for target comparison. Travel reports structural and context deltas but cannot prove boundary quality or cold start completeness. Mixed tool batches are rejected before mutation.
<!-- ACM:TOOL_TRAVEL:END -->

<!-- ACM:CUE_CHECKPOINT_START:START -->
Recoverability confirmed. Continue the current working set; any later fold target is chosen by boundary, not nearest-anchor gravity.
<!-- ACM:CUE_CHECKPOINT_START:END -->

<!-- ACM:CUE_CHECKPOINT_DONE:START -->
Milestone archived. Use it as a recovery pointer. If this closes a stable chain or another fold would stack, run a rebase check against the working-set invariant before continuing.
<!-- ACM:CUE_CHECKPOINT_DONE:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
View `active` selected. Continue from the visible spine; inspect another view only when target identity or branch topology is not yet checkable.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Active summarized history is present. When the current situation is a rebase trigger or the next fold would stack, test structural reset and cold start from the earliest safe base; root passes only when the cold-start test passes.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
View `checkpoints` selected. Compare named candidates against the boundary, then inspect the chosen target's branch only if its placement remains ambiguous.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
View `search` selected. Narrow by semantic label, node ID, or content until the pre-boundary target is identifiable; use the returned raw node ID when no checkpoint fits.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
View `tree` selected. Use branch topology to verify front ownership and target placement; narrow with search or checkpoints if the tree is truncated.
<!-- ACM:CUE_TIMELINE_TREE:END -->

<!-- ACM:CUE_TRAVEL_PHASE:START -->
Anchor the next phase with a checkpoint, then execute the handoff NEXT.
<!-- ACM:CUE_TRAVEL_PHASE:END -->

<!-- ACM:CUE_TRAVEL_TASK:START -->
Final answer sources the handoff working set; archived process stays off the spine.
<!-- ACM:CUE_TRAVEL_TASK:END -->

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
Search existing checkpoints, preserve the semantic base, and add the smallest useful scope, ordinal, or date. Leave the existing recovery target unchanged.
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
The supported Host Bridge capability is unavailable or malformed. Stop mutation and report the named capability error; verify the exact supported Pi version before retrying.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
The backup label remains in the tree. Record its label and entry ID as a recovery pointer before any retry.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
Branch creation failed before mutation; the new backup label was rolled back. Correct the reported host failure before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Branch mutation or prior aliases make automatic backup rollback unsafe. Keep the reported backup pointer and inspect the active leaf before retrying.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
Travel mutation landed, but rebuilt message evidence is pending. Use the reported summary entry as the fallback and inspect context sync state if the next rebuild fails.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
Off-path travel restored raw history. Use the required detail, then return to the summary checkpoint unless this branch intentionally replaces it.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context reconstruction exhausted bounded retries. Reload the session, inspect timeline sync state, and resume only after the selected branch is authoritative.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
