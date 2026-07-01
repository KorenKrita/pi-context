---
name: context-management
description: "Use this skill for multi-turn, phased, or noisy work: research/reading, debugging, plan-then-execute, retries/pivots, background or asynchronous work, handoffs, user decisions, task switching, repeated items, or repeated progress checks. It keeps the conversation as a clean working set with checkpoints, timeline review, and travel at continuation boundaries. Always use when resuming after timeline travel or when a long phase reaches a decision, handoff, validation, or task-switch boundary. Usually skip simple one-shot tasks."
---

# Context Management

Use this skill to keep the active conversation as a useful **working set** for the next step. Keep raw only the context that still needs direct reasoning; carry the rest as summarized task state when that is more efficient.

## Core concept: time travel

This skill gives you three capabilities:

1. **Checkpoint** — Mark a moment in the conversation with a semantic name. Zero cost: no context change, no branch, no side effect. Just a label you can return to later. **The same node may have multiple checkpoint aliases** (e.g. `parser-fix-start` and `pre-debug-anchor` on one turn); each name must still be unique across the session tree. **Create checkpoints liberally** — before noisy work, at phase boundaries, before risky attempts, after milestones. More checkpoints = more travel target options later.

2. **Timeline** — See the structure of your conversation as a tree. **Default mode shows the active path only** — the spine the LLM actually sees. Off-path `branch_summary` siblings appear as `[off-path]` footnotes at branch points, not inline in the main sequence. Use `list_checkpoints: true` to enumerate all checkpoint labels with on-path/off-path tags (preferred for deep trees). Use `full_tree: true` to browse all branches. **`search` scans the entire tree (active + off-path)** — use it to find backups and future checkpoints after traveling back.

3. **Travel** — Jump to any checkpoint or node ID, leaving a handoff summary as a bridge. This creates a new branch from that point. The old path is NOT deleted — it remains as an off-path branch visible in `full_tree`. You can always travel back to it later ("return to the future"). **Travel does not always shrink context.** Read `estimatedUsageAfter`, `estimatedEffect`, `sessionMessages`, and `structuralEffect` from the tool result immediately; run `acm_timeline` to confirm official token % (`usageAfter` stays pending until the next LLM context event).

### When to go back in time ("回到过去")

Go back when the current path is cluttered with noise and you need a cleaner working set:

- **After a failed approach**: travel to the pre-exploration checkpoint with a summary of what failed and why.
- **After completing a noisy phase**: travel to the pre-work checkpoint; raw trail becomes summary.
- **Before a new phase**: investigation done, implementation begins — travel to the investigation-start checkpoint.
- **When context is getting large**: travel to an earlier anchor to shed raw trail while keeping state summary.

Typical effect: **context shrinks** (`estimatedEffect: shrunk`) when the target is **before** the noisy segment.

### When to go forward ("前往未来")

Go forward when you need to access a path you previously left behind:

- **Revisiting a backup**: you traveled away from path X with `backupCurrentHeadAs`. Use `acm_timeline({ search: "..." })` to find that backup, or travel to an off-path checkpoint that still carries raw history.
- **Comparing approaches**: return to approach A's raw state from a backup or off-path node.
- **Recovering lost context**: travel to a node on an old path that still has the raw details.

Typical effect: **context grows** (`estimatedEffect: restored`) when the target is **after** heavy read/tool history.

### Benefits of time travel

- **Working-set control**: travel away from noise, or travel back to restore raw history when needed
- **Safe exploration**: checkpoint before risky work, travel back if it fails
- **Multiple approaches**: branch from the same anchor multiple times
- **Non-destructive**: old paths are never deleted, always recoverable via `full_tree` or `search`
- **Same node, multiple jumps**: unlimited travels to the same checkpoint create sibling branches

## Working-set model

Before choosing a tool, ask:

- What am I trying to do next?
- What facts, constraints, or artifacts must stay raw for that next action?
- What important data has a reliable external source I can re-check instead of carrying raw?
- What history is useful only as a conclusion, pointer, or state update?
- What history is process noise or stale baggage?

Classify context into:

- **Raw context:** user intent, constraints, code/log/error details, evidence, or plan text you expect to inspect directly soon.
- **State summary:** decisions, findings, lessons, changed files, validation status, source pointers, rejected leads, and next steps that can replace raw process.
- **Discardable process:** repetitive searches, verbose logs, abandoned hypotheses, false starts, and unrelated turns whose useful value is already captured or gone.

If the active context is already small, coherent, and directly useful for the next step, do not manage it just to be tidy.

## When to use

Use this mode when the work may outgrow one clean thread:

- search, research, browser work, or reading many files/logs/pages/results
- investigate -> decide -> execute -> validate
- plan -> implement -> verify
- background or asynchronous work, handoffs, user decisions, or delayed results
- multiple approaches, retries, failed branches, comparisons, or pivots
- repeated similar cases, tickets, reviews, or batch items
- a main task that may be interrupted by side tasks
- repeated progress/status checks that indicate active state is hard to track
- scattered threads that need cleanup before continuing
- debugging, troubleshooting, refactoring, migration, or code-facing work that may get noisy

