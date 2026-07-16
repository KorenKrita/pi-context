# Agentic Context Management

Pi-context keeps a coding agent's live context small enough to reason clearly while preserving every state needed to continue or recover work.

## Language

**Working set**:
The exact live material needed to choose and execute the next action. Detail belongs here while it can still change the decision.
_Avoid_: context window, transcript, recent messages

**Active uncertainty**:
An unresolved question whose supporting raw detail may still change the next action. Active uncertainty keeps that detail in the working set.
_Avoid_: open context, unresolved history

**Evidence chain**:
The measurements, baselines, deltas, and causal links that can still resolve active uncertainty. A failed or rejected attempt can close while its evidence chain remains live.
_Avoid_: result dump, all collected data

**Boundary**:
The semantic edge around a goal, phase, attempt, burst, or front. A boundary is open while its raw process still serves active uncertainty and closed when only its outcome must survive.
_Avoid_: checkpoint, timestamp, nearest anchor

**Recoverability**:
The ability to return to omitted raw history or a prior branch through a durable pointer. Recoverability preserves options without keeping every detail live.
_Avoid_: backup alone, undoability

**Checkpoint**:
A semantic label attached to history to create recoverability without changing the working set.
_Avoid_: snapshot, branch, fold

**Receipt**:
The structured outcome attached to one matching tool call. It distinguishes proposed intent from established fact by reporting whether an operation was applied, not applied, or remains indeterminate.
_Avoid_: assistant claim, tool parameters, planned action

**Handoff**:
The compact, authoritative working state that survives a fold. It carries the next action and direct evidence pointers rather than replaying the process that produced them.
_Avoid_: summary, transcript digest

**Archive**:
Raw history intentionally moved off the active path and retained behind a recovery pointer.
_Avoid_: deleted history, handoff

**Fold**:
A context transition that replaces one closed boundary's raw history with a handoff while preserving an archive pointer.
_Avoid_: checkpoint, compaction

**Rebase**:
A fold that replaces accumulated handoff layers with one authoritative handoff at the earliest safe base.
_Avoid_: root travel, reset

**Cold start**:
The standard that a fresh agent can execute the next action from the handoff and its direct evidence pointers without reading archived conversation.
_Avoid_: structurally valid, concise

**Summary debt**:
The ambiguity and duplicated state created when handoff layers accumulate or old handoffs remain authoritative beside newer ones. Summary depth is evidence of debt, not debt by itself.
_Avoid_: context pressure, token count

**Anchor gravity**:
The tendency to choose the nearest or most conveniently named history anchor instead of the anchor immediately before the boundary being folded.
_Avoid_: recency, target proximity

**Front**:
One coherent line of work that can be active, parked, or complete while other work continues in the same session.
_Avoid_: task list item, branch
