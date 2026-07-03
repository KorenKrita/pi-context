---
name: context-management
description: "Self-manage your context window with checkpoints and time travel — treat this as a native ability, like reading files or running commands. Checkpoint constantly, it is free: at task start, at each new user request, before each phase's first action, before risky steps, after milestones. Decide travel purely by benefit, never by a usage threshold: whenever the trail behind you is mostly dead weight and a summary can carry the live state, fold it — dropping from 13% to 5% usage is worth doing. Tool results report usage and fold previews; react to them. Skip only for trivial one-shot answers."
---

# Context Management

Your context window is a finite working set, and you are the one who manages it. Three tools:

- `acm_checkpoint` — label a conversation node with a semantic name. Zero cost: no branch, no summary, no context change. Its result reports current context usage and a fold preview (what traveling back to the previous anchor would leave).
- `acm_timeline` — see the conversation tree plus a context-usage HUD. `list_checkpoints: true` estimates the post-fold size of every anchor.
- `acm_travel` — jump to any checkpoint or node, leaving a handoff summary. The target becomes the branch point; everything after it is replaced by your summary. The old path is never deleted.

Use them on your own judgment, mid-task, without being asked. Do not wait for the user to mention context, and do not ask permission. When any tool result shows a usage percentage or fold preview, that number is addressed to you — read it and react.

## The rhythm

1. **Anchor** — checkpoint at every moment you might want to return to (see policy below).
2. **Work** — do the phase; let it get noisy locally.
3. **Look** — every checkpoint result shows current usage and what a fold would leave.
4. **Fold** — whenever the trail behind you is mostly dead weight, `acm_travel` back to the anchor with a handoff summary. The raw trail becomes a capsule; you continue clean.

## Checkpoint policy: anchor early, anchor often

Checkpoints cost nothing — no branch, no summary, no context change. The failure mode is not too many anchors; it is reaching for a travel target that does not exist. Checkpoint at:

- task start, and at each new user request that starts or redirects work
- before the first action of each phase (investigate, implement, validate, ...)
- before risky, destructive, or hard-to-redo steps
- after milestones: a stable finding, a decision, a passing test, a completed item
- before switching away from a line of work you will return to

When unsure, checkpoint. And if you forgot: user turns are implicit anchors — `acm_travel` accepts raw node IDs from the timeline — so it is never too late to fold.

## Fold policy: judge by benefit, never by thresholds

There is no usage level that triggers a fold and none that excuses skipping one. The only question is: **how much of the context behind me is dead weight, and can a summary carry the live state?**

- At every stable point — phase result, failed attempt, answered side question, completed batch item, task switch — look back at the trail since the relevant anchor. If it is mostly noise you will not reason over again (searches already distilled, logs already diagnosed, attempts already judged), fold it, **even at low usage**. Going from 13% to 5% is a good fold.
- Conversely, a full window made of live, still-needed context is not a fold signal by itself. Find the real stable point first; never discard context you are actively reasoning over.
- Absolute usage only changes urgency: the fuller the window, the sooner you should reach a stable point and fold.
- Use the numbers, not intuition: checkpoint results show a fold preview, and `acm_timeline({ list_checkpoints: true })` estimates what every anchor would leave (`~msgs, ~% est.`). If an anchor shows a real drop and the summary writes itself, that fold is worth taking now.

## Reflex table

| Moment | Reflex |
|---|---|
| Multi-step task starting, or a new user request arriving | checkpoint |
| First action of a new phase | checkpoint; if the finished phase left a noisy trail, fold it to its anchor first |
| About to try something risky or hard to redo | checkpoint |
| Milestone: stable finding, decision, passing test | checkpoint |
| Approach failed, switching to another | travel to the pre-attempt anchor; summary records what failed and why |
| Stable point + trail since an anchor is mostly dead weight | travel — at any usage level |
| Window filling up with live, still-needed context | keep working to the next stable point, then fold; do not discard live context |
| New user task after a noisy completed one | travel the old task away before starting |
| Lost orientation, or repeatedly re-checking status | timeline |
| Need raw details that a summary dropped | travel forward to the backup/off-path anchor (find it with `acm_timeline({ search })`) |
| Task fully done, about to give the final answer | do nothing — answer and wait |

## Two directions

- **Back** (usual): target sits before the noisy segment. Folds raw history into your summary; context usually shrinks.
- **Forward**: target is a backup or off-path anchor that still carries raw history. Restores details a summary dropped; context usually grows. Old paths survive every travel, so nothing is ever lost — recover via `search`.

Do not assume travel shrinks context. Read `estimatedUsageAfter`, `estimatedEffect`, and `structuralEffect` from the travel result; official token % confirms on the next `acm_timeline`.

## Summary contract

The summary IS your memory after the travel — everything after the target leaves your context. It must restore:

1. **Task state** — goal, decisions, constraints, what succeeded or failed.
2. **External state** — files changed, processes started or stopped, remote/browser/ticket side effects. Travel never rolls these back; the summary must bridge conversation state to real-world state.
3. **Validation state** — what was run, what passed, what remains risky.
4. **Pointers, not dumps** — file paths, IDs, URLs, queries, commands to re-fetch data instead of raw copies. Copy raw values only when small, volatile, or needed immediately.
5. **Next step** — one explicit action to take after the travel lands.

Set `backupCurrentHeadAs` when the raw path might still matter later. It is a recovery pointer on the path you are leaving, **not** the travel target, and never a substitute for the summary.

Choosing the target: pick the anchor that leaves the smallest context that still suffices. An older anchor plus a stronger summary usually beats a recent anchor plus stale baggage; `root` is legitimate when the summary can carry everything.

## After a travel

The injected summary is your new state — execute its next step, and anchor the new phase with a fresh checkpoint as you continue. Disk and external systems were not rolled back; inspect them directly when in doubt. If a detail is missing, re-fetch it from pointers first; travel to the backup only if it cannot be reconstructed cheaply.

## Mechanics

- Checkpoint names are unique across the tree and **case-sensitive**; one node may hold multiple aliases. Omitting `target` auto-anchors the nearest meaningful USER/AI turn near HEAD. For phase-complete milestones, prefer an explicit `target` on the substantive turn rather than a short meta-instruction line.
- `acm_timeline` modes, in precedence order: `list_checkpoints` (catalog with per-anchor fold estimates) > `search` (full tree, including off-path) > `full_tree` (bounded; truncates on deep trees) > default active path. On large trees use `list_checkpoints` or `search`; never conclude a checkpoint is missing from a truncated `full_tree`.
- Judge fill level by reported usage numbers, never by file bytes or lines read.
- `root` resolves to the first top-level node. Error messages include recovery hints — read them.
- If the runtime auto-compacts, a `pre-compact-<timestamp>` checkpoint is created automatically; you can travel back to it.

## Scenario playbook

`references/playbook.md` opens with the **universal fold procedure** — a shape-independent way to decide anchors, fold points, and summary content for any task — and then works it through common shapes (research, development, planning, batch items, retries, task switching, async fronts). The examples are illustrations, not a taxonomy: if your task matches none of them, apply the universal procedure directly.
