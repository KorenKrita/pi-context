# ACM Canonical Guidance

This file is the editable source for always-on ACM guidance and generated tool/result text. Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE

The CORE is the **way** (道): judge what belongs in the **working set**. Tool descriptions and the advanced Skill are the **technique** (术): apply that judgment through checkpoints, timeline evidence, handoff wiring, and travel.

### Working-set doctrine

A context window is a **working set**, not a transcript. Keep the exact material that can still change the next action; let finished process leave only when its outcome can stand on its own.

A **boundary** is semantic: a goal, phase, attempt, burst, or front—not whichever checkpoint happens to be nearest. A boundary stays open while its raw process serves **active uncertainty**. Conflicting reports, an unexplained failure, or a next action that resolves an unknown are an **open loop**: keep their raw evidence in the working set until the loop closes.

**Recoverability** is the seatbelt of expansion. **Unlabeled return state + imminent working-set expansion = unbuckled seatbelt.** Before accelerating into a distinct goal, risky attempt, broad burst, or parked front, attach a semantic checkpoint to the state worth returning to. The checkpoint is a bookmark, not a closing bracket: it changes what can be recovered, not whether the boundary is closed.

A **handoff** replaces a closed boundary's process with executable state. It passes **cold start** only when a fresh agent can run the next action from the handoff and direct evidence pointers without reading archived conversation. A concise handoff that loses a live constraint is worse than keeping the raw detail.

**Summary debt** grows when handoff layers accumulate, old and new summaries compete, or parked fronts lose one authoritative home. Summary depth and context pressure are evidence of possible debt, not permission to travel. Pay summary debt by replacing obsolete layers with one cold-start handoff only when the surviving state is complete.

**Anchor gravity** pulls toward the newest label, the root, or the easiest target. A travel target marks where the retained spine begins; it is not the place where the newest state happens to live. Name the boundary first and choose the last clean anchor before it. To retire stacked handoffs, the target must precede the layers being retired. Earliest and nearest are candidates; boundary and cold start decide.

### Tend the working set

Use these judgments whenever the working set changes; they are a compass, not a fixed tool sequence:

- **Protect** — buckle the recoverability seatbelt before the working set expands into a distinct goal, risky attempt, unbounded burst, or parked front. Create the semantic checkpoint before motion, while the return state is still obvious.
- **Hold** — an open loop stays on the desk. While active uncertainty remains, keep its raw observations, alternatives, citations, and failure evidence live. A checkpoint is only a bookmark; context pressure raises attention but closes nothing.
- **Distill** — when a boundary closes, preserve conclusions, decisions, invariants, external effects, exclusions, and direct evidence; let exploratory process become archive.
- **Fold** — travel only when the omitted raw path is recoverable and the handoff passes cold start. A checkpoint alone is not a reason to fold.
- **Rebase** — when summary debt is real, seek the earliest safe base that can replace obsolete active handoffs with one authoritative handoff. If no candidate preserves every front and invariant, keep the needed state live.
- **Verify** — after any travel, treat the handoff as the new working set, then confirm the selected branch, recovery pointer, context-sync state, and external side effects before continuing.

### Boundary moments

These moments call for judgment, not an automatic trajectory:

- A new request may open a new boundary while the previous result is stable. If no semantic recovery label protects that result, checkpointing that return state is the next action before any broad read or scan for the unrelated goal; the new request alone is not a reason to fold.
- A broad read, log stream, subagent fan-out, or risky mutation may create a burst. Protect its entrance; fold only after its uncertainty is distilled.
- A rejected direction closes one attempt but may leave evidence that constrains the next. Keep the constraint, archive the dead process, and move the authoritative state forward.
- A final answer closes user-facing work only when no active uncertainty, external effect, or promised verification remains. The answer needs results and evidence, not the archived process.
- Rising context pressure is a weather report. Re-examine boundaries and summary debt; continue normally when cold start or recoverability would fail.

### Tool roles

- `acm_checkpoint` creates recoverability; it does not fold, branch, or prove completion.
- `acm_timeline` exposes branch topology, active uncertainty clues, and summary-debt evidence; it does not choose the semantic boundary or certify cold start.
- `acm_travel` folds one named boundary or rebases accumulated handoffs. Its tool contract owns the seven-slot wire format, target mechanics, isolated execution, and host recovery details.

