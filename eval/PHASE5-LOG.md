# Phase-5 Log — Gradient-pressure design: 道 vs nudge vs habit, within one session

## Why Phase-5 exists

Phase-4 showed Phases 1–3 measured "guidance + nudge under artificial 60K pressure", and the
native-window baseline showed 道 alone drove nothing for opus (zero ACM) and save-only for sol.
But native and 60K are *separate* runs — between-run variance (n=2) makes the contrast noisy,
and neither run can answer the real question: **is folding a habit (fires regardless of
pressure) or a reflex (fires only under pressure)?**

Phase-5 packs three pressure regimes into ONE session (user's design):

- **Regime A** — below the 30% nudge tier: does ACM happen with zero pressure? (道-only)
- **Regime B** — above 30%: does ACM happen under the nudge gradient?
- **Regime C** — after a pressure-era travel releases the pressure: does ACM fire *again*
  with no pressure? (habit persistence — the habit-vs-reflex discriminator)

## Design

- New `exprlang-xl-flow` (eval/flow.mjs): 14 phases. P1–P6 reproduce the standard arc
  (~26K tokens, below the 30K threshold at a 100K window), P7–P11 climb the gradient
  (variables / comparisons / scientific notation / error positions / milestone-2 review),
  P12–P14 are the post-travel observation segment (-2^2 semantics / recall / final review).
- Window: `--context-window 100000` (30% tier = 30K, crossed at the midpoint by design;
  compaction reserve 16K → ~84K ceiling).
- Regime boundaries are assigned **mechanically** from events.jsonl by `eval/regimes.mjs`:
  max-per-turn assistant usage vs the 30K threshold, and the first non-error acm_travel —
  wherever they actually happen, not where the flow predicted them. (Max, not last: a
  mid-turn travel shrinks later readings and would hide a real tier crossing.)
- Variant `p5gradient`, gitHead 9fa394ab (v3 道 from Phase-4: habit-reframed CORE +
  fold-honesty guard). One run per model, five models concurrent, judge=opus rubric v1.

## Results (n=1 per model)

| model | A (no pressure) | B (nudge gradient) | C (post-travel) | peak | judge overall | task |
|---|---|---|---|---|---|---|
| opus4.8[medium] | **fold @21.2K, zero nudges** | pressure never formed | re-fold P10 (nudge-adjacent) + correct restraint | 36% | 3/3 strong | 3/3 |
| sol[medium] | saves ×4, no fold | fold after 30% nudge | **re-fold before any new-cycle nudge** + timeline-guided rebase-to-root | 55% | 3/3 strong | 3/3 |
| mimo2.5-pro[high] | zero ACM | fold after 50% nudge (shallow, -8.5K) | none (nudges silenced — see below) | 56% | 2/3 strong | 3/3 |
| deepseek-v4-flash[high] | zero ACM | shallow fold after 50% nudge (near-HEAD target) | checkpoints only; ignored timeline's rebase hint; **hit compaction @96%** | 96% | 2/3 mid | 3/3 |
| kimi-k2.7-hs[high] | save only (P3, precise) | **zero fold despite 30/50/70 nudges** | no travel ever | 83% | 2/3 mid | 3/3 |

### The three questions, answered

1. **Does ACM fire with no pressure?** Split by model. opus folded at 21.2K with zero
   nudges — pure 道-driven fold, the Phase-4 v3 goal, achieved in the gradient window.
   sol saved (×4) but did not fold; mimo/deepseek did nothing; kimi saved once.
   道-driven *fold* remains opus-only; 道-driven *save* reaches sol and kimi.
2. **Does ACM fire under pressure?** 4/5 folded in the gradient (sol @30% tier,
   mimo/deepseek @50% tier; opus never let pressure form). **kimi ignored all three
   tiers** and rode to 83% — the nudge is a backstop, not omnipotent.
3. **Does ACM re-fire after pressure release?** sol: yes — spontaneous re-fold plus a
   timeline-guided rebase-to-root before any new-cycle nudge. opus: yes, second fold
   (nudge-adjacent). mimo: no — but its nudge cycle had been silently disarmed (below).
   deepseek: checkpoints only. kimi: never traveled.

### The headline contrast

opus's habitual folds kept its peak at **36%** — the habit *prevented* the pressure zone
from forming (self-defeating prophecy for regime B). kimi ignored every nudge and peaked
at **83%**. Same flow, same guidance, opposite ends: 道-driven vs reflex-less.

## Contract-level findings (not model behavior)

1. **Shallow folds + same-turn regrowth silently disarm the nudge cycle.** mimo folded to
   a *recent* checkpoint (-8.5K, 53.4K→44.8K), then kept working the same turn; the
   post-transition baseline was established at 52.7K with `highestReachedLevel: 50`, so
   the 30%/50% tiers were consumed for the rest of the cycle — context re-climbed to 56%
   with zero further nudges. A fold that lands above the tier you just consumed mutes the
   backstop. Candidate contract discussion: baseline from the travel result's
   est.-after tokens instead of first post-transition usage, or floor the new cycle's
   highest level by the landing tier.
2. **Fold DEPTH is the hidden variable.** opus/sol rebased to root (-50%+ context);
   mimo (-16%) and deepseek (~0%, near-HEAD target) folded shallow. Judge scores rewarded
   precise targets, but pressure relief differs by an order of magnitude — depth belongs
   in the rubric (or in the travel result cues) explicitly.
3. **Compaction is reachable in this design.** deepseek peaked at 96.2K and native
   compaction fired (96.2K→37.3K), polluting its regime C (cycle reset came from
   compaction, not travel). Verbose models need headroom: 120K window or a
   maxTokensCap review for future gradient runs.
4. **The seven-slot hard gate works in the wild.** mimo's first travel was rejected
   (missing Evidence/Exclusions/NEXT, "nothing was mutated"), corrected, succeeded.
5. **regimes.mjs extraction validated two ways**: opus P6 max 21.2K < 30K (consistent
   with zero pre-travel nudges) and P10 max 36.4K (consistent with the single 30% nudge
   that fired mid-P10). Token accounting: local-openai reports input and cacheRead
   separately (sum = context); double-counting checked and excluded.

## Cross-phase reading

- The pending p4habit question ("can 道 alone make opus fold at low pressure?") is
  **answered yes for opus[medium] in the gradient window** — with high-quality timing
  (milestone-only folds, restraint elsewhere). The native-window confirmation run is
  still open but now expects success.
- Phase-4 native said sol "saves but never folds". Phase-5 refines: sol folds
  *nudge-responsively* (30% tier) and *habitually* post-travel. The fold instinct exists;
  at native windows it just never gets a trigger.
- kimi is the new hard case: immune to both 道 (no fold in A) and nudge (zero fold in B).
  If a structural/weak-model seam detector is ever prototyped (the "external judge"
  idea), kimi is the benchmark model it must move.

## Limitations

n=1 per model; single flow shape (coding); judge is opus judging opus (mitigated by
mechanical regime assignment — the A/B/C facts above do not depend on the judge);
deepseek's C segment confounded by compaction; opus's regime B is empty *by design
success* (its folds prevented pressure), so Q2 for opus rests on one nudge-adjacent fold.

## Artifacts

- Runs: `eval/.runs/2026-07-17T12-28-27-587Z-flow-{deepseek-v4-flash,mimo-v2.5-pro,gpt-5.6-sol,claude-opus-4-8,kimi-k2.7-code-highspeed}-p*`
- Flow: `eval/flow.mjs` (`exprlang-xl-flow`); annotator: `eval/regimes.mjs`
- Reproduce: `bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p5gradient --context-window 100000 --flow exprlang-xl-flow`