If one of these clearly applies, take a structural action now, usually a checkpoint.

Usually skip this skill for one-shot reads, bounded summaries, direct rewrites, simple lookups, deterministic scripts, short tasks that can stay clean, or moments where the active context is already a good working set.

## Start-of-turn check

At the start of each new user message, classify it:

- **Same task / next phase:** continue; if the previous phase is complete and noisy, travel before the next phase.
- **Correction or follow-up:** usually answer from recent context; do not travel yet.
- **New task or direction shift:** if the previous task left a complete noisy segment, inspect timeline when anchors are unclear, then travel to a continuation anchor that gives the new task a clean working set.

Think of the tools as a phase pipeline: checkpoint marks anchors, work happens, timeline shows structure, and travel creates a new branch from the chosen anchor with a summary of what happened after it. The target is a working-set choice, not an age choice.

## Main loop

1. Before noisy work, create a semantic checkpoint as the first context-management action.
2. When the task shape is clear, read one matching scenario reference only if it will change tool timing, anchor choice, or summary content.
3. Add checkpoints at meaningful milestones. More checkpoints = more travel target options later.
4. Use `acm_timeline` when structure affects the next decision or travel target. Prefer `search` on large trees.
5. At continuation boundaries, run the travel gate before starting another phase.
6. After a successful travel, read `target`, `estimatedUsageAfter`, `estimatedEffect`, `sessionMessages`, and `structuralEffect` from the tool result; run `acm_timeline` to confirm official token % before continuing.

## Continuation boundaries

A continuation boundary is where the current phase has produced a stable result and the next action starts a different phase.

Examples: investigation -> implementation, implementation -> validation, failed validation -> next approach, user decision -> execution.

Do not ask only "is the whole task done?" Ask "will the next action start a new phase using the stable result of this phase?" If yes, this is often a travel boundary.

## Tool policy

### `acm_checkpoint`

**Zero cost. Create liberally.** More checkpoints means more options when you need to travel later.

Use semantic names such as `<task>-start`, `<task>-<phase>`, `<task>-<attempt>`, or `<task>-<milestone>`.

Omit `target` to auto-anchor the nearest meaningful **USER/AI** turn near HEAD (skips tool results, bash/custom/system messages, internal-tool-only AI turns **without visible text**, and empty messages). The tool result explains what was chosen and what was skipped. Explicit `target` may be any node ID (including tool results) but triggers a warning — prefer USER/AI turns for milestone anchors.

**Multiple aliases on one node:** calling `acm_checkpoint` again on the same entry with a **new unique name** adds an alias; existing names remain travel targets. Reusing an exact name on the same node is idempotent.

**Checkpoint names are case-sensitive** (`Parser-Start` ≠ `parser-start`). `acm_timeline` search matches checkpoint labels and content **case-insensitively**.

**`root` target:** resolves to the **first top-level tree node** when multiple roots exist; prefer explicit checkpoint names or node IDs when unsure.

**Milestone checkpoints:** auto-resolve may land on a short **meta-instruction** user line (e.g. "now create a checkpoint") instead of the assistant's status report (e.g. "loaded 438k across 5 files"). The label is still valid — everything **before** that node is in context when you travel there — but the timeline label can look misleading. For phase-complete anchors (`*-loaded`, `*-done`, `*-validated`), prefer an explicit `target` on the **substantive assistant or user turn** that marks the milestone, or call checkpoint immediately after that turn before more tool traffic accumulates.

### `acm_timeline`

Use as the structural view of the **active path** (default). The HUD shows context usage, active-path node count, off-path fork count, and a travel cue.

- **Default:** active path only; off-path summaries at branch points show as `[off-path]` footnotes. Set `verbose: true` to include ACM tool traffic and system/custom meta messages in the timeline.
- **`list_checkpoints: true`:** checkpoint catalog across the full tree — **one line per alias**, with `~msgs` and `~% est.` for travel planning (display capped at 50; use `search` to narrow). Preferred before `full_tree` on deep sessions. **`verbose` is ignored** in this mode.
- **`full_tree: true`:** render the full session tree (truncates by depth/line limit on large trees). **`verbose` is ignored** in this mode.
- **`search`:** **full-tree** search by checkpoint label, node ID, or content (includes off-path branches). Returns matching nodes without rendering the whole tree. **`verbose` is ignored** in this mode.

**Mode precedence** when multiple params are set (only one mode runs; others are ignored): `list_checkpoints` > `search` > `full_tree` > default active path. Example: `{ list_checkpoints: true, search: "foo" }` runs the checkpoint catalog filtered by `foo`; `{ search: "foo", full_tree: true }` runs search only.

Judge context size from `contextUsage` / HUD, not file bytes or read line counts.