When the normal judgment is clear, act directly. Load the advanced context-management Skill only when mechanics remain ambiguous or an exceptional result needs recovery.
<!-- ACM:CORE:END -->

<!-- ACM:TOOL_CHECKPOINT:START -->
Unlabeled return state plus imminent working-set expansion means the seatbelt is unbuckled: create a semantic checkpoint before the first broad action. This attaches recoverability to session history without changing the active working set. Use it when a distinct goal, phase, risky attempt, unbounded burst, parked front, or archive lookup is about to expand context, and whenever a durable recovery point would change what can safely leave context. A checkpoint is a bookmark, not proof that a boundary closed. Names are unique and case-sensitive across the session tree; their wording is a human recovery cue, not a runtime state classifier. Omitting `target` labels the nearest meaningful USER/AI turn; an explicit checkpoint name or node ID can label older history.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Inspect working-set topology and summary-debt evidence through one view: `active`, `checkpoints`, `search`, or `tree`. Omit `view` for `active`. Use `checkpoints` or `search` to compare non-obvious anchors and `tree` only when branch ownership or ancestry matters. Timeline reports facts such as active summary depth and projected depth; boundary closure, active uncertainty, target safety, and cold start remain semantic judgments.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Replace one raw history segment with a recoverable handoff at a checkpoint, node ID, or root: either a local fold of one closed boundary or a rebase of accumulated handoffs. Travel is ready only when the boundary is named, active uncertainty is preserved, omitted detail has a recovery pointer, and the handoff passes cold start. The target is the last clean anchor before the raw segment; a rebase target must precede the active handoff layers it retires, while the newest authoritative state belongs inside the handoff. Run `acm_travel` alone in its assistant tool batch; mixed batches are rejected before mutation.
<!-- ACM:TOOL_TRAVEL:END -->

<!-- ACM:CUE_CHECKPOINT:START -->
Checkpoint recorded: the recoverability seatbelt is buckled and the working set is unchanged. This is a bookmark, not a closing bracket; continue, hold, or close the boundary according to active uncertainty.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
`active` shows the current spine. Read it as the live working set; inspect another view only when a boundary, recovery pointer, or branch owner remains uncertain.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Active handoff layers are visible. Check for real summary debt: can one authoritative cold-start handoff replace obsolete layers without losing a front or invariant? Pressure or depth alone is not permission to travel.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
`checkpoints` shows named recovery candidates and projected depth. Resist anchor gravity: compare each candidate with the named boundary rather than choosing by recency or label alone.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
`search` finds semantic labels, node IDs, and content across the tree. Narrow until the last clean anchor before the boundary is identifiable; a current raw node ID is a valid fallback.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
`tree` exposes ancestry and front ownership. Use topology to reject anchors inside the boundary or on another front, then return to the smallest evidence view needed.
<!-- ACM:CUE_TIMELINE_TREE:END -->

<!-- ACM:CUE_TRAVEL:START -->
Travel applied. Treat the handoff as the new working set; verify the resolved target, recovery pointer, summary leaf, context-sync state, and external effects before executing NEXT.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
Search existing checkpoints, preserve the semantic base, and add the smallest useful scope, ordinal, or date. Do not overwrite the existing recovery target.
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
The supported Host Bridge capability is unavailable or malformed. Hold the current working set, report the named capability error, and verify the exact supported Pi version before retrying mutation.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
The backup label remains in the tree. Record its label and entry ID as a recovery pointer before any retry.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
Branch creation was not applied and the new backup label was rolled back. Correct the reported host failure before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Branch mutation or prior aliases make automatic backup rollback unsafe. Keep the reported backup pointer and inspect the active leaf before retrying.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
Travel mutation landed, but rebuilt message evidence is pending. Use the reported summary entry as the fallback and inspect context sync state if the next rebuild fails.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
Off-path travel restored raw history. Keep only the detail serving the current lookup, then return it to the authoritative working set unless this archive branch intentionally replaces that state.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context reconstruction exhausted bounded retries. Reload the session, inspect timeline sync state, and resume only after the selected branch and handoff are authoritative.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
