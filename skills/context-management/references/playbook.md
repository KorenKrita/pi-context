# Scenario Playbook

Every task decomposes into the same primitives: a **start**, one or more **phases**, occasional **risky steps**, occasional **failures**, **milestones**, and sometimes a **switch** to other work. Anchors and folds attach to those primitives, not to task categories:

- Anchor every primitive you might return to: start, phase entry, pre-burst, pre-risk, post-milestone, pre-switch. Use the `-start` / `-done` naming from SKILL.md.
- Fold at the six fold moments: phase turnover, failed attempt or wrong direction, bulky output distilled, batch item done, task complete (before the final answer), repair on a new message over unfolded work. The fold preview number is the only skip condition.
- Every summary follows the template in SKILL.md — fill every slot.

The sections below work this through common shapes. They are illustrations, not a taxonomy: if your task matches none of them, apply the fold moments directly.

## Research and heavy reading

Search, web/browser work, reading many files/logs/pages. The trail is much larger than the conclusion.

- Checkpoint `<topic>-investigation-start` before the first pass, and checkpoint again before each burst you cannot bound — a big file read, a broad search, a log fetch. You cannot know in advance which burst floods the window; the anchor is your way back.
- Fold moment 3 fires mid-phase: a burst is distilled into an extract → travel to the pre-burst anchor carrying the extract, then continue the same phase clean.
- Fold moment 1 fires at phase end: the finding is written and the next step uses it — implement, answer, decide. Travel to the investigation anchor. This includes the next phase of the same request (found the API shape → now implement). Do not wait for a new user message.
- Research summaries fail when thin. "Found the answer" is not a summary — the template's `Done` slot must hold the finding itself with its key evidence.

```javascript
acm_travel({
  target: "timeout-investigation-start",
  backupCurrentHeadAs: "timeout-investigation-raw",
  summary: `Task: mitigate API timeouts.
Done: root cause is DB connection pool exhaustion. Evidence: pool wait timeouts in logs during peak; pool size 10 in config/db.yaml; no network errors found.
Files/External: none — investigation only, nothing changed.
Do not repeat: gateway timeout theory — it was downstream of DB waits, not a cause.
Recover raw via: timeout-investigation-raw (exact log lines, full config).
NEXT: propose pool sizing + queue mitigation and how to validate.`
});
```

## Development and debugging

Implementation, debugging, refactoring, migration, review.

- Checkpoint `<fix>-start` before serious work, before risky edits, before each alternative attempt; checkpoint `<milestone>-done` when a root cause is confirmed or a test passes — that `-done` is the retreat point if the next attempt fails.
- Fold moment 2 fires here: the moment an approach is abandoned, travel to the pre-attempt anchor (often the last `-done`). Never drag a dead attempt's raw trail into the next one.
- Fold moment 1 fires at phase turnover: debugging produced the diagnosis → fold before implementing; implementation done → fold before a long validation phase.
- Files and processes changed on disk stay changed — the `Files/External` slot must state the current on-disk state, and the `Done` slot what has and has not been validated.

```javascript
acm_travel({
  target: "memory-leak-fix-start",
  backupCurrentHeadAs: "memory-leak-weakref-raw",
  summary: `Task: fix memory leak in the object cache.
Done: WeakRef approach implemented and rejected — objects collected too early, cache hit rate collapsed.
Files/External: src/cache.ts reverted to pre-attempt state on disk; no processes running.
Do not repeat: WeakRef-based caching — early collection is inherent, not tunable.
Recover raw via: memory-leak-weakref-raw.
NEXT: implement object pooling in src/cache.ts.`
});
```

## Wrong direction, no anchor

You rarely know a direction is wrong before walking it, and you cannot always predict which tool result will be huge. Anchors help but are never required — the realization itself is the fold moment:

1. `acm_timeline` — the active path with node IDs.
2. Pick the last clean node before the wrong turn or the flood: a user turn, your own plan statement, any point that still holds everything you want to keep.
3. Travel to that node ID directly.

```javascript
acm_travel({
  target: "aBc123",  // last clean node before three wrong-direction searches
  backupCurrentHeadAs: "auth-refactor-wrong-turn-raw",
  summary: `Task: refactor auth middleware.
Done: ruled out the session-store as the coupling point — three searches confirmed sessions never touch the middleware chain.
Files/External: none changed.
Do not repeat: session-store direction — dead end, evidence in the backup.
Recover raw via: auth-refactor-wrong-turn-raw.
NEXT: trace the token-validation path in src/middleware/validate.ts instead.`
});
```

Do not keep walking a road you know is wrong just because the trail behind you is unanchored.

