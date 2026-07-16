# Exceptional Recovery

Use this reference only when an ACM result reports an exceptional outcome. CORE remains authoritative for normal judgment; this file maps each observable failure state to one bounded recovery action.

## Travel failure

Hold ordinary work on the observed active branch. Read the failure, then inspect the timeline to establish the active leaf and target existence. Correct the reported cause—such as an unknown target, invalid summary, or stale checkpoint name—and retry only after the destination is verifiable. Preserve the failed result as evidence when the cause is not locally correctable.

## Backup rollback failure

This outcome means branch creation was not applied, but the newly created backup checkpoint could not be removed. Treat the branch as unchanged and the remaining backup label as a recovery pointer. Record its label and entry ID, resolve any label collision it creates, and retry only after the original failure is corrected.

## Indeterminate branch mutation

This outcome means mutation may have landed, so automatic backup rollback was skipped. Pause semantic work and inspect the actual leaf, summary entry, backup pointer, and context-refresh state. Continue from the observed branch when its handoff is authoritative; otherwise travel from that observed state to a verified recovery target. Disk, process, browser, commit, and remote state remain external and require direct inspection.

## Context-refresh exhaustion

Treat the conversation tree as mutated and the model context as stale. Preserve the destination and summary entry IDs, then use the host-supported session reload or context rebuild path. After rebuild, verify the active branch and handoff before resuming `NEXT`.

## Restored history

Travel can restore or grow raw history when the destination is later, off-path, or previously archived. When the result reports restored history or increased context usage:

1. Verify that the requested destination is active.
2. Decide whether the restored detail is required by the current action.
3. When required — an intentional rehydration — take the exact detail and continue the round trip.
4. When accidental, travel back to the prior summary save point with a handoff carrying only the needed extract.

Increased usage is structural evidence, not proof of failure.

## Low-yield fold

When a travel preview or result shows little structural saving, check whether the handoff still delivers a durable representation improvement. If it does, continue from the applied branch and let later work amortize the transition. If it does not, keep the current authoritative branch, keep integrating until a larger semantic batch is ready, and avoid repeating the same tiny fold. A save point is enough to mark a milestone; travel is never required merely to record completion.
