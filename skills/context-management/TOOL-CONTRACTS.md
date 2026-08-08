# ACM Tool Contracts

This file is the single source of truth for generated ACM tool descriptions, prompt snippets, prompt guidelines, result cues, manual navigation summary instructions, and recovery text (术). Judgment guidance lives in `CORE.md`. Generated TypeScript must be refreshed with `bun run generate:guidance`.

Layer responsibilities: descriptions = action + when + one key fact; parameter descriptions = pure mechanics; snippets = one-line scenario hooks; guidelines = trigger scenarios; cues = state transition + next action; recovery = concrete recovery steps. Every term appearing in any model-visible output must be taught by one of these surfaces or CORE (closed vocabulary).

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
Name the current conversation position so a later fold or travel can return to it. Instant and free; it marks a point in the conversation, not a file backup — it cannot undo commands or restore files. Omit `target` to mark the current position; pass a node ID or existing name to label an earlier one.
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
View the session. One view per call: `active` (what is in context now), `checkpoints` (save points with projected fold gains), `search` (whole-tree search, folded history included), `tree` (branch structure). Reports token usage.
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
Fold: return to `target` (checkpoint name, node ID, or 'root') and replace the active tail after it with your handoff — goal/state/next required; evidence/external/exclusions/recover optional. Omitted evidence, external, and exclusions are recorded as "none"; the automatic return ticket is added to Recover whether or not recover was supplied. The replaced history stays in the tree. A fold shrinks active context; travel to an archived branch grows it. Rewrites conversation context only — files, processes, and external systems keep their current state. Call it alone in its tool batch.
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
Save a named return point in conversation history (instant, changes nothing)
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
View context usage and save points; search folded history
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
Fold digested context into a handoff and continue lighter
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
Use acm_checkpoint at phase boundaries, validated baselines, and the start of uncertain directions or large ingests.
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
Use acm_timeline to choose a travel target and as the first source for details from folded history.
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
To fold, use acm_travel when the fold test passes — typically at a phase transition: exploration ends and editing begins, a plan settles into execution, a diagnosis becomes a fix, one component closes and the next opens, or a result becomes ready to deliver. A routine handoff can be just goal, state, and next; include each optional field that carries something.
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
Save point created; context unchanged. It now appears in the checkpoints view as a travel target — when the stretch it opens passes the fold test, this is the mark to fold back to.
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
Fold applied. The handoff is your working state: execute next. Folded details stay one travel away via the return ticket in Recover.
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
This is the current working set; stretches already distilled to their conclusions are fold candidates.
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
For a fold, choose an entry immediately before the material being replaced. Raw-archive aliases restore pre-fold history — travel to them to retrieve details.
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
Search covers the whole tree, folded history included; ACM's own tool receipts and provider-injected content are not searched. Node IDs in the results work directly as travel or checkpoint targets.
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
This is the session's branch structure; verify candidate ancestry before travel.
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

Injected as the full summarization prompt when the user navigates `/tree` with "Summarize" and provides no custom instructions, so native branch summaries carry the same handoff shape as travel handoffs. User-supplied instructions always win.

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
Summarize this abandoned conversation branch as a handoff for whoever returns to it.

Return exactly seven lines in this order, using only these field labels:

Goal: what this branch was trying to accomplish.
State: what was settled (with basis) and what stayed uncertain. Keep the exact file paths, symbols, and values that still matter.
Evidence: verifiable pointers — file paths, commands, IDs. Write none if empty.
External: current lasting side effects — files changed, processes started, or systems modified. Write none if empty.
Exclusions: directions already tested, their outcomes, and the resulting settled search space. Write none if empty.
Recover: the most useful save point name or node ID. Write none if empty.
NEXT: the most concrete next step when resuming this work.

Keep exact paths, function names, error messages, and numbers — they matter more than prose. Use compact, continuation-ready wording.
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
This name is taken. Keep the existing save point. For a return-ticket collision, retry acm_travel with a new unique backupCurrentHeadAs; for a checkpoint collision, pick a new checkpoint name (add a scope, number, or date).
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
The host lacks a required capability; nothing was changed. Report this error and verify the Pi version matches what this extension supports.
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
The return-ticket label is still in the tree. Note its name and entry ID before retrying.
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
The fold failed before changing anything; the return-ticket label was rolled back. Resolve the reported host error, then retry.
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
Automatic return-ticket rollback was unsafe, so the return-ticket label was kept. Note the return-ticket pointer, confirm your position with acm_timeline, then retry.
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
The fold is applied but the rebuilt context is not yet confirmed. If the next turn looks wrong, check sync state with acm_timeline.
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
This travel restored old history, so context grew. Retrieve the needed detail and travel back to your return point; if this branch is deliberately your new working state, continue here.
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
Context rebuild retries are exhausted. Reload the session, check sync state with acm_timeline, and confirm the active branch before continuing.
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
