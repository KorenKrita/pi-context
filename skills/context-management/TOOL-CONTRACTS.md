# ACM Tool Contracts

This file is the single source of truth for generated ACM tool descriptions, prompt snippets, prompt guidelines, result cues, and recovery text (术). It owns invocation and observable mechanics; `CORE.md` owns judgment about the working set and cadence (道 and 度). Generated TypeScript must be refreshed with `bun run generate:guidance`.

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
Save point: attach a semantic label to a session node without changing the active context. Never blocks or folds anything — it makes recovery, forks, and bold compression cheap. Use before a risky attempt, at a validated baseline, before a fork in strategy, when parking a front, or before raw history is folded away. Names are unique and case-sensitive across the whole session tree ('root' is reserved); name the state a future search should find. Omitting `target` labels the nearest meaningful USER/AI turn; an explicit checkpoint name or node ID labels older history.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Orient: inspect the session tree and context economics through one view — `active` (default; the spine the model actually sees), `checkpoints` (save points with projected post-travel summary depth), `search` (find labels, node IDs, or content across the whole tree), or `tree` (topology, when ancestry or branch ownership matters). The HUD reports usage, ACM pressure, summary depth, and sync state. Timeline reports facts; which fold, target, or cadence they justify stays your judgment.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Rewrite the working set through one recoverable transition: fold finished process into its handoff, rebase stacked summaries onto an earlier base, or rehydrate an archived branch. The handoff must pass cold start — a fresh agent could continue from it and its pointers alone — carrying knowns, open unknowns, the hot set, and one executable NEXT. Target the last clean node before the material being folded; for a rebase, prefer the earliest base whose projected summary depth does not grow. Travel must run alone in its assistant tool batch. The result is the only fact: applied, not applied, or indeterminate.
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Save a recoverable point without changing context
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
Inspect the session tree, usage, and travel evidence
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Fold, rebase, or rehydrate the working set through a cold-start handoff
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
acm_checkpoint is cheap and never mutates context: save before risk, forks, baselines, and folds. Names are recovery cues, not workflow states.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
acm_timeline reports facts — spine, save points, summary depth, usage. Judgment about folding, targets, and cadence stays with the agent.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
acm_travel is autonomous by default; only an explicit user request to hold travel suspends it, and only for the scope the user names.
Run acm_travel alone in its assistant tool batch, and read its result before building on the new context.
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
Save point applied; the working set is unchanged. This state is now cheap to return to — explore or compress boldly. When the raw process behind this point stops earning its place, acm_travel targeting it folds that process into a handoff.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
Travel applied: the handoff is now the working set. Verify target, summary leaf, backup, and sync state from this result, then execute NEXT. Files and external systems kept their state — inspect them directly, and rehydrate the archive if one exact detail is missing.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
This spine already carries handoff layers; the next fold would stack another. Weigh a rebase: one handoff at the earliest base that passes cold start without growing projected depth. Root is a candidate, never a default.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
`active` is the spine the model sees. If sediment is visible — distilled bursts, rejected directions, finished phases — weigh a fold; otherwise continue working.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
`checkpoints` lists save points with projected post-travel depth. Choose a target by what it precedes, not by how recent or well named it is — anchor gravity misleads.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
`search` spans the whole tree. Narrow until the last clean node before the material being folded is identifiable; a raw node ID from this result is a valid target.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
`tree` shows ancestry and branch ownership. Reject targets inside the material being folded or on another front, then return to a narrower view.
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

Injected as the full summarization prompt when the user navigates `/tree` with "Summarize" and provides no custom instructions, so native branch summaries carry the same cold-start shape as travel handoffs. User-supplied instructions always win.

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
Summarize this abandoned conversation branch as a handoff for whoever returns to it later.

Write exactly these seven slots, once each, in this order, each starting its own line, with no other headings:

Goal: what this branch was trying to accomplish.
State: what was settled here, with the evidence that settled it, and what stayed uncertain, marked as such. Include the exact files, symbols, and values still in play.
Evidence: pointers a reader can verify directly — file paths, commands, IDs. Write 'none' if empty.
External: lasting side effects outside the conversation — files changed, commands run, systems touched. Write 'none' if empty.
Exclusions: directions tried and closed here, so a retry does not repeat them. Write 'none' if empty.
Recover: the most useful save point or node ID to return to. Write 'none' if empty.
NEXT: the single most concrete next action if this work resumes.

Preserve exact file paths, function names, error messages, and numbers; they outrank prose. Keep the whole handoff compact.
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

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
Off-path travel restored raw history. Take the exact detail this rehydration came for, then travel back to the summary branch unless this branch intentionally becomes the new working set.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context reconstruction exhausted bounded retries. Reload the session, inspect timeline sync state, and resume only after the selected branch is authoritative.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
