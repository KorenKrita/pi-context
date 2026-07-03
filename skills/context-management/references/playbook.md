# Boundary Playbook

Use this when the boundary is unclear. The main skill owns the discipline: keep the working set live, fold by boundary, and leave a recoverable handoff.

## Target selection

Name the boundary first.

| Boundary | Signal | Target | Handoff owns |
|---|---|---|---|
| Burst | temporary output has been distilled | pre-burst anchor or last clean node | extract, evidence pointer, NEXT |
| Phase | next action uses the conclusion | phase start | conclusion, decision, next phase |
| Failed direction | path is judged dead or superseded | attempt start or last milestone | what failed, why, what survives |
| Batch item | item done and more remain | method/batch anchor | tally, method refinements, next item |
| Task chain | final answer or new request after finished work | semantic chain start | final state, answer material, recovery pointer |
| Missing anchor | no label sits before the boundary | raw node ID before the boundary | same as the boundary being folded |

## Burst boundary

A burst is a temporary expansion: big read, broad search, log fetch, large diff, subagent, or any tool output you could not bound before calling it.

**Signal**: you have extracted the finding, paths, commands, errors, or IDs needed for the next action.

**Target**: the pre-burst checkpoint. If missing, use `acm_timeline` and choose the last clean node ID before the burst.

```javascript
acm_travel({ target: "<pre-burst-anchor-or-node-id>", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <current task or phase goal>
State: <the distilled finding>
Evidence: <files, commands, URLs, node IDs, search terms>
External: <none, unless the burst changed disk/process/remote state>
Exclusions: <irrelevant branches or failed searches>
Recover: <pre-burst checkpoint or node ID; backup if created>
NEXT: <continue the phase using the extract>
```

**Failure mode**: keeping raw output live after the extract is stable.

## Phase boundary

A phase boundary appears when the next action uses the phase result, not the raw path that produced it.

**Signal**: investigation becomes implementation; implementation becomes validation; diagnosis becomes fix; reading becomes answer.

**Target**: the phase `-start`.

```javascript
acm_travel({ target: "<phase-start>", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <task goal and phase just completed>
State: <phase conclusion and current status>
Evidence: <load-bearing files, commands, errors, commits, test names>
External: <files/processes/remotes changed during the phase>
Exclusions: <wrong leads or options rejected>
Recover: <phase start and any milestone/archive pointer>
NEXT: <first action of the next phase>
```

**Failure mode**: waiting for a new user message even though the next phase has already begun.

## Failed-direction boundary

A failed direction is a branch whose raw trail should not pollute the next attempt.

**Signal**: an approach failed, a hypothesis was falsified, a design direction was rejected, or a path was superseded.

**Target**: the attempt start. If no attempt anchor exists, use the last milestone `-done` before it, or the last clean node ID.

```javascript
acm_travel({ target: "<attempt-start-or-last-milestone-or-node-id>", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <unchanged larger goal>
State: <what failed and what remains true>
Evidence: <commands, errors, diffs, links proving the failure>
External: <any partial files/processes/remotes left behind>
Exclusions: <the failed direction and why not to retry it>
Recover: <attempt start, milestone, node ID, or backup>
NEXT: <next attempt or question>
```

**Failure mode**: continuing with a dead trail in the working set because it was expensive to produce.

## Batch boundary

Batch work accumulates hidden context debt because each item feels small.

**Signal**: one item is complete and more remain.

**Target**: the method anchor: the point after the reusable method is known and before item-specific noise begins.

```javascript
acm_travel({ target: "<method-anchor>", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <batch goal>
State: <completed count, remaining count, method refinements>
Evidence: <item IDs, changed paths, command pattern>
External: <side effects already applied>
Exclusions: <item-specific dead ends not to repeat>
Recover: <method anchor and any backup>
NEXT: <next item>
```

**Failure mode**: judging each fold by small immediate savings. Batch folds compound.

## Task-chain boundary

A task-chain boundary clears completed work before the final answer or before a new request starts.

**Signal**: the final answer is next; or a new user request arrives over finished work.

**Target**: the earliest `-start` of the semantic chain being compressed. A semantic chain is continuous work serving one user goal: follow-up fixes, refinements, and phase shifts stay in the chain; a new unrelated user goal starts a new chain. This may be older than the nearest anchor. Use `root` only when several unrelated finished chains have stacked up and a single handoff can capsule each one.

```javascript
acm_travel({ target: "<semantic-chain-start>", backupCurrentHeadAs: "<task>-done", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <task goal; quote the new user request verbatim if it triggered the fold>
State: <final conclusions, decisions, status, answer material>
Evidence: <key paths, commands, commits, errors, checkpoints>
External: <all disk/process/browser/remote/ticket side effects>
Exclusions: <dead ends already judged>
Recover: <backupCurrentHeadAs, existing -done, checkpoint, or node ID>
NEXT: <give final answer, or start the quoted new request>
```

**Failure mode**: anchor gravity toward the most recent task or phase anchor. Fold by boundary, not proximity.

## Interleaved fronts

Interleaving makes recent anchors especially misleading.

**Signal**: several fronts are live or parked, or delayed results arrive while another front is active.

**Target**: the boundary of the front being compressed. When completed fronts are scattered through the thread, an older anchor or `root` plus one capsule per front can be cleaner than a recent anchor.

```javascript
acm_travel({ target: "<front-boundary-anchor-or-root>", summary: "<handoff>" });
```

**Handoff owns**:

```text
Goal: <overall goal and active front>
State: <active front, parked fronts, done fronts>
Evidence: <pointers per front>
External: <side effects per front>
Exclusions: <front-specific dead ends>
Recover: <archive pointers per front>
NEXT: <single next action on the active front>
```

**Failure mode**: choosing the closest anchor even though it belongs to the wrong front.

## Missing anchor

Anchors are conveniences, not prerequisites.

1. Run `acm_timeline`.
2. Find the last clean node before the boundary you want to compress.
3. Travel to that node ID with a handoff that names the boundary and recovery pointer.

```javascript
acm_travel({ target: "<last-clean-node-id>", summary: "<handoff>" });
```

If orientation is poor, checkpoint the current meaningful turn first as an archive pointer, then inspect the timeline.

## None of these fit

Use the fold gate from the main skill:

- Boundary named.
- NEXT executable.
- Raw recoverable.

If any gate fails, keep the context live and checkpoint the next stable point.
