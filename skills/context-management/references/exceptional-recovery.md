# Exceptional Recovery

Use this reference only when an ACM result reports an exceptional outcome. CORE remains authoritative for the normal process; this file supplies bounded responses to observable failures and unusual structural effects.

## Travel failure

Do not continue from the requested destination or assume that history changed. Read the failure, then inspect the timeline to establish the active branch and target existence. Correct only the reported cause—such as an unknown target, invalid summary, or stale checkpoint name—and retry once the destination is verifiable. Preserve the failed result as evidence if the cause is not locally correctable.

## Rollback failure

A failed travel rollback means branch mutation may be partial. Stop all downstream work. Capture the reported original branch, attempted target, summary entry, and rollback error; inspect the timeline for the actual active leaf. Resume only after branch identity is established. If the original branch is reachable, return to it with a fresh handoff; otherwise preserve the current leaf, report the lost transition, and choose recovery from observed tree state rather than intent.

Travel never rolls back files, processes, browser state, commits, or remote effects. Inspect those systems directly whenever the exceptional result leaves their state uncertain.

## Context-refresh exhaustion

When the result reports that context refresh or model synchronization exhausted its retries, treat the conversation tree as mutated but the model context as stale. Do not issue semantic follow-up work. Preserve the destination and summary entry IDs, then trigger only the host-supported context rebuild or session restart path. After rebuild, verify the active branch and handoff before resuming its next action.

## Restored history

Travel can restore or grow raw history when the destination is later, off-path, or previously archived. If the result reports restored history or increased context usage:

1. Verify that the requested destination is active.
2. Decide whether the restored detail is required by the current action.
3. If required, continue without immediately folding it again.
4. If accidental, return to the prior summary checkpoint with a handoff that preserves the needed extract.

Increased usage is evidence about structure, not proof of failure.

## No-saving recovery

When a task-end travel preview or result shows no meaningful structural saving, do not travel merely to create an archive label. Create a unique semantic `<task>-done` checkpoint on the current branch and answer directly. If an attempted no-saving travel already landed, verify the surviving branch, preserve its summary entry as evidence, and avoid repeating the same no-op fold.
