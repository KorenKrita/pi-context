---
name: context-management
description: "Resolve advanced ACM cases: non-obvious target selection, interleaved fronts, missing anchors, archive round trips, checkpoint-name collisions, and exceptional travel or recovery results. Use only when the always-on CORE normal path cannot be applied directly."
---

# Advanced Context Management

The always-on **CORE owns the normal path**. Do not reconstruct it here or load this Skill for ordinary checkpointing, clear phase folds, clear burst folds, pressure checks, or task-end handling.

Load exactly one reference when its observable condition is true:

- Load [Advanced Target Selection](references/target-selection.md) when the boundary is known but the target is ambiguous because fronts are interleaved, a suitable anchor is older or missing, only a raw node may fit, or a checkpoint name collides.
- Load [Archive Recovery](references/archive-recovery.md) when one exact detail must be fetched from an archived branch and work must then resume on the current summary branch.
- Load [Exceptional Recovery](references/exceptional-recovery.md) when an ACM result reports travel failure, rollback failure, exhausted context refresh, restored or grown history, or a task-end fold with no meaningful saving.

Each reference is self-contained for that cognitive task. Stop after the selected reference; loading the others adds unrelated branches.
