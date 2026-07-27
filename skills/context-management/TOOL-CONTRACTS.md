# ACM Tool Contracts

Source for tool descriptions and cues. Regenerate with `bun run generate:guidance`.

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
Save a named recovery point in the session. Omit `target` to label the most recent completed message. Pass a checkpoint name or node ID to label a specific older point.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
View session structure and context usage. Views: `active` (current messages), `checkpoints` (saved points), `search` (find by label/ID/content), `tree` (full topology). Includes usage stats and sync state.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Compress conversation history into a structured handoff and continue from there. Provide a 7-field handoff (goal, state, evidence, external, exclusions, recover, next) that captures everything needed to continue. The old history stays in the tree for recovery. Must be the only tool call in its batch.
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Save a named recovery point
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
View session structure and usage
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Compress history into a handoff and continue
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
acm_checkpoint is cheap and has no side effects. Use it before risky operations or at natural boundaries.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
Use acm_timeline to check context usage and find save points. Views: active, checkpoints, search, tree.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
acm_travel compresses history — deliver any pending answer to the user first, then fold. The handoff's NEXT carries unfinished work forward.
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
Checkpoint saved. Context unchanged. You can use this as a travel target later.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
Travel complete. The handoff is now your working state — execute NEXT directly.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
Multiple summary layers detected. Consider rebasing to an earlier point if a single handoff could replace them all.
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_ADVANCED_TARGET_POINTER:START -->
Target is ambiguous. Use acm_timeline with search or tree view to find the right node ID.
<!-- ACM:CUE_ADVANCED_TARGET_POINTER:END -->

<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:START -->
Something went wrong. Check acm_timeline for current state before retrying.
<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
Shows the current message spine. Consider folding old completed work to free up context.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
Shows save points. Pick a travel target based on what comes after it, not by its name.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
Search results span the whole tree. Use node IDs from results as travel targets.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
Full tree topology. Don't travel to nodes inside the range you're trying to fold.
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
Summarize this conversation branch as a handoff.

Write these seven fields, one per line:

Goal: what this branch was working on.
State: what was figured out and what's still uncertain. Include specific files, values, and paths.
Evidence: file paths, commands, IDs that can be verified. Write 'none' if empty.
External: files changed, processes started, systems modified. Write 'none' if empty.
Exclusions: things tried that didn't work — don't repeat these. Write 'none' if empty.
Recover: useful checkpoint or node ID to return to. Write 'none' if empty.
NEXT: the single next action if this work resumes.

Keep exact file paths, function names, error messages, and numbers. Be concise.
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
That checkpoint name already exists. Pick a different name (add a number or date suffix).
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
Host capability unavailable. Cannot proceed with this operation.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
Backup label is still in the tree. Note its ID before retrying.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
Branch creation failed and was rolled back. Fix the underlying issue before retrying.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Automatic rollback was unsafe. Keep the backup pointer and check the active leaf manually.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
Travel succeeded but context rebuild is still pending. The summary entry is your fallback.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
Restored an old branch. Execute NEXT from the handoff. To go back, use the recover pointer as your next travel target.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context rebuild failed after retries. Reload the session and check timeline before continuing.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
