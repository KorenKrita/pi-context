# ACM Canonical Guidance

This file is the editable source for always-on ACM guidance and generated tool/result text. Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE v1

**CHECKPOINT-FIRST: before ANY tool on a distinct goal, first emit only `acm_checkpoint` and wait.**

**PLANNING-ONLY is also Managed: first emit `acm_checkpoint`, not the plan.**

**If a request says to read, inspect, or run something and fold later, `acm_checkpoint` is still the first tool; never perform the named action first.**

**EXPLICIT FOLD REQUEST:** When the user requires folding the investigation before the final answer, one successful task-end `acm_travel` is required after the findings and timeline check. Do not substitute a `-done` checkpoint because the investigation is small.

A context window is a **working set**: keep the exact material needed for the next action live. Compress finished raw process only at a named **boundary**, into an executable **handoff** with a recovery pointer.

### CHECKPOINT-FIRST

Classify the new user turn before acting:

- **Direct** — complete it now with text only. Use no tool and no checkpoint.
- **Managed** — it needs a tool, delegation, investigation, planning, side effect, or multiple actions. For a distinct managed goal, **STOP before every other tool**: emit only `acm_checkpoint` with a semantic `<chain>-start` name, wait for created/reused, then work. The user's requested action order never displaces this sequence: checkpoint first, requested tool(s) second. Follow recovery guidance on error.

A fresh session needs no timeline. Continuing the same goal does not repeat chain preflight. Finished work on the active path takes the new-request transition before the next start checkpoint.

### Boundary loop

| Event | Required transition |
|---|---|
| Phase, attempt, or batch item starts | Checkpoint its semantic `-start` boundary before acting |
| Unbounded read/log/search/diff/subagent burst or risky step starts | Checkpoint before its output or side effects arrive |
| Findings are captured in `State`/`Evidence` and `NEXT` no longer needs the raw entries | Call `acm_timeline` to verify target placement, then fold the named boundary with isolated `acm_travel` |
| Direction is rejected or superseded | Preserve surviving facts, put the dead direction in `Exclusions`, then fold to its start |
| Managed goal is ready for its final answer | Run the task-close rule below |
| New request arrives over finished work | Rebase-check summarized history if present, close the finished chain, then checkpoint the new goal |
| Another fold would stack, a stable subchain closes, or context pressure rises | Run a rebase check before another local fold |

**Task close.** Before the final user-facing answer, close every managed goal. An explicit user-requested fold uses one task-end travel after its fold gates pass, regardless of small savings. Otherwise: known active summary depth zero creates a unique `<chain>-done` checkpoint, waits, then answers; unknown or positive depth runs a rebase check and travels only when every gate passes and material structure leaves the spine, falling back to the `-done` checkpoint.

**Rebase check.** Start from known active summary depth; call `acm_timeline` with `view=checkpoints` when depth or candidate placement is unknown. Depth zero means no rebase. With active summaries, apply the rebase gate from earliest candidate to latest. Context pressure leaves every gate unchanged.

### Fold gate

Travel only when all three criteria pass:

1. **Boundary named** — identify exactly which raw process leaves the working set.
2. **NEXT executable** — write one immediate verb + target that another agent can execute from the handoff without the folded trail.
3. **Raw recoverable** — point to the omitted detail through a checkpoint, node ID, file, command, URL, commit, or equivalent evidence.

Call `acm_travel` as the only tool in its assistant message. A target must precede the named boundary on the intended branch. Timeline supplies evidence; boundary semantics decide. Nearest, earliest, and `root` are candidates, never defaults.

### Rebase gate

A **rebase** replaces accumulated summary depth with one authoritative snapshot. It passes only when both criteria hold:

1. **Structural reset** — the target precedes an active `branch_summary` that leaves the spine, and projected summary depth does not grow. Equal depth passes only when the new snapshot replaces an old summary; a target after every active summary fails.
2. **Cold start** — a fresh agent can execute `NEXT` from the snapshot and direct evidence pointers. The snapshot or pointers contain every surviving front, invariant, external effect, and recovery path; ordinary execution needs no archived summary.

