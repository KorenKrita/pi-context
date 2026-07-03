---
name: context-management
description: "Self-manage your context window with checkpoints and time travel — a native ability, like reading files or running commands. CHECKPOINT (free, event-bound): at task start, each new user request, each phase's first action, before any tool call whose output you cannot bound (big reads, broad searches, logs, subagents), before risky steps, at milestones. FOLD (acm_travel back with a handoff summary) is the DEFAULT at these moments: a phase's conclusion is written and the next step uses it; an attempt failed or a direction proved wrong; bulky tool output is already distilled; a batch item finished; the task is complete and the final answer comes next — fold to '<task>-start' with backupCurrentHeadAs '<task>-done', THEN answer; a new user message arrives over unfolded finished work. No anchor before the noise? Raw node IDs from acm_timeline are valid travel targets — it is never too late. Skip a fold only when the preview shows almost no saving. Everything folded is recoverable forever; when unsure, fold."
---

# Context Management

Your context window is a finite working set. You manage it yourself, mid-task, without being asked and without asking permission. Three tools:

- `acm_checkpoint` — put a named anchor on a conversation node. Free: no branch, no summary, no context change.
- `acm_travel` — jump back to an anchor or any raw node ID. Your summary replaces everything after the target; the old path is preserved off-path forever.
- `acm_timeline` — see the tree with node IDs, the anchors, and what each fold would leave (`list_checkpoints: true`).

## Anchors

Fixed suffixes; the name encodes the anchor's future use:

- `<name>-start` — placed before work begins (task, phase, risky attempt, unbounded tool burst). Creating it is a promise: when that work ends, you travel back here to shed its trail.
- `<name>-done` — placed when results are in hand (milestone). Two uses: the retreat point for shedding whatever comes AFTER it, and the recovery bookmark for the raw work before it. At task end you do not create it by hand — the task-end fold creates it via `backupCurrentHeadAs` (fold moment 5).

Two rules that make anchors easy:

- **A fold target must sit before the noise you are shedding.** Pick the latest node that still holds everything you want to keep. (A task's own `-done` cannot clean that task — but it is exactly where to retreat when what follows goes wrong.)
- **Anchors are conveniences, not prerequisites.** `acm_travel` and `acm_checkpoint` accept any node ID from `acm_timeline`. A missing anchor never blocks a fold.

## Checkpoint moments

Checkpoint at every one of these events — it is free, and the only failure mode is a missing anchor when you want one:

- A new user message starts or redirects multi-step work → `<task>-start`.
- The first action of a phase (investigate, implement, validate, ...) is about to run → `<task>-<phase>-start`.
- A tool call whose output you cannot bound is about to run — big file read, broad search, log fetch, subagent → checkpoint first. You cannot know in advance which burst will flood the window; the anchor is your way back.
- A risky, destructive, or hard-to-redo step is about to run → checkpoint.
- A milestone landed — conclusion written, decision made, test passed → `<milestone>-done`. This is the retreat point if the next attempt fails.
- Switching away from work you will return to → `<task>-paused`.

## Fold moments — these are actions, not suggestions

At each of these events, calling `acm_travel` is the default. Not calling it is the exception.

1. **Phase turnover.** The conclusion of an investigation / reading / search phase is written down, and the next action uses the conclusion, not the raw pages → travel to that phase's `-start` before the next phase's first action. Do not wait for a new user message.
2. **Failed attempt or wrong direction.** An approach failed, or you realize the current direction is wrong → travel to where it started, immediately — do not keep walking a road you know is wrong. The summary records what failed and why it must not be retried.
3. **Bulky output distilled.** A tool burst (reads, searches, logs) flooded the window and you have extracted what you needed → travel to the pre-burst anchor, carrying the extract, then continue the same phase.
4. **Batch item done.** An item finished and more remain → travel to the method anchor, carrying only the tally and method refinements.
5. **Task complete — fold BEFORE the final answer.** One call, no separate `-done` checkpoint needed:

```javascript
acm_travel({
  target: "<task>-start",
  backupCurrentHeadAs: "<task>-done",  // creates the done-bookmark as part of the fold
  summary: "<filled template — must contain everything the final answer needs>"
});
```

Then give the final answer from the summary branch. The next task starts on a clean window. If the preview shows almost no saving: checkpoint `<task>-done` and just answer.

6. **Repair: new user message over unfolded finished work.** If earlier tasks were never folded (missed moment 5), fold before starting the new one. Target the finished chain's **earliest** `-start` — related tasks form one chain; retreat to where the chain began, not to the most recent task's anchor. Use `root` when several unrelated chains have stacked up. Quote the new request verbatim in the summary — it sits after the target and will leave context too.

**No anchor before the noise?** Three steps, never blocked: (1) `acm_timeline` — the active path with node IDs; (2) pick the last clean node before the wrong turn or the burst; (3) `acm_travel({ target: "<node-id>", ... })`.

The only valid reason to skip a fold moment: the fold preview shows the travel would save almost nothing. These are NOT reasons to skip — answer each with `backupCurrentHeadAs` plus the fold:

- "the details might be useful later" → backup, then fold; forward travel recovers everything.
- "the trail is not that long yet" → the preview number decides, not your impression.
- "I already checkpointed" → a checkpoint marks the fold target; it is not the fold.
- "I never anchored before the noise" → raw node IDs are valid targets.

## Why folding is always safe

Folding too eagerly costs one forward travel to the backup — no path is ever deleted. Folding too late costs the whole window. The two mistakes are not symmetric. When unsure, fold.

## Summary template

The summary IS your memory after the travel. Fill every slot; write "none" rather than deleting a slot:

```text
Task: <goal in one line; if a new user request triggered this fold, quote it verbatim>
Done: <what finished, with conclusions and key numbers / errors / IDs>
Files/External: <paths changed, processes started or stopped, remote/browser/ticket side effects — travel does NOT undo any of these>
Do not repeat: <dead ends already tried and why they failed>
Recover raw via: <backup label or checkpoint name on the path being left>
NEXT: <the single action to take immediately after landing>
```

Pointers, not dumps: file paths, IDs, URLs, commands to re-fetch — copy raw values only when small, volatile, or needed immediately.

## Reflex table

| Event | Action |
|---|---|
| New user message starting or redirecting multi-step work | checkpoint `<task>-start` |
| First action of a new phase about to run | checkpoint `<phase>-start`; fold the finished phase to its anchor first (moment 1) |
| Unbounded tool call about to run (big read, broad search, logs, subagent) | checkpoint |
| Risky or hard-to-redo step about to run | checkpoint |
| Conclusion written / decision made / test passed | checkpoint `<milestone>-done` — the retreat point if the next attempt fails |
| Next action uses a conclusion, not the raw trail that produced it | travel to the phase `-start` or pre-burst anchor (moments 1, 3) |
| Approach failed or direction proved wrong | travel to where it started — raw node ID if no anchor (moment 2) |
| Batch item finished, more remain | travel to the method anchor (moment 4) |
| Task complete, final answer next | travel to `<task>-start` with `backupCurrentHeadAs: "<task>-done"`, then answer from the summary branch (moment 5) |
| New user message over unfolded finished work | fold to the finished chain's earliest `-start` first (moment 6) |
| Need a travel target or lost orientation | `acm_timeline({ list_checkpoints: true })`, or the default view for node IDs |
| A summary dropped a detail you now need | re-fetch from pointers first; else forward travel to the backup (find it with `acm_timeline({ search })`) |

## After a travel

The injected summary is your new state — execute its NEXT step and checkpoint the new phase as you continue. If the fold closed a task (moment 5), the NEXT step is giving the final answer. Disk and external systems were not rolled back; inspect them directly when in doubt.

## Mechanics

- Checkpoint names are unique across the tree and case-sensitive; one node may hold multiple aliases. Omitting `target` auto-anchors the nearest meaningful USER/AI turn near HEAD; passing a node ID anchors any past node retroactively.
- Checkpoint results preview two fold targets — the nearest anchor (phase fold) and the chain's earliest `-start` (task fold). The preview measures; the fold moment picks the target.
- Travel target choice: the anchor that leaves the smallest context that still suffices. An older anchor plus a stronger summary beats a recent anchor plus stale baggage; `root` (the first top-level node) is right when the summary can carry everything.
- Travel can shrink or grow context: a later or off-path target restores raw history (that is how forward recovery works). Read `estimatedUsageAfter` and `structuralEffect` from the result.
- `acm_timeline` mode precedence: `list_checkpoints` > `search` (full tree, including off-path) > `full_tree` (truncates on deep trees) > default active path. Never conclude an anchor is missing from a truncated `full_tree`.
- Judge fill level only by reported usage numbers, never by file bytes or lines read.
- If the runtime auto-compacts, a `pre-compact-<timestamp>` checkpoint is created automatically; you can travel back to it.

## Scenario playbook

`references/playbook.md` works the fold moments through common shapes — research, development, wrong turns without anchors, plan-driven work, batch items, retries, task switching, async fronts — each with a filled summary template to copy. If your task matches none of them, the fold moments above apply directly.