#### Large / deep trees — do not browse with `full_tree`

`full_tree` is **bounded**: depth is capped (default/limit ≤ 50) and output stops around ~200 lines. Long off-path branches (many reads, retries, travels) will be **cut off**; checkpoints at the end of a deep branch may not appear at all. This is expected — not a missing checkpoint.

Use this order instead:

1. **Need checkpoint names or IDs?** → `acm_timeline({ list_checkpoints: true })`  
   Optional: `search: "partial-name"` to narrow. Shows up to 50; total count is always reported.
2. **Need one known anchor (including off-path)?** → `acm_timeline({ search: "acm-test-loaded" })`  
   Full-tree search; works after traveling back to find a future checkpoint or backup.
3. **Need local tree shape near the root?** → `acm_timeline({ full_tree: true, limit: 20 })`  
   Small depth only; treat as a sketch, not a complete map.
4. **Saw a truncation line in output?** → stop using `full_tree`; switch to `list_checkpoints` or `search`.

If you cannot find a checkpoint after travel, **search before assuming travel failed** — the anchor may sit on an off-path branch that `full_tree` never reached.

### `acm_travel`

Travel to a checkpoint or node ID with a handoff summary. The target becomes the branch point; only the path **after** the target is replaced by your summary. Everything on the path **up to and including** the target remains in context.

**Do not assume token usage drops.** The tool result reports `usageBefore` and synchronous **`estimatedUsageAfter`** / **`estimatedEffect`**; official `usageAfter` is `pending` until the next LLM context event. Use `sessionMessages` + `structuralEffect` for structural feedback; confirm token % with `acm_timeline`:

- `estimatedEffect` / `structuralEffect: shrunk` — message count (and estimated %) dropped (often traveled to an anchor before noisy work)
- `estimatedEffect` / `structuralEffect: restored` — message count grew (often traveled to an anchor after heavy raw history)
- `unchanged` — rare; verify with timeline

Typical travel boundaries: investigation -> execution, diagnosis -> fix, failed attempt -> next attempt, completed noisy task -> new user task.

`backupCurrentHeadAs` labels the nearest meaningful USER/AI message before travel — not the raw HEAD tool result. Read `backupEntryId` / `backupResolvedFromHead` in the tool result if HEAD was tool traffic. Note: if `branchWithSummary` fails after a backup label was written, the label remains on the tree.

Do not travel while exploration is still active, when the result is unstable, or just because the skill triggered.

After `acm_travel`, the session tree updates immediately; estimated usage is in the tool result, official token % confirms on the next `acm_timeline`. The branch summary entry may appear **before** the tool call in the session log — trust `target`, `summaryEntryId`, and `sessionMessages` from the tool result. `contextRefreshPending: true` means LLM messages rebuild on the next turn; if refresh fails, `acm_timeline` HUD shows `Context Sync: last travel refresh failed`.

## Travel gate

Before calling `acm_travel`, require all three:

1. The segment being left behind is noisy, stale, failed, or low-value in raw form.
2. You can restore useful task state in a clear summary.
3. There is an immediate continuation that benefits from the new working set.

If several checkpoint targets are possible, run `acm_timeline` first.

## Choosing target and backup

1. Name the immediate next action.
2. Decide what must remain raw vs become summary.
3. Pick the anchor that leaves the **smallest sufficient context** after summary injection (for going back), or the anchor that **restores required raw history** (for going forward).
4. Run `acm_timeline` when uncertain.

Use `backupCurrentHeadAs` to label the current HEAD before traveling — this is **not** the travel target. It is a recovery pointer on the path you are leaving.

## Travel summary contract

The summary is state needed to resume from the chosen anchor, not a transcript recap.

Context tools change conversation state, not the outside world. Files, processes, and remote state stay current.

A travel summary must restore: task state, external side effects, validation status, navigation pointers, and explicit next step.

Before traveling, check: stable state? real continuation? summary restores state after the anchor?

## After travel

1. Trust `target`, `estimatedUsageAfter`, `sessionMessages`, and `structuralEffect` from the tool result — never infer from parameter names alone. Run `acm_timeline` to confirm official token %; do not treat `usageAfter` as authoritative (it is pending).
2. Disk and external systems were not rolled back.
3. Return to a backup or off-path node only when raw context cannot be reconstructed cheaply.

## Common mistakes

Avoid:

- assuming travel always shrinks context
- confusing `backupCurrentHeadAs` with `target`
- trusting timeline `fromId` on summaries — use `branchPoint` / `origin` metadata
- treating `usageAfter` as authoritative — use `estimatedUsageAfter` immediately, then `acm_timeline` for official %
- using file bytes or read line counts instead of `contextUsage` to judge fill level
- using `full_tree` to scan an entire deep session — use `list_checkpoints` or `search` instead
- assuming a checkpoint is missing because `full_tree` was truncated
- assuming travel reverts files, processes, or remote services
