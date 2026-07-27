# ACM Tool Contracts

## Tool descriptions

### acm_checkpoint
Save a named bookmark at a point in the session. Omit target to mark the latest completed message; pass a checkpoint name or node ID to mark an older point.

### acm_timeline
View session state. Views: active (current messages), checkpoints (saved bookmarks), search (find by name/ID/content), tree (full structure). Shows usage stats.

### acm_travel
Compress old conversation into a handoff summary and continue from a clean point. Provide a 7-field handoff (goal, state, evidence, external, exclusions, recover, next). Old history stays archived. Must run alone.

## Prompt snippets

- checkpoint: Save a named bookmark
- timeline: View session structure and usage
- travel: Compress history into a handoff and continue

## Prompt guidelines

- checkpoint: acm_checkpoint is cheap and safe. Use before risky steps or at natural boundaries.
- timeline: Use acm_timeline to check usage and find saved points. Views: active, checkpoints, search, tree.
- travel: acm_travel compresses history. Deliver any pending answer to the user first, then fold.

## Result cues

- checkpoint: Checkpoint saved. Context unchanged.
- travel: Travel complete. Execute NEXT from the handoff directly.
- rebaseCheck: Multiple summary layers — consider rebasing to an earlier point.
- timelineActive: Current messages. Fold old completed work to free space.
- timelineCheckpoints: Saved bookmarks. Pick a travel target by what comes after it.
- timelineSearch: Search full tree. Use node IDs from results as travel targets.
- timelineTree: Full tree topology. Don't travel into the range you're folding.

## Recovery guidance

- nameCollision: That name already exists. Pick a different one.
- hostCapability: Host capability unavailable. Cannot proceed.
- rollbackFailed: Backup label remains in the tree. Note its ID before retrying.
- branchRolledBack: Branch creation failed and was rolled back.
- rollbackSkipped: Auto rollback was unsafe. Check manually.
- refreshPending: Travel succeeded but context rebuild is pending.
- restoredHistory: Restored old branch. Execute NEXT.
- refreshExhausted: Context rebuild failed after retries. Reload and check timeline.
