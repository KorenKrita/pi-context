---
name: context-management
description: "Self-manage your context window with checkpoints and time travel — a native ability, like reading files or running commands. Two reflexes, both bound to events, not judgment. CHECKPOINT (free, always): at task start, at each new user request, before each phase's first action, before risky steps, after milestones. FOLD (acm_travel back to the phase anchor with a handoff summary) at these moments: a phase produced its conclusion and the next step acts on it; an attempt failed and you switch approach; a batch item finished; a new user message starts unrelated work. Folding is the default action at those moments — skip only when the fold preview shows almost no saving. Everything folded is recoverable forever; a bloated window is not. When unsure, fold."
---

# Context Management

Your context window is a finite working set. You manage it yourself, mid-task, without being asked and without asking permission. Three tools:

- `acm_checkpoint` — put a named anchor on a conversation node. Free: no branch, no summary, no context change.
- `acm_travel` — jump back to an anchor. Your summary replaces everything after it; the old path is preserved off-path forever.
- `acm_timeline` — see the tree, the anchors, and what each fold would leave (`list_checkpoints: true`).

## Two kinds of anchors

Fixed suffixes. The name decides the anchor's future use — decide at creation time, not later:

- `<name>-start` — a fold target. Creating it is a promise: when this phase or task ends, you WILL travel back here. Place it before the first action of the work it covers.
- `<name>-done` — a recovery bookmark on finished work. NEVER a fold target: the noise sits before it, so traveling to it cleans nothing.

## Checkpoint moments

Checkpoint at every one of these events. It is free; the only failure mode is a missing anchor when you need one.

- A new user message starts or redirects multi-step work → `<task>-start`.
- The first action of a phase (investigate, implement, validate, ...) is about to run → `<task>-<phase>-start`.
- A risky, destructive, or hard-to-redo step is about to run → checkpoint.
- A milestone landed — conclusion written, decision made, test passed, item finished → `<milestone>-done`.
- Switching away from work you will return to → `<task>-paused`.

Forgot to checkpoint? User turns are implicit anchors and `acm_travel` accepts raw node IDs from `acm_timeline` — it is never too late to fold.

## Fold moments — these are actions, not suggestions

At each of these events, calling `acm_travel` is the default. Not calling it is the exception.

1. **Phase turnover.** You wrote down the conclusion of an investigation / reading / search phase, and the next action uses the conclusion, not the raw pages → travel to that phase's `-start` NOW, before the first action of the next phase. Do not wait for a new user message.
2. **Failed attempt.** An approach failed and you are switching to another → travel to the pre-attempt anchor. The summary records what failed and why it must not be retried.
3. **Batch item done.** An item finished and more remain → travel to the method anchor, carrying only the tally and method refinements.
4. **Unrelated new task.** A new user message starts work unrelated to the previous, finished task → travel the old task to its `-start` (or `root` if several stale tasks have stacked up) BEFORE starting. Quote the new request verbatim in the summary — it sits after the target and will leave context too.

The only valid reason to skip a fold moment: the fold preview shows the travel would save almost nothing. Then checkpoint and continue. These are NOT reasons to skip — answer each with `backupCurrentHeadAs` plus the fold:

- "the details might be useful later" → backup, then fold; forward travel recovers everything.
- "the trail is not that long yet" → the preview number decides, not your impression.
- "I already checkpointed" → a checkpoint marks the fold target; it is not the fold.

One task-end exception: task fully done, final answer about to be given, no known next work → checkpoint `<task>-done`, answer, wait. That skipped fold is owed at the next user message.

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
| First action of a new phase about to run | checkpoint `<phase>-start`; if the previous phase has an anchor, fold to it first (fold moment 1) |
| Risky or hard-to-redo step about to run | checkpoint |
| Conclusion written / decision made / test passed | checkpoint `<milestone>-done` |
| Next action uses a conclusion, not the raw trail that produced it | travel to the phase `-start` |
| Approach failed, switching to another | travel to the pre-attempt anchor |
| Batch item finished, more remain | travel to the method anchor |
| New user message, previous task finished and unrelated | travel the old task away first; new request goes verbatim into the summary |
| Final answer about to be given, no known next work | checkpoint `<task>-done`, answer, wait — the fold is owed at the next message |
| Need a travel target or lost orientation | `acm_timeline({ list_checkpoints: true })` |
| A summary dropped a detail you now need | re-fetch from pointers first; else forward travel to the backup (find it with `acm_timeline({ search })`) |

## After a travel

The injected summary is your new state — execute its NEXT step and checkpoint the new phase as you continue. Disk and external systems were not rolled back; inspect them directly when in doubt.

## Mechanics

- Checkpoint names are unique across the tree and case-sensitive; one node may hold multiple aliases. Omitting `target` auto-anchors the nearest meaningful USER/AI turn near HEAD.
- Travel target choice: the anchor that leaves the smallest context that still suffices. An older anchor plus a stronger summary beats a recent anchor plus stale baggage; `root` (the first top-level node) is right when the summary can carry everything.
- Travel can shrink or grow context: a later or off-path target restores raw history (that is how forward recovery works). Read `estimatedUsageAfter` and `structuralEffect` from the result.
- `acm_timeline` mode precedence: `list_checkpoints` > `search` (full tree, including off-path) > `full_tree` (truncates on deep trees) > default active path. Never conclude an anchor is missing from a truncated `full_tree`.
- Judge fill level only by reported usage numbers, never by file bytes or lines read.
- If the runtime auto-compacts, a `pre-compact-<timestamp>` checkpoint is created automatically; you can travel back to it.

## Scenario playbook

`references/playbook.md` works the fold moments through common shapes — research, development, plan-driven work, batch items, retries, task switching, async fronts — each with a filled summary template to copy. If your task matches none of them, the fold moments above apply directly.