## Plan-driven execution

Work anchored to an explicit plan, roadmap, or todo list that execution keeps returning to.

- Checkpoint `plan-ready` when the plan is settled; checkpoint each phase start.
- After each subtask stabilizes and another remains, fold back to the plan-ready or phase anchor. The `Done` slot carries the plan's current status (done / in progress / remaining) so the plan itself survives the fold.
- On a material replan: summarize the direction change, checkpoint the new plan-ready state, continue from there.

## Repeated batch items

Many similar items (tickets, reviews, cases) processed with a reusable method. Fold moment 4.

- Checkpoint the batch start; checkpoint `<batch>-method-clear` once the first item teaches a reusable method.
- After every item: travel to the method anchor. Item-specific reasoning must not accumulate across items — the preview saving per item may look small, and the fold is still correct, because it compounds.

```javascript
acm_travel({
  target: "vendor-review-method-clear",
  summary: `Task: vendor review batch, 4 of 12 done.
Done: results logged in review-notes.md; item 4 flagged missing DPA. Method unchanged: SLA terms, then security addendum, then pricing deltas.
Files/External: review-notes.md updated on disk.
Do not repeat: none.
Recover raw via: none — per-item raw is disposable once logged.
NEXT: review vendor 5 with the same method.`
});
```

## Retry, branch, and pivot

Trying approaches A/B/C, comparisons, strategy changes. Cross-cutting: applies on top of any shape above.

- Always checkpoint before opening a risky branch — that anchor is what makes a clean retreat possible. A milestone `-done` behind you serves the same purpose.
- The moment a branch is decided (failed, won, or superseded), fold to the pre-branch anchor. Preserve what was tried, why it was rejected, what remains valid, and the chosen next approach.
- Multiple travels to the same anchor are fine — each creates a sibling branch (attempt 1, attempt 2, ...).

## Task end and task switching

Fold moments 5 and 6.

- **Task complete (moment 5):** fold BEFORE giving the final answer — one call, then answer from the summary branch:

```javascript
acm_travel({
  target: "cache-migration-start",
  backupCurrentHeadAs: "cache-migration-done",  // the done-bookmark, created by the fold itself
  summary: `Task: migrate the cache layer to Redis.
Done: migration complete; all 14 integration tests pass; cutover flag enabled in config/cache.yaml.
Files/External: src/cache/*.ts rewritten, config/cache.yaml updated, local Redis running via docker compose.
Do not repeat: none.
Recover raw via: cache-migration-done.
NEXT: give the user the final summary of the migration.`
});
```

  If the preview shows almost no saving, checkpoint `<task>-done` and just answer.
- **Repair (moment 6):** a new user message arrives and earlier finished work was never folded → fold before starting. Target the finished chain's **earliest** `-start`: related tasks form one chain, retreat to where the chain began, not to the most recent task's anchor. Use `root` when several unrelated chains have stacked up, with one capsule line per finished task in the summary. Quote the new request verbatim in the `Task` slot — it sits after the target and would otherwise leave context. If the path being left already has a `-done` or other checkpoint, that is the recovery pointer; add `backupCurrentHeadAs` only when the path is unlabeled.
- Before switching away from unfinished work: checkpoint `<task>-paused` so you can return.
- Adopting context management late in an already-messy thread: `acm_timeline` finds the best pre-noise node (any node ID works), then fold with a full-template summary. It is never too late.

## Interleaved async fronts

Background jobs, subagents, delayed results, user decisions — several overlapping lines of work in one thread.

Treat each line as a **front**. Keep at most one front raw (the one you are reasoning about now); park the rest as capsule lines inside your summaries:

```text
Front: docs-build | Goal: validate docs before publish | State: background build running
Stable result: source edits complete | Pointers: task docs-build, dist/docs/
Trigger: build exit status | Next: on success summarize validation; on failure inspect first error
```

- When a delayed result returns: capture it into its front, decide whether it interrupts the current focus, park it if not.
- Fold when switching fronts after a heavy phase, or when the middle of the thread is completed fronts. Interleaving makes recent anchors poor targets — an old anchor (even `root`) plus one capsule per live front is often the right fold.
- Before a deep fold, answer in the summary: which front is active, which are parked (with pointers), which are done, and the single NEXT action.

## None of these fit?

Identify the primitives in your task — where it starts, where phases turn over, what is risky, where milestones land, what counts as a switch — and attach the checkpoint moments and fold moments from SKILL.md to those events. The six fold moments plus the summary template are sufficient for any shape; the scenarios above are pre-worked answers for frequent ones.
