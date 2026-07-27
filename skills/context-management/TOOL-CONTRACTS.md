# ACM Tool Contracts (草根版)

Single source of truth for generated tool descriptions, prompt snippets, guidelines, result cues, and recovery text. Regenerate with `bun run generate:guidance`.

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
Save a named restore point at the current position in the session. Free and instant; changes nothing in your context. Omit `target` to label the latest completed point (recommended); pass a node ID or existing checkpoint name to label an older point. Use before risky steps, before large reads you may fold away later, or at stable milestones.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Inspect the session. Pick one view: `active` (what's currently in context), `checkpoints` (saved restore points), `search` (find text/labels/node IDs anywhere in the tree, including folded history), `tree` (branch structure). Also reports token usage and sync status.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Shrink context by folding finished history: jump back to `target` (a checkpoint name, node ID, or 'root') and replace everything after it with your 7-field handoff summary. The full old history stays in the session tree and is recoverable. Only fold work that is finished — you must be able to write the handoff from memory without re-reading. Call this tool alone, not batched with other tool calls. Check the result: applied, not applied, or indeterminate.
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Save a named restore point (free, changes nothing)
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
Inspect session history, checkpoints, and token usage
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Fold finished history into a short summary to free context
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
acm_checkpoint is free and never changes context — when in doubt, save one.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
acm_timeline views: active = current context, checkpoints = restore points, search = find old details, tree = branch structure.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
acm_travel folds finished work; if you still owe the user an answer, deliver it first or put it in the handoff's next field — folding is not answering.
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
Checkpoint saved; context unchanged. You can return to this point later with acm_travel.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
Fold applied. Your handoff is now the working state — continue with its `next` action. Don't re-read the folded material to double-check; recover it only if a specific detail is actually missing.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Multiple fold summaries are now stacked on this path. Consider one consolidating fold: target an earlier clean point and write a single handoff that merges everything still relevant.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_ADVANCED_TARGET_POINTER:START -->
For tricky target-selection cases, load the `context-management` Skill (see its `location` in the Skills list) and read `references/target-selection.md` next to it.
<!-- ACM:CUE_ADVANCED_TARGET_POINTER:END -->

<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:START -->
Before retrying, load the `context-management` Skill (see its `location` in the Skills list) and read `references/exceptional-recovery.md` next to it.
<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
This is what's currently in your context. If a stretch of it is finished and only its conclusions matter, folding it with acm_travel will free space.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
These are your restore points. Pick a travel target by position — the last clean point before the material you want to fold. Raw-archive entries hold pre-fold history: use them to restore old detail, not as fold targets.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
Search covers the whole tree including folded history. A node ID from these results is a valid acm_travel or acm_checkpoint target.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
This is the branch structure. Use it to check ancestry before picking a travel target; then go back to a narrower view.
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

Injected as the summarization prompt when the user navigates `/tree` with plain "Summarize" and no custom instructions.

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
Summarize this abandoned conversation branch as a handoff for whoever returns to it later.

Write exactly these seven lines, in this order, no other headings:

Goal: what this branch was trying to accomplish.
State: what was settled (with evidence) and what stayed uncertain. Include exact files, symbols, and values still in play.
Evidence: verifiable pointers — file paths, commands, IDs. Write 'none' if empty.
External: lasting side effects — files changed, commands run, systems touched. Write 'none' if empty.
Exclusions: directions tried and closed, so a retry doesn't repeat them. Write 'none' if empty.
Recover: the most useful save point or node ID to return to. Write 'none' if empty.
NEXT: the single most concrete next action if this work resumes.

Keep exact file paths, function names, error messages, and numbers; they outrank prose. Keep it compact.
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
That name is taken. Keep the existing checkpoint and pick a new name (add a scope, number, or date).
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
The host doesn't expose the needed capability. Nothing was changed. Report the capability error; check the Pi version matches what this extension supports.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
The backup label is still in the tree. Note its name and entry ID before retrying.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
The fold failed before changing anything; the backup label was rolled back. Fix the reported host error before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Automatic backup rollback was unsafe, so the backup label was kept. Note the backup pointer and check the active leaf before retrying.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
The fold landed but the rebuilt context isn't confirmed yet. If the next turn looks wrong, check acm_timeline sync state.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
This travel restored old history (it grew context rather than shrinking it). If you came here to fetch one detail, grab it and travel back to your return checkpoint. Stay only if this branch is intentionally the new working state.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context rebuild retries are exhausted. Reload the session, check acm_timeline sync state, and continue once the active branch is confirmed.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