Build the snapshot once. Evaluate candidates from earliest to latest and choose the first that passes both criteria. If none passes, keep required detail live, use a local fold, or accept native compaction.

### Handoff contract

Every handoff uses these seven slots in this order. Write `none` rather than omitting an empty slot.

```text
Goal: <current goal; quote a new triggering request when its turn will leave context>
State: <conclusions, decisions, status, key values and identifiers>
Evidence: <paths, commands, URLs, commits, errors, checkpoints or node IDs>
External: <file, process, browser, remote, ticket, or other side effects>
Exclusions: <dead ends and directions not to repeat, with reasons>
Recover: <archive checkpoint, backup label, or raw node pointer>
NEXT: <one executable verb + target>
```

Before travel, verify: `Goal` matches the active request; `State` carries every surviving front and invariant; `Evidence` and `Recover` name usable pointers; `External` records side effects; `NEXT` is immediately executable. The runtime validates slot structure, not semantic completeness.

After travel, confirm the resolved target, summary leaf, backup outcome, usage/message/summary-depth deltas, and context-sync state. Execute from the handoff branch. If `NEXT` opens a phase, checkpoint that phase first. Travel changes conversation context only; inspect external systems directly.

**CHECKPOINT-FIRST:** any tool or requested plan makes the goal Managed. Even “inspect/read now, fold later” starts by emitting `acm_checkpoint` alone. If that request explicitly requires a fold before answering, finish with one task-end travel rather than a `-done` checkpoint.
<!-- ACM:CORE:END -->

<!-- ACM:TOOL_CHECKPOINT:START -->
FIRST TOOL for each distinct managed goal—even when the request explicitly says to read, inspect, or run something before folding later. Call `acm_checkpoint` alone with a semantic `-start` name and wait for created/reused before `bash`, `read`, `write`, `edit`, `grep`, `find`, delegation, or other multi-action work. Immediate text-only answers need none. Also label resumable phase, burst, pause, and completion boundaries with semantic `-start`, `-paused`, or `-done` names. Names are tree-wide, unique, and case-sensitive.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Read one session-structure view: `active`, `checkpoints`, `search`, or `tree` (`active` by default). Use `checkpoints` for rebase candidates and projected depths, `search` to locate semantic anchors, and `tree` only for unresolved topology. This tool supplies evidence; choose targets by boundary and cold start.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
EXCLUSIVE fold/rebase into a seven-slot handoff. For a requested task-end fold, follow this order: checkpoint first, investigation tool(s), `acm_timeline` after findings are distilled, then `acm_travel` alone, then final answer with no more tools. The task-end backup name itself ends in literal `-done`, never `-done-backup`. Results report evidence, not semantic approval.
<!-- ACM:TOOL_TRAVEL:END -->

<!-- ACM:CUE_CHECKPOINT_START:START -->
Start boundary secured. Execute the managed goal. The last tool before final user-facing text MUST be a semantic `-done` checkpoint or valid task-end travel; for a text-only plan, prepare it internally, emit `-done`, wait, then answer.
<!-- ACM:CUE_CHECKPOINT_START:END -->

<!-- ACM:CUE_CHECKPOINT_DONE:START -->
Milestone archived. Use it as a recovery pointer. If this closes a stable chain or another fold would stack, run a rebase check before continuing.
<!-- ACM:CUE_CHECKPOINT_DONE:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
View `active` selected. Continue from the visible spine; inspect another view only when target identity or branch topology is not yet checkable.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Active summarized history is present. When the current event is a rebase trigger or the next fold would stack, test structural reset and cold start from the earliest safe base; root is a candidate, not a verdict.
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
Checkpoint the next phase before its first action, then execute the handoff NEXT.
<!-- ACM:CUE_TRAVEL_PHASE:END -->

<!-- ACM:CUE_TRAVEL_TASK:START -->
FINAL ANSWER: answer now using the handoff `Goal`, `State`, and `Evidence`. Do not checkpoint, reread, inspect timeline, or travel again; archived process stays behind `Recover`.
<!-- ACM:CUE_TRAVEL_TASK:END -->

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
Search existing checkpoints, preserve the semantic base, and add the smallest useful scope, ordinal, or date. Do not overwrite the existing recovery target.
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
