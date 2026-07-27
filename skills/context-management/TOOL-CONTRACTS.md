# ACM Tool Contracts

This file is the single source of truth for generated ACM tool descriptions, prompt snippets, prompt guidelines, result cues, and recovery text. Generated TypeScript must be refreshed with `bun run generate:guidance`.

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
Save a checkpoint: attach a name to the current conversation state. You can return to this point later. Use this before risky operations, at milestones, or when you want a recovery point.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
View session history: shows the active conversation path, all save points, search results across the whole tree, or tree topology. Also shows context usage, summary depth, and sync state.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Fold old history into a summary: replaces an extraction-complete stretch of conversation with a handoff. The original history stays in the session tree, one travel away. The handoff must be complete enough that a fresh agent could continue from it. Travel must run alone in its assistant tool batch. The result is: applied, not applied, or indeterminate.
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Save a recoverable point without changing context
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
Inspect the session tree, usage, and travel evidence
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Fold old history into a summary handoff
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
acm_checkpoint is cheap and never changes the context. Names are just labels for finding your way back.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
Pick the timeline view based on what you need: active path, checkpoints, search, or tree.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
Travel is for packing up old history, not for delivering results. If you owe the user an answer, deliver it first — the handoff's NEXT carries what's still pending.
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
Checkpoint saved. The working set hasn't changed. You can return to this state later.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
Travel applied. The handoff is now your working set. Execute NEXT directly. Trust what the handoff says. Only verify one specific claim if it's genuinely uncertain.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
This spine has multiple summary layers. Consider whether a single fresh handoff at the earliest safe base would be better than stacking another layer.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_ADVANCED_TARGET_POINTER:START -->
If the fold target is still unclear, use acm_timeline search to find the right node.
<!-- ACM:CUE_ADVANCED_TARGET_POINTER:END -->

<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:START -->
If an error occurs, read the recovery guidance in the tool result and follow the instructions.
<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
This is the active conversation path. Check if old history could be folded to free up space.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
These are your save points. Each shows projected post-travel depth. Raw archive origins are for restore/rehydrate, not fold/rebase.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
Search results span the whole tree. Narrow down until you find the right node.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
This shows the tree structure. Find the right node, then switch to a narrower view.
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

Injected when the user navigates `/tree` with "Summarize" and no custom instructions. User instructions always win.

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
Summarize this abandoned conversation branch as a handoff for whoever returns to it later.

Write exactly these seven slots, once each, in this order, each starting its own line:

Goal: what this branch was trying to accomplish.
State: what was settled here, what stayed uncertain, and exact files/symbols/values still in play.
Evidence: pointers a reader can verify directly. Write 'none' if empty.
External: lasting side effects outside the conversation. Write 'none' if empty.
Exclusions: directions tried and closed here. Write 'none' if empty.
Recover: the most useful save point or node ID to return to. Write 'none' if empty.
NEXT: the single most concrete next action if this work resumes.

Preserve exact file paths, function names, error messages, and numbers. Keep the whole handoff compact.
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
Checkpoint name already exists. Use a different name or target.
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
Host capability is unavailable. Stop and report the error.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
Backup label still exists in the tree. Record it as a recovery pointer before retrying.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
Branch creation failed before mutation. The backup label was rolled back. Fix the reported error before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Automatic backup rollback was skipped. Keep the reported backup pointer and check the active leaf before retrying.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
Travel mutation landed but message rebuild is pending. Use the summary entry as fallback if the next rebuild fails.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
History restored from an off-path branch. Execute NEXT from the handoff. To return, use the named return pointer as the next target.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context rebuild exhausted retries. Reload the session and check timeline sync state before resuming.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
