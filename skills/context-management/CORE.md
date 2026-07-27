# ACM Canonical Guidance — CORE

This file is the always-on model-facing projection of `docs/acm-judgment-contract.md`. Tool descriptions, prompt metadata, result cues, and recovery text live in `TOOL-CONTRACTS.md` (术). Changes to judgment semantics originate in the contract; generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE

Compression is intelligence: to understand something is to be able to restate it shorter without losing what matters. Your context window is a **working set**, not a transcript — it holds the best current representation of the task, not the history of how you reached it.

Folding exists for forward motion, not tidiness. You shed baggage at the right moment so the road ahead gets your full attention — never because history looks untidy. A fold is packing for the journey: what the next stretch needs goes into the handoff; everything else stays behind in the tree, one travel away.

The ACM tools (`acm_checkpoint`, `acm_timeline`, `acm_travel`) are yours to use autonomously, as ordinary as reading a file; only an explicit user request to hold travel pauses them, and only for the scope the user names.

### What earns a place in the working set

- Settled conclusions, decisions, and constraints.
- Honest uncertainty: unknowns kept open, competing hypotheses with the evidence for each and the next test that would tell them apart.
- The **hot set** — exact values, identifiers, snippets, and wording the next steps will reuse verbatim.
- Pointers — paths, commands, commits, node IDs, checkpoints — to everything else.

Raw process whose outcome is fully extracted — logs read, diffs applied, searches concluded, dead ends understood — is **sediment**: it competes for attention without changing any future decision. Removing it deletes nothing; history stays in the session tree, reachable by pointer.

### When a fold is earned

**Extraction-complete is the bar.** Fold a stretch of history when you can name what that stretch was — a burst distilled, a direction closed, a phase that handed over its conclusion — and can already restate everything it settled — conclusions, live hypotheses with their evidence, exact hot values — without reaching back into it. If writing the handoff forces vagueness, the understanding is not finished, and folding now converts a half-built understanding into debt repaid as a wave of rereads. Fold behind the last settled boundary instead, or keep working until the extraction closes.

The bar applies to the stretch being folded, not to the whole task. Mid-investigation travel can be valuable when the stretch is itself spent — a dead end whose lesson is banked, a detour that yielded its one number, a bulk ingest already distilled — even while the larger question stays open; `exclusions` carries what the dead end proved.

Once the bar is met, lean into the fold. The regret is asymmetric: sediment taxes every later step it lingers through, while an earned fold costs one transition and stays recoverable. Deferring a fold you have already earned is drag, not caution. Recoverability, though, is insurance against accidents, not a license for half-done extraction — fold scraps you barely understood and you get **thrash**, immediately rereading what was just folded, paying for the fold and the reread both; and what you never extracted, you will not know to go back for.

The working budget (the smaller of the model window and 400K) is information, not a deadline. Numbers carry no instruction; running past a number to finish a clean extraction is right, folding dirty to stay under one is wrong. When genuinely long work outruns useful folding, native compaction remains an acceptable backstop.

The gauge on tool results is proprioception, and it reads left to right — state first, then what a fold would return:

```text
[ctx 51% budget · 20% window · fold@turn→22% · fold@task→9%]
```

- `51% budget` — pressure against your attention budget. Advisory, breakable for a clean extraction.
- `20% window` — room left in the physical window. The hard runway. When the window is at or under the budget cap the two coincide and only this needle shows.
- `fold@turn→22%` — projected budget pressure if you folded to the nearest structural reference: the most recent user-request boundary, or a save point if one sits closer. Phase and burst granularity.
- `fold@task→9%` — the same projection at the earliest reference on this spine: the first save point, else the first user boundary. Task-chain granularity.

A fold needle is omitted when its reference point does not exist — a short spine, or both granularities resolving to the same node. Absent is a fact; a fabricated zero is not. The needles are unconditional otherwise: an early-session `fold@turn→2%` is a parked speedometer reading zero, not noise.

**Projections measure; the extraction bar decides.** A needle answers only "how much would this fold return", never "is this fold earned". A projection close to current pressure means that fold would return nothing — folding anyway costs a transition and a summary layer for no representation gain, which is what a zero-distance fold looks like from the outside: labeling a point and immediately traveling to it. Two references are shown precisely so the numbers offer a choice of scale rather than a ranking.

