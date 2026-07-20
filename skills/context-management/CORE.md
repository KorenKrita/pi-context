# ACM Canonical Guidance — CORE

This file is the always-on model-facing projection of `docs/acm-judgment-contract.md`. Tool descriptions, prompt metadata, result cues, and recovery text live in `TOOL-CONTRACTS.md` (术). Changes to judgment semantics originate in the contract; generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE

Compression is intelligence: to understand something is to be able to restate it shorter without losing what matters. Your context window is a **working set**, not a transcript — it should hold the best current representation of the task, not the history of how you reached it. The ACM tools (`acm_checkpoint`, `acm_timeline`, `acm_travel`) let you act on that understanding. They are yours to use autonomously, as ordinary as reading a file; only an explicit user request to hold travel pauses it, and only for the scope the user names.

### What earns a place in the working set

- Settled conclusions, decisions, and constraints.
- Honest uncertainty: unknowns kept as unknowns, competing hypotheses with the evidence for each and the next test that would tell them apart.
- The **hot set** — exact values, identifiers, snippets, and wording the next few steps will reuse verbatim.
- Pointers — paths, commands, commits, node IDs, checkpoints — to everything else.

Raw process whose outcome is already extracted — logs read, diffs applied, searches concluded, dead ends understood — is **sediment**: it competes for attention without changing any future decision. Removing it deletes nothing; history stays in the session tree, reachable by pointer.

### The moves

- **Save** — `acm_checkpoint` labels the current state so it can be found again. It never blocks, branches, or folds anything. Save when returning here later has real value: before a risky attempt, at a validated baseline, before a fork in strategy, when parking one front to work another, before folding raw history away. Recoverability is what makes bold compression and bold exploration cheap. File backups protect the disk; a checkpoint protects this conversation — they never substitute for each other; a risky step deserves both.
- **Orient** — `acm_timeline` shows the spine, save points, summary depth, usage, and sync state. It reports facts; what they justify stays your call.
- **Fold** — `acm_travel` replaces lived process with its **handoff**, and is as recoverable as a save: the raw path stays in the tree behind a pointer, one travel away. Fold when low-attention-value, high-noise material has a substantially more concise representation and the expected attention gain exceeds transition and continuity cost. **Cold start** is the handoff integrity test: knowns remain known, uncertainty remains open, current obligations survive, and `next` is executable. Mid-investigation travel can be valuable when those conditions hold. Target the last clean point before the material being folded, not the nearest label — **anchor gravity** misleads.
- **Rebase** — a fold to an earlier base. When summaries stack or start competing over what is authoritative, merge everything that survives into one handoff at the earliest base that passes cold start without growing projected summary depth. Root is a candidate, never a default.
- **Rehydrate** — travel toward an archived branch to recover one exact detail. Save your return point first, fetch the detail, then travel back carrying the extract. Compression stays reversible; that is why it can be bold.
- **Fork** — save the fork point, explore one direction freely, and either fold the winning path forward or travel back to the fork carrying what the failed direction proved in Exclusions.

### Cadence

Compress continuously — integrate observations into conclusions as you work. Fold in batches — each travel costs a tool round-trip and one summary layer, so commit representation gains in meaningful units, not after every step.

Two failure modes frame the healthy band. **Sediment**: a better representation exists but the raw process still occupies the working set. **Thrash**: folding tiny deltas, then immediately rereading what was just folded. Between them the band is wide, and different models legitimately choose different batch sizes inside it.

ACM Judgment is independent of a full gauge: sediment can cloud attention at low usage, while high usage can still contain details whose attention value remains high. A comfortable cruise — around a third of the working budget (the smaller of the model window and 400K) — is a preferred outcome, not move authorization. Correctness, task continuity, Representation Gain, and cold start determine the result; native compaction remains available when genuinely long work outruns useful travel.

Use ACM Judgment as a standing lens. Distilled reads, rejected directions, completed phases, new requests, possible return points, stacked summaries, missing archived details, and rising pressure are signals to evaluate the working set — not predetermined moves. Check for a Compression Candidate, Compressibility, Attention effect, Recovery value, and Transition effect; then choose the net-positive move or continue with the current working set.

### The handoff

`acm_travel` accepts a structured handoff with seven semantic fields: `goal`, `state`, `evidence`, `external`, `exclusions`, `recover`, and `next`. Supply every field; write `none` only for empty supporting fields. Runtime owns the durable text format.

`state` carries live cognition, not only results: knowns, unknowns, hypotheses, surviving fronts, and the hot set. `next` is one concrete action a fresh agent could execute immediately. A fold mid-investigation:

```json
{
  "goal": "Find why checkout p99 latency doubled since v2.3.0.",
  "state": "Not the database — query times flat vs 2026-07-01 baseline. Two hypotheses: pool exhaustion (errors correlate, evidence weak) vs new retry loop in payments client (added in v2.3.0, untested). Hot: pool max=50 in config/prod.yaml:23; retry commit 9f31c2a.",
  "evidence": "dashboards/checkout-p99.json; git log v2.2.0..v2.3.0 -- services/payments.",
  "external": "none",
  "exclusions": "DB indexes — verified healthy, do not revisit.",
  "recover": "latency-hunt-scan",
  "next": "Read the retry loop in services/payments/client.ts and check backoff bounds against pool max=50."
}
```

### Facts and receipts

A tool call is a request; only its matching result is fact — applied, not applied, or indeterminate. Read the mutation receipt once. After an applied travel, trust the handoff as your authoritative current state and execute `next`; verify only uncertainty recorded in the handoff or facts changed by later independent activity. Travel rewrites conversation context only: files, processes, and external systems keep the state recorded in `external`.
<!-- ACM:CORE:END -->
