---
name: context-management
description: "Manage the context working set with recoverable folds. Use continuously during multi-step work: checkpoint before bursts and risks; fold at stable boundaries when raw history has become a handoff; before final answers or task switches, clear the finished task chain. Fold by boundary, not proximity."
---

# Context Management

A context window is a **working set**: the live material needed for the next action.

Keep the working set live. Compress everything else into a recoverable **handoff** at stable **boundaries**. Manage it yourself, mid-task, without being asked and without asking permission.

## Leading words

**Working set** — context the next action will directly reason over. Keep exact detail live while it is still needed.

**Boundary** — the semantic edge of the work being compressed: a burst, phase, failed direction, batch item, or task chain. Boundary is the travel decision.

**Handoff** — the executable state left after travel. It is an index, not a store: put raw detail in the archive, external state in the world, and only resumable state in the handoff.

**Archive** — the raw path preserved off-branch by travel, plus any backup checkpoint that points to it. Folded history is archived, never deleted.

**Chain** — continuous work serving one user goal. Follow-up fixes, refinements, and phase shifts stay in the chain; a new unrelated user goal starts a new chain.

**Burst** — temporary context expansion: big reads, broad searches, logs, large diffs, subagents, or any output whose size you could not bound before calling it.

**Anchor gravity** — the pull of the nearest checkpoint. It often feels correct because it is close. Resist it by naming the boundary first.

## Fold gate

Fold only when all three are true:

- **Boundary named** — you can say what is being compressed: burst, phase, failed direction, batch item, or task chain.
- **NEXT executable** — the handoff contains one immediate next action. If you cannot write one executable NEXT, keep the context live.
- **Raw recoverable** — details not copied into the handoff are archived or pointed to by checkpoint, node ID, file path, command, URL, or other recovery pointer.

No boundary, no travel target. No executable NEXT, no fold.

## Tools

- `acm_checkpoint` — create recoverability by labeling a conversation node. Free: no branch, no summary, no context change.
- `acm_travel` — fold history into a handoff by traveling to an anchor or raw node ID. The old path becomes the archive.
- `acm_timeline` — inspect the tree, checkpoint labels, node IDs, usage, and fold candidates.

## Anchors

Use fixed suffixes; the name encodes future use:

- `<name>-start` — the beginning of a boundary you may later compress: task chain, phase, burst, or risky attempt.
- `<name>-done` — a milestone/archive pointer after results are in hand. It is a retreat point for later work and a recovery bookmark for raw history before it.
- `<name>-paused` — unfinished work you will return to.

A fold target must sit before the boundary you are compressing. Anchors are conveniences, not prerequisites: `acm_travel` and `acm_checkpoint` accept raw node IDs from `acm_timeline`.

## Checkpoint discipline

Checkpoint at these events. It is free, and missing recoverability is the failure mode:

- New task chain or user request starts.
- A phase's first action is about to run.
- A burst is about to happen: big read, broad search, log fetch, subagent, large diff.
- A risky, destructive, or hard-to-redo step is about to run.
- A milestone lands: conclusion written, decision made, root cause confirmed, test passed.
- Work is paused for another front.

Checkpoint creates recoverability. It is not a fold.

## Fold discipline

Fold by boundary, not proximity. The nearest anchor is only a candidate.

| Boundary | Signal | Target |
|---|---|---|
| Burst | output is distilled into an extract | pre-burst anchor or last clean node |
| Phase | next action uses the conclusion, not the raw trail | phase start |
| Failed direction | an attempt is judged dead or superseded | attempt start or last milestone |
| Batch item | item finished and more remain | method or batch anchor |
| Task chain | final answer next, or new request over finished work | semantic chain start |

Call `acm_travel` at these stable boundaries by default. Skip only when the fold preview shows almost no saving.

### Task end

The final answer should be written from the handoff, not the trail. At task end, fold before answering:

```javascript
acm_travel({
  target: "<task-chain-start>",
  backupCurrentHeadAs: "<task>-done",
  summary: "<handoff>"
});
```

Then answer from the handoff branch. If a `-done` checkpoint already bookmarks the raw path, name it in the handoff's `Recover` slot.

### New request over unfolded work

If a new user request arrives over finished work that was not folded, fold before starting. Target the finished semantic chain start, not the most recent anchor. Use `root` only when several unrelated finished chains have stacked up and the handoff can carry one capsule per chain. Quote the new request verbatim in the handoff because it sits after the target and will leave context.

## Handoff contract

The handoff is your working state after travel. Fill every slot; write `none` rather than deleting a slot:

```text
Goal: <current goal; quote a new triggering user request verbatim>
State: <what is true now; conclusions, decisions, status, key numbers/errors/IDs>
Evidence: <paths, commands, URLs, node IDs, checkpoint names, commits, test outputs to recover detail>
External: <files changed, processes started/stopped, browser/remote/ticket side effects; travel does not undo these>
Exclusions: <dead ends and directions not to repeat, with why>
Recover: <backup label, checkpoint, node ID, or pointer to the archived raw path>
NEXT: <one executable next action>
```

Pointers over dumps. Copy raw values only when small, volatile, or needed immediately.

`Evidence` points to facts you can re-fetch: files, commands, URLs, commits, errors, node IDs. `Recover` points to the archived raw conversation path: backup label, checkpoint, or node ID.

## Target selection

Name the boundary first, then choose the target:

- Burst → pre-burst anchor or last clean node before the output.
- Phase → the phase's `-start`.
- Failed direction → where the attempt began, or the last `-done` milestone behind it.
- Batch item → the method anchor that should survive item-to-item.
- Task chain → earliest `-start` of the semantic chain being compressed, not the earliest start in the whole conversation.
- Missing anchor → `acm_timeline`, pick the last clean node ID before the boundary, then travel to that node.

Older anchors can be better targets when the handoff can carry the state. A newer anchor is not automatically better.

## After travel

You are on the handoff branch. Execute `NEXT`, then checkpoint the next phase before its first action. Disk and external systems were not rolled back; inspect them directly when in doubt. If a handoff dropped detail, re-fetch from `Evidence` first, then recover from `Archive` by traveling to the backup or off-path node.

## Mechanics

- Checkpoint names are unique across the tree and case-sensitive; one node may hold multiple aliases.
- Omitting checkpoint `target` auto-anchors the nearest meaningful USER/AI turn near HEAD; passing a node ID anchors any past node retroactively.
- `acm_timeline` mode precedence: `list_checkpoints` > `search` > `full_tree` > active path. Never conclude an anchor is missing from a truncated `full_tree`.
- Travel can shrink or grow context: traveling to a later or off-path target can restore raw history. Read the reported usage and structural effect.
- Judge fill level by reported usage, never by file bytes or lines read.
- If runtime auto-compacts, a `pre-compact-<timestamp>` checkpoint is created automatically.

## Boundary playbook

`references/playbook.md` helps identify boundaries and pick targets when the shape is unclear. It is reference, not a second source of truth: the rules above own the discipline.
