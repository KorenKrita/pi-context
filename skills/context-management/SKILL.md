---
name: context-management
description: "Resolve advanced ACM cases: ambiguous earliest-safe-base selection, interleaved fronts, missing anchors, archive round trips, checkpoint-name collisions, and exceptional mutation or context-sync results. Use only when the always-on CORE normal path cannot complete the current decision."
---

# Advanced Context Management

The always-on **CORE owns the normal path**: the working-set invariant, decision smells, recognizable moments, fold and rebase gates, ordinary checkpointing, clear phase folds, clear burst folds, rebase checks under pressure, task-end handling, and an obvious rebase all stay there. This Skill resolves one advanced condition at a time when CORE's gates pass but the decision remains ambiguous or a result reports an exceptional outcome.

Select the reference whose observable condition is active:

- Load [Advanced Target Selection](references/target-selection.md) when the fold boundary or rebase trigger is known but the target remains ambiguous because candidate chronology, front ownership, an older or missing anchor, raw-node fallback, or a checkpoint-name collision must be resolved.
- Load [Archive Recovery](references/archive-recovery.md) when one exact archived detail must be fetched and ordinary work must resume on the current summary branch.
- Load [Exceptional Recovery](references/exceptional-recovery.md) when a result reports travel failure, backup rollback failure, indeterminate branch mutation, exhausted context refresh, restored or grown history, or a task-end fold with no meaningful saving.

Load one reference at a time. If the observable condition changes, return to this router and replace the active reference instead of accumulating playbooks. Routing is complete when the current condition has one matching reference—or CORE already handles it—and no unrelated reference is loaded.
