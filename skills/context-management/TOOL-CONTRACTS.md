# ACM Tool Contracts

This file is the single source of truth for generated ACM tool descriptions, prompt snippets, prompt guidelines, result cues, and recovery text. It owns invocation and observable mechanics; `CORE.md` owns representation and cadence judgment.

<!-- ACM:TOOL_CHECKPOINT:START -->
Preserve a valuable return state by requesting a semantic label without changing the active working set. Use when recoverability materially improves: a verified baseline, valuable fork, risky attempt entrance, parked front, durable milestone, or raw path that may be compressed. Omitting `target` labels the nearest meaningful USER/AI turn; an explicit checkpoint name or node ID can label older history.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
Orient within session topology and compression evidence through one view: `active`, `checkpoints`, `search`, or `tree`. Omit `view` for `active`. Use `checkpoints` or `search` to compare non-obvious anchors and `tree` only when ancestry, representation ownership, or competing fronts matter.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Commit one recoverable, batched representation update: fold at a compression seam or rebase competing handoffs. Carry the hot set, encode uncertainty faithfully, preserve provenance, and make `NEXT` immediately executable. The matching receipt establishes whether the working set changed.
<!-- ACM:TOOL_TRAVEL:END -->

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Preserve a return state when recoverability materially changes
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
Inspect topology, representations, and compression evidence
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Commit a batched fold or rebase; the receipt establishes the outcome
<!-- ACM:SNIPPET_TRAVEL:END -->

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
`acm_checkpoint` cadence follows recoverability delta. Names are recovery cues rather than state classifiers; the request asks for a label and its matching receipt establishes the outcome.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
`acm_timeline` reports factual topology and diagnostics. Representation quality, compression seams, attention yield, target safety, and continuation fidelity remain semantic judgments.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
`acm_travel` is autonomous by default and must run alone in its assistant tool batch. Only an explicit user instruction that the next response or context transition must not travel suspends it for that stated scope; the matching receipt establishes the outcome.
<!-- ACM:GUIDELINE_TRAVEL:END -->

<!-- ACM:CUE_CHECKPOINT:START -->
The matching receipt says the checkpoint was applied and the working set is unchanged. Continue from the current representation; create another checkpoint when the value of a distinct return state materially changes.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
`active` shows the current spine. Read it as the authoritative representation and hot set; inspect another view only when an anchor, archived source, ancestry, or representation owner remains uncertain.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Active handoff layers are visible. Check for representation competition: can one authoritative handoff retire repetition or split ownership while preserving every hot detail, front, invariant, evidence chain, and continuation path?
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
`checkpoints` shows named recovery candidates and projected depth. Compare the recovery meaning and compression seam of each candidate rather than choosing by recency or label alone.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
`search` finds semantic labels, node IDs, and content across the tree. Narrow until the last clean anchor before the process being replaced is identifiable; a current raw node ID is a valid fallback.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
`tree` exposes ancestry and representation ownership. Use topology to reject anchors inside the process being replaced or on another front, then return to the smallest evidence view needed.
<!-- ACM:CUE_TIMELINE_TREE:END -->

<!-- ACM:CUE_TRAVEL:START -->
The matching receipt says travel was applied. Treat the handoff as the authoritative representation; verify the resolved target, recovery pointer, summary leaf, context synchronization, and external effects, then execute `NEXT`.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
Search existing checkpoints, preserve the semantic base, and add the smallest useful scope, ordinal, or date. Keep the existing recovery target addressable.
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
The supported Host Bridge capability is unavailable or malformed. Preserve the current authoritative representation, report the named capability error, and verify the exact supported Pi version before retrying mutation.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
The backup label remains in the tree. Record its label and entry ID as a recovery pointer before any retry.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
Branch creation was not applied and the new backup label was rolled back. Correct the reported host failure before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Branch mutation or prior aliases make automatic backup rollback unsafe. Preserve the reported backup pointer and inspect the active leaf before retrying.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
Travel mutation landed, but rebuilt message evidence is pending. Use the reported summary entry as the fallback and inspect context synchronization if the next rebuild fails.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
Off-path travel restored raw history. Extract the exact detail needed, integrate the resulting knowledge into the authoritative representation, and preserve provenance for future rehydration.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context reconstruction exhausted bounded retries. Reload the session, inspect timeline synchronization, and resume only after the selected branch and handoff are authoritative.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
