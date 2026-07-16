# Exceptional Recovery

Use this reference only when an ACM result reports an exceptional outcome. CORE remains authoritative for normal representation and cadence judgment; this file maps each observable failure state to one bounded recovery action.

## Travel failure

Preserve ordinary work on the observed active branch. Read the failure, then inspect the timeline to establish the active leaf and target existence. Correct the reported cause—such as an unknown target, invalid summary, or stale checkpoint name—and retry when the destination and handoff are verifiable. Preserve the failed result as evidence when the cause is not locally correctable.

## Backup rollback failure

This outcome means branch creation was not applied, but the newly created backup checkpoint could not be removed. Treat the branch as unchanged and the remaining backup label as a recovery pointer. Record its label and entry ID, resolve any label collision it creates, and retry after the original failure is corrected.

## Indeterminate branch mutation

This outcome means mutation may have landed, so automatic backup rollback was skipped. Pause semantic work and inspect the actual leaf, summary entry, backup pointer, and context-refresh state. Continue from the observed branch when its handoff is authoritative; otherwise travel from that observed state to a verified recovery target. Disk, process, browser, commit, and remote state remain external and require direct inspection.

## Context-refresh exhaustion

Treat the conversation tree as mutated and the model context as stale. Preserve the destination and summary entry IDs, then use the host-supported session reload or context rebuild path. After rebuild, verify the active branch and authoritative representation before resuming `NEXT`.

## Restored history

Travel can restore or grow raw history when the destination is later, off-path, or previously archived. When the result reports restored history or increased context usage:

1. Verify that the requested destination is active.
2. Extract the exact detail required by the current decision.
3. Integrate the resulting knowledge into the authoritative representation with its provenance.
4. Return to the intended representation unless the restored branch intentionally becomes authoritative.

Increased usage is structural evidence, not proof of failure.

## Low-yield transition

When a travel preview or result shows little attention gain, inspect whether the handoff still delivers a durable representation improvement. If it does, continue from the applied branch and let later work amortize the transition. If it does not, preserve the current authoritative branch, integrate a larger semantic batch, and avoid repeating the same tiny fold. A pattern of immediate refolds, recalls, or rereads is compression thrash evidence, not a global reason to suppress travel.
