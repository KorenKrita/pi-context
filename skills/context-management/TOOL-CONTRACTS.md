# ACM Tool Contracts

This file is the single source of truth for generated ACM tool descriptions, prompt snippets, prompt guidelines, result cues, and recovery text. It owns invocation and observable mechanics; `CORE.md` owns semantic working-set judgment.

<!-- ACM:TOOL_CHECKPOINT:START -->
Request recoverability by attaching a semantic label to session history without changing the active working set. Use before a distinct or risky expansion, when parking a front, or when raw history may later leave context. Omitting `target` labels the nearest meaningful USER/AI turn; an explicit checkpoint name or node ID can label older history.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Inspect session topology and working-set evidence through one view: `active`, `checkpoints`, `search`, or `tree`. Omit `view` for `active`. Use `checkpoints` or `search` to compare non-obvious anchors and `tree` only when branch ownership or ancestry matters.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Request one recoverable context transition: fold a named closed boundary or rebase accumulated handoffs. Travel is ready only when active uncertainty and live evidence chains survive, omitted detail has a recovery pointer, and the handoff passes cold start.
<!-- ACM:TOOL_TRAVEL:END -->

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Request a recoverable history label without changing context
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
Inspect session topology and working-set evidence
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Request a fold or rebase; the receipt establishes the outcome
<!-- ACM:SNIPPET_TRAVEL:END -->

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
`acm_checkpoint` names are recovery cues, not state classifiers. A checkpoint neither closes nor folds a boundary; the request asks for a label and its matching receipt establishes the outcome.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
`acm_timeline` reports factual topology and diagnostics. Boundary closure, active uncertainty, target safety, and cold start remain semantic judgments.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
`acm_travel` has two moments: user authorization permits the request; its matching receipt establishes the outcome. Run the request alone in its assistant tool batch.
<!-- ACM:GUIDELINE_TRAVEL:END -->

<!-- ACM:CUE_CHECKPOINT:START -->
The matching receipt says the checkpoint was applied and the working set is unchanged. This is a bookmark, not a closing bracket; continue, hold, or close the boundary according to active uncertainty.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
`active` shows the current spine. Read it as the live working set; inspect another view only when a boundary, recovery pointer, or branch owner remains uncertain.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Active handoff layers are visible. Check for real summary debt: can one authoritative cold-start handoff replace obsolete layers without losing a front, invariant, or live evidence chain? Pressure or depth alone is not permission to travel.
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
The matching receipt says travel was applied. Treat the handoff as the new working set; verify the resolved target, recovery pointer, summary leaf, context-sync state, and external effects before executing NEXT.
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
