# Boundary Playbook

Read this before acting when target selection is non-obvious, fronts are interleaved, an anchor is missing, archived detail must be recovered, task-end travel would save almost nothing, or a checkpoint name collides. The main skill owns the rules; this file adds decisions and worked examples.

## Decision tree

Ask in order:

1. Does `NEXT` still need the raw detail? Keep it live; checkpoint if useful.
2. Is the final answer next, or did a new request arrive after finished work? **Task chain.**
3. Was temporary output distilled into findings, paths, errors, or IDs? **Burst.**
4. Was an attempt rejected, falsified, or superseded? **Failed direction.**
5. Is one repeatable item done while more remain? **Batch item.**
6. Will `NEXT` use a conclusion rather than its trail? **Phase.**
7. None fit? Keep the context live and checkpoint the next stable point.

Before travel: name the boundary, choose a target before it, reject anchors from the wrong front, and confirm one executable `NEXT`. Nearest and earliest anchors are candidates, not defaults. **Preview measures; boundary decides.**

## Filled handoffs

Each example demonstrates information density and fact placement; adapt its shape to the current boundary.

### Burst → implementation

```text
Goal: Fix excessive CPU use while preserving the sidebar.
State: Profiling confirmed hidden tabs keep rendering and retain workers; implementation is next.
Evidence: src/sidebar/session-manager.ts; artifacts/sidebar-profile.json; `bun test sidebar`.
External: No files changed; profiler stopped.
Exclusions: Preserve the sidebar; disabling or killing it violates the goal.
Recover: checkpoint sidebar-profile-start; raw profiling trail is archived.
NEXT: Checkpoint sidebar-lifecycle-fix-start, then inspect tab disposal in src/sidebar/session-manager.ts.
```

Travel to `sidebar-profile-start`. Because `NEXT` starts a phase, checkpoint it before inspecting the file.

### Failed direction → next attempt

```text
Goal: Stop duplicate API requests after session restore.
State: Disabling the response cache did not change request count; duplication occurs before cache lookup.
Evidence: logs/restore-debug.log; test restore-replay shows two dispatch calls.
External: Debug logging remains enabled in config/local.json.
Exclusions: Cache invalidation is ruled out; both requests enter dispatch independently.
Recover: cache-hypothesis-start; backup cache-hypothesis-done.
NEXT: Checkpoint dispatch-replay-start, then trace callers of dispatchRestoredRequest.
```

Travel to `cache-hypothesis-start`. Put the rejected approach in `Exclusions`, and surviving facts in `State` and `Evidence`.

### Batch item → reusable method

```text
Goal: Migrate twelve provider fixtures to the normalized schema.
State: Items 1-4 pass; eight remain. Method: rename model_id, normalize headers, run the fixture test.
Evidence: fixtures/providers/a.json through d.json; `bun test provider-fixtures`.
External: Four fixture files changed; no remote changes.
Exclusions: Provider C uses the standard parser; a stale snapshot caused its failure.
Recover: checkpoint migration-method-ready.
NEXT: Migrate fixtures/providers/e.json with the established method.
```

Travel to `migration-method-ready`. Preserve the tally and method, not item-specific exploration.

### Finished chain → new request

```text
Goal: Release fix complete. New request: "Add a dry-run mode to the migration command."
State: Validation passed and v2.4.1 was pushed; migration work has not started.
Evidence: commit 1a2b3c4; `bun test`; tag v2.4.1.
External: Commit and tag pushed to origin.
Exclusions: The version-detection workaround remains rejected.
Recover: backup release-fix-done.
NEXT: Checkpoint migration-dry-run-start, then inspect the migration command entry point.
```

Travel to `release-fix-start` with `backupCurrentHeadAs: "release-fix-done"`. Quote the triggering request because its turn leaves context.

## Interleaved fronts

1. List active, parked, and completed fronts.
2. Compress one named front at a time.
3. Choose that front's pre-boundary anchor or raw node, even when another front has a newer checkpoint.
4. Use an older anchor or `root` only when the handoff can carry a small capsule for every surviving front.
5. Give parked fronts state and recovery pointers, but keep one global `NEXT`.

```text
State: Active — auth retry. Parked — release notes awaiting CI. Done — provider audit.
Evidence: Auth: src/auth/retry.ts. Release: run 4182. Audit: docs/provider-audit.md.
Recover: auth-trace-done; release-notes-paused; provider-audit-done.
NEXT: Add the bounded retry guard in src/auth/retry.ts.
```

## Missing anchor

1. If orientation is poor, checkpoint the current meaningful turn as an archive pointer.
2. Call `acm_timeline`; on large trees prefer `list_checkpoints` or `search` before `full_tree`.
3. Find the last clean node before the named boundary.
4. Confirm it is outside the material being folded.
5. Travel to that raw node ID with the handoff.

The target is the last clean node outside the boundary; a labeled node inside the burst, phase, or failed attempt is invalid.

## Recover archived detail and return

Recovery is a round trip:

1. Checkpoint the summary branch as `<front>-resume`.
2. Travel to the archive pointer with a temporary handoff whose `NEXT` is the exact lookup.
3. Extract only the needed value, wording, error, or reasoning.
4. Travel back to `<front>-resume` with that extract and its evidence pointer.
5. Confirm structural effect and refresh/sync status; resume the original `NEXT`.

```javascript
acm_checkpoint({ name: "parser-fix-resume" });
acm_travel({ target: "parser-investigation-done", summary: "<lookup handoff>" });
// Recover: Unexpected token at byte 418.
acm_travel({ target: "parser-fix-resume", summary: "<resume handoff carrying byte 418>" });
```

Return to `<front>-resume` before unrelated implementation. Stay on the archive branch only when intentionally abandoning the summary branch.

## Task end with almost no saving

If the final answer is next and preview shows almost no saving, create a unique `<task>-done` checkpoint and answer directly. If saving is meaningful, use task-end travel with `backupCurrentHeadAs` and answer from the handoff branch.

## Checkpoint name collision

Names are tree-wide, unique, and case-sensitive. Search existing names, preserve the semantic base, then add the smallest useful scope, ordinal, or date:

```text
parser-fix-api-v2-start
release-validation-20260710-start
sidebar-power-investigation-2-start
```

Generic names such as `checkpoint-1`, `new-start`, or `temp-done` carry no recovery meaning.

## Failure patterns

- **Anchor gravity** — choosing the nearest checkpoint before naming the boundary.
- **Preview authority** — allowing estimated saving to define the boundary.
- **Premature fold** — removing detail still needed by `NEXT`.
- **Placeholder handoff** — writing field labels instead of conclusions and pointers.
- **Competing NEXTs** — assigning several fronts immediate actions.
- **Archive drift** — recovering detail, then accidentally continuing on the archive branch.
- **Task-end no-op** — traveling when a done checkpoint preserves the same working set.
