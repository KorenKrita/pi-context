# ACM Canonical Guidance

This file owns the always-on ACM doctrine. Runtime tool descriptions, prompt guidelines, result cues, and recovery text live in `TOOL-CONTRACTS.md`. Regenerate TypeScript with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE

The CORE is the **way** (道): judge what belongs in the **working set** and let mechanics follow that judgment.

### Working-set doctrine

A context window is a **working set**, not a transcript. Keep the exact material that can still change the next action; let finished process leave only when its outcome can stand on its own.

A **boundary** is semantic: a goal, phase, attempt, burst, or front—not whichever checkpoint happens to be nearest. A boundary stays open while its raw process serves **active uncertainty**. Conflicting reports, an unexplained failure, or a next action that resolves an unknown are an **open loop**: keep their raw evidence in the working set until the loop closes.

An **evidence chain** is the measurements, baselines, deltas, and causal links that can still resolve an open loop. A rejected attempt may leave a live evidence chain. Keep it until the conclusion no longer depends on it.

A **receipt** separates intent from fact. Plans, drafts, parameters, and assistant prose describe a proposed action; only the matching tool result establishes whether it was applied, not applied, or remains indeterminate. Update the working set from the receipt, never from anticipation.

**Recoverability** is the seatbelt of expansion. **Unlabeled return state + imminent working-set expansion = unbuckled seatbelt.** Before accelerating into a distinct goal, risky attempt, broad burst, or parked front, attach a semantic checkpoint to the state worth returning to. The checkpoint is a bookmark, not a closing bracket: it changes what can be recovered, not whether the boundary is closed.

A **handoff** replaces a closed boundary's process with executable state. It passes **cold start** only when a fresh agent can run the next action from the handoff and direct evidence pointers without reading archived conversation. A concise handoff that loses a live constraint or evidence chain is worse than keeping the raw detail.

**Summary debt** grows when handoff layers accumulate, old and new summaries compete, or parked fronts lose one authoritative home. Summary depth and context pressure are evidence of possible debt, not permission to travel. Pay summary debt by replacing obsolete layers with one cold-start handoff only when the surviving state is complete.

**Anchor gravity** pulls toward the newest label, the root, or the easiest target. A travel target marks where the retained spine begins; it is not the place where the newest state happens to live. Name the boundary first and choose the last clean anchor before it. To retire stacked handoffs, the target must precede the layers being retired. Earliest and nearest are candidates; boundary and cold start decide.

### Tend the working set

Use these judgments whenever the working set changes; they are a compass, not a fixed tool sequence:

- **Protect** — buckle the recoverability seatbelt before the working set expands into a distinct goal, risky attempt, unbounded burst, or parked front. Create the semantic checkpoint before motion, while the return state is still obvious.
- **Hold** — an open loop stays on the desk. While active uncertainty remains, keep its evidence chain, raw observations, alternatives, citations, and failure evidence live. A checkpoint is only a bookmark; context pressure raises attention but closes nothing.
- **Distill** — when a boundary closes, preserve conclusions, decisions, invariants, external effects, exclusions, live evidence chains, and direct evidence; let exploratory process become archive.
- **Fold** — travel only when the omitted raw path is recoverable and the handoff passes cold start. A checkpoint alone is not a reason to fold.
- **Rebase** — when summary debt is real, seek the earliest safe base that can replace obsolete active handoffs with one authoritative handoff. If no candidate preserves every front, invariant, and live evidence chain, keep the needed state live.
- **Verify** — after any mutation, read its matching receipt. When travel was applied, treat the handoff as the new working set, then confirm the selected branch, recovery pointer, context-sync state, and external side effects before continuing.

### Boundary moments

These moments call for judgment, not an automatic trajectory:

- A new request may open a new boundary while the previous result is stable. If no semantic recovery label protects that result, checkpointing that return state is the next action before any broad read or scan for the unrelated goal; the new request alone is not a reason to fold.
- A broad read, log stream, subagent fan-out, or risky mutation may create a burst. Protect its entrance; fold only after its uncertainty is distilled.
- A rejected direction closes one attempt but may leave an evidence chain that constrains the next. Keep the chain, archive the dead process, and move the authoritative state forward.
- A final answer closes user-facing work only when no active uncertainty, external effect, promised verification, or indeterminate receipt remains. Report results established by evidence, not proposed actions or archived process.
- Rising context pressure is a weather report. Re-examine boundaries and summary debt; continue normally when cold start or recoverability would fail.
<!-- ACM:CORE:END -->
