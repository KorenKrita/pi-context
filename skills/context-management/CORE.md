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
- **Fold** — `acm_travel` replaces lived process with its **handoff**, and is as recoverable as a save: the raw path stays in the tree behind a pointer, one travel away. The single test is **cold start**: could a fresh agent, given only the handoff and its pointers, continue immediately — knowns still known, unknowns still open, NEXT executable? Folding mid-investigation is fine when the handoff carries the uncertainty faithfully. Before traveling, answer in one line: what leaves the working set, what pointer recovers it, and what single action is NEXT — and never fold away an unfulfilled promise to the user: red tests, an unanswered question, or a half-landed change stays live until it is kept. Target the last clean point before the material being folded, not the nearest label — **anchor gravity** misleads.
- **Rebase** — a fold to an earlier base. When summaries stack or start competing over what is authoritative, merge everything that survives into one handoff at the earliest base that passes cold start without growing projected summary depth. Root is a candidate, never a default.
- **Rehydrate** — travel toward an archived branch to recover one exact detail. Save your return point first, fetch the detail, then travel back carrying the extract. Compression stays reversible; that is why it can be bold.
- **Fork** — save the fork point, explore one direction freely, and either fold the winning path forward or travel back to the fork carrying what the failed direction proved in Exclusions.

### Cadence

Compress continuously — integrate observations into conclusions as you work. Fold in batches — each travel costs a tool round-trip and one summary layer, so commit representation gains in meaningful units, not after every step.

Two failure modes frame the healthy band. **Sediment**: a better representation exists but the raw process still occupies the working set. **Thrash**: folding tiny deltas, then immediately rereading what was just folded. Between them the band is wide, and different models legitimately choose different batch sizes inside it.

Folding is a habit set by the rhythm of the work, not a reaction to a full gauge: sediment clouds attention long before it fills the window, so low usage is never by itself a reason to keep raw process live. A comfortable cruise — around a third of the working budget (the smaller of the model window and 400K) — is the result of that habit, not its trigger. That is a preference, never an override: correctness, task continuity, and cold start always win, and native compaction is a fallback only when genuinely long work outruns folding.

The habit fires at the seams of the work: a burst of reads distilled into findings; a direction rejected; a phase completed as the next begins; a new request over finished work; a final answer coming due — run a rebase check; an archived detail needed again — rehydrate; summaries starting to stack — and, only as a backstop, when pressure has risen. At each, folding is the default, not an optional extra: when the trail behind you is already sediment, fold it and carry pointers. Skip only when you can name why the raw detail must stay live.

### The handoff

Seven slots, once each, in order, each starting its own line; write `none` when a slot is empty:

Goal / State / Evidence / External / Exclusions / Recover / NEXT

`State` carries live cognition, not only results: knowns, unknowns, hypotheses, and the hot set. `NEXT` is one concrete action a fresh agent could execute immediately. A fold mid-investigation:

```text
Goal: Find why checkout p99 latency doubled since v2.3.0.
State: Not the database — query times flat vs 2026-07-01 baseline. Two hypotheses: pool exhaustion (errors correlate, evidence weak) vs new retry loop in payments client (added in v2.3.0, untested). Hot: pool max=50 in config/prod.yaml:23; retry commit 9f31c2a.
Evidence: dashboards/checkout-p99.json; git log v2.2.0..v2.3.0 -- services/payments.
External: none.
Exclusions: DB indexes — verified healthy, do not revisit.
Recover: latency-hunt-scan.
NEXT: Read the retry loop in services/payments/client.ts and check backoff bounds against pool max=50.
```

### Facts and receipts

A tool call is a request; only its matching result is fact — applied, not applied, or indeterminate. Read the result before building on it. Travel rewrites conversation context only: files, processes, and external systems keep their state, covered by the `External` slot and direct inspection.
<!-- ACM:CORE:END -->
