# Phase-6 Log — Can three targeted 道-level tweaks move kimi's first fold? (No.)

## Why Phase-6 exists

Phase-5 isolated kimi-k2.7-highspeed as the hard case: immune to 道 (no fold in the
no-pressure regime) AND to the nudge (zero fold across all three tiers, rode to 83%).
Before reaching for heavier machinery (a structural/weak-model seam detector), test the
cheapest hypothesis class first: three one-sentence CORE tweaks aimed at kimi's three
diagnosed gaps — first-fold bootstrap, fold depth, and cruise-spot clarity at big windows.

## Design

- Same harness as Phase-5: `exprlang-xl-flow`, 100K window, kimi[high], judge=opus v1.
- Baseline = main src @ 375fe529 (v3 道 + the baseline-seeding nudge fix). Variants =
  worktrees at the same commit, ONE sentence changed in CORE.md each, guidance regenerated:
  - **V-A `p6sweet`** (cruise clarity): the cruise sentence now spells out that the working
    budget is an attention budget, not a memory limit — above 400K, cruise is ~120K tokens
    (12% of 1M, not 300K). Target: kimi may misread "cruise ≈ 1/3 of budget" at a 1M window.
  - **V-B `p6depth`** (fold depth): Fold bullet gains "fold deep enough to land back in
    cruise… a shallow fold is a rebase deferred, with interest." Target: Phase-5's
    shallow-fold failure (mimo/deepseek).
  - **V-C `p6chainstart`** (first-fold bootstrap): Save bullet gains "when a distinct user
    goal begins, save a start point before diving in — it pre-positions the target the
    first fold will need." Target: make the first fold cheap by pre-positioning its target.
- n=2 per condition, 8 runs concurrent. Variant injection verified in each worktree's
  generated-guidance.ts. Reference: Phase-5 kimi baseline = 0 folds, 1 checkpoint, peak 83%.

## Results (8/8 runs)

| condition | run 1 | run 2 | folds |
|---|---|---|---|
| p6base | **fold P9** — nudge-responsive (after 50% tier), target=P7 checkpoint, 52.9K→33.0K (-38%), handoff 3/3, judge 2/3 | **fold P5** — OVER-FOLD at the recall question, NEXT lost the pending answer, task 2/3, judge 2/3 | **2/2** |
| p6sweet | 1 checkpoint (P7), judge 1/3 | zero ACM, judge 1/3 | 0/2 |
| p6depth | zero ACM (judge parse failed) | 1 checkpoint (P7), judge 1/3 | 0/2 |
| p6chainstart | zero ACM, judge 1/3 | 2 checkpoints (P7 in regime A, P10; judge parse failed) | 0/2 |

Task completion 3/3 everywhere except p6base-2 (2/3 — the over-fold cost the P5 answer).

## Findings

1. **No variant produced a single fold (0/6); the baseline produced two (2/2).** The
   tweaks show no lift, and if anything the added sentences dilute. With n=2 per condition
   this is exploratory, not proof of harm — but there is no signal worth chasing at this n.
2. **kimi's first fold is high-variance, not absent.** Same guidance, same flow: Phase-5
   0/1 folds, p6base 2/2 folds. The first-fold bottleneck is real (Phase-5) but
   stochastic — single runs cannot rank conditions; future kimi experiments need n≥3.
3. **The 375fe529 baseline-seeding fix is validated in the wild.** p6base-1's post-travel
   cycle re-armed correctly: baseline seeded from the landing estimate (33.0K), 50% tier
   fired again at turn 14. Contrast Phase-5 mimo: shallow fold + same-turn regrowth
   silenced the cycle at 52.7K. The contract bug is gone.
4. **New failure mode observed: kimi over-fold.** p6base-2 folded AT the P5 recall
   question and lost the pending answer in NEXT — the exact fold-honesty failure the v3
   guard was written against (opus Phase-4 P2). The guard reaches opus, not kimi:
   task_completion 2/3, the only task damage of the round.
5. **Checkpoints cluster at P7 in every condition** (base-1, sweet-1, depth-2, chain-2) —
   the variables-feature goal boundary is kimi's one salient save point, variant or not.
   V-C was designed to produce exactly this and did not raise the rate above baseline.
6. **Fold depth, when folds happen, is mid-range and sane.** p6base-1 folded to the P7
   checkpoint (-38%, landing at 33% ≈ cruise) after consulting timeline — not near-HEAD
   (Phase-5 deepseek) and not root. V-B's depth sentence had no fold to act on.

## Conclusion

kimi's zero-fold behavior is **not addressable by 道-level one-sentence tweaks** — not
cruise clarity, not fold depth, not first-fold target pre-positioning. Combined with
Phase-5 (nudge-immune), this closes the text-intervention hypothesis space for kimi at
the current guidance budget. The remaining lever for kimi-class models is an **active,
non-pressure signal** (structural seam detector or weak-model judge — the "external
judge" idea), now with a clean benchmark: any such mechanism must produce ≥1 fold on
this flow where 8 text-condition runs produced 2 (both baseline, one of them harmful).

For the guidance itself: keep v3 + the baseline-seeding fix; do NOT land any of the
three variant sentences (no lift, dilution risk, ACM_CORE budget stays 5980/6000).

## Artifacts

- Runs: `eval/.runs/2026-07-17T14-28-39-25*Z-flow-kimi-k2.7-code-highspeed-p2*`
  (p6base p20021/p20032, p6sweet p20040/p20055, p6depth p20060/p20064, p6chainstart p20071/p20073)
- Variant worktrees (uncommitted, disposable): `.wt-v-sweet`, `.wt-v-depth`, `.wt-v-chain`
- Reproduce: `bun eval/run-flow.mjs --model local-openai/kimi-k2.7-code-highspeed --thinking high --variant <label> --context-window 100000 --flow exprlang-xl-flow [--extension <worktree>/src/index.ts]`
- Judge parse failures (2/8: p6depth-1, p6chainstart-2): mechanical facts (tool calls,
  regimes) stand in for dimension scores; both runs had zero folds regardless.