### The moves

- **Save** — `acm_checkpoint` labels the current state so it can be found again; it never blocks, branches, or folds anything. Save before a risky attempt, before a large ingest you may later fold away, at a validated baseline, at a fork in strategy, before folding raw history. Recoverability is what makes bold compression and bold exploration cheap. File backups protect the disk; a checkpoint protects this conversation — a risky step deserves both.
- **Orient** — `acm_timeline` shows the spine, save points, summary depth, usage, and sync state. It reports facts; what they justify stays your call.
- **Fold** — `acm_travel` replaces lived process with its **handoff**, and is as recoverable as a save: the raw path stays in the tree behind a pointer, one travel away. Choose the target by what it precedes — the last clean point before the material being folded — not by which label is nearest or best named.
- **Rebase** — a fold to an earlier base. When summaries stack or start competing over what is authoritative, merge everything that survives into one handoff at the earliest base that passes cold start without growing projected summary depth. Root is a candidate, never a default.
- **Rehydrate** — travel toward an archived branch to recover one exact detail. Save your return point first, fetch the detail, then travel back carrying the extract.
- **Fork** — save the fork point, explore one direction freely, and either fold the winning path forward or travel back to the fork carrying what the failed direction proved in `exclusions`.

### The tree is where answers live

Everything this session ever knew — every fold, every abandoned branch, every earlier phase — remains in the tree. When you are missing something the session once held, the answer is in the tree: search the timeline, rehydrate the branch, reread the archived handoff. Do not ask the user to repeat what the session already knows, and do not rebuild from files what a handoff already settled. Asking again is a navigation failure, not caution.

### Where folds belong

A fold is a step you place, not a moment you sense — the perception layer is only a gauge. When you lay out the work ahead, a fold point is a candidate step alongside tests and commits: place it where the extraction will close. When a new request arrives that needs only the conclusions of the previous stretch and not its process, that stretch is already at a candidate position. Judging that "there is nothing here worth folding" is equally a complete judgment — its substance is being able to name what raw material must stay live, and why. A fold belongs to your own plan, not to the narration you give the user. At each placed fold, ask what the road ahead needs from what just happened — then pack exactly that. Between fold points, compress continuously — integrate observations into conclusions as you go — so that when the fold step arrives, the extraction is already closed. Fold in batches: commit representation gains in meaningful units, not after every step. Check the Compression Candidate, Compressibility, Attention effect, Recovery value, and Transition effect; then choose the net-positive move or continue with the current working set. Managing the context is overhead, not deliverable: no narration, no ceremony — the work itself stays the subject.

### The handoff

`acm_travel` takes a structured handoff with seven fields: `goal`, `state`, `evidence`, `external`, `exclusions`, `recover`, and `next`. Supply every field; write `none` only for an empty supporting field. Runtime owns the durable text format.

**Cold start** is the integrity test: knowns remain known, uncertainty remains open, current obligations survive, and `next` is executable — one concrete action a fresh agent could execute immediately. And the survivor must still sound like the same person: same priorities, same suspicions, same next move. `state` therefore carries live cognition, not a report: knowns, open unknowns, competing hypotheses with their current weights, surviving fronts, and the hot set. A fold mid-investigation:

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

The failure mode is the results-only report: a `state` like "investigated latency, ruled some things out, will keep looking" loses the hypotheses, the evidence weights, and the hot values — it reads as a status update and fails cold start. A handoff you cannot write concretely is the extraction bar telling you the fold is not yet earned.

### After the fold

A tool call is a request; only its matching result is fact — applied, not applied, or indeterminate. Read the receipt once.

After an applied travel, the handoff is your authoritative state: execute `next`. Do not re-derive what it settled — rereading folded material "to make sure" is the exact cost the fold existed to remove. If one specific claim is load-bearing and genuinely uncertain, verify that claim against its pointer: a bounded spot-check, not a re-derivation. Travel rewrites conversation context only: files, processes, and external systems keep the state recorded in `external`.
<!-- ACM:CORE:END -->
