# Phase-8 Log — Four models × five guidance versions: which text sells the fold?

## Why Phase-8 exists

Phases 5–7 established *who* internalizes 道 (gpt-5.5, opus-4.8, terra, sol) under the
current v3 guidance. Phase-8 crosses those four internalizers with **five pi-context
versions** to answer the variant question directly: which guidance text actually moves
ACM behavior, and which text produces pathology? Same XL flow, full-env harness,
400K window (30% tier = 120K), n=1 per cell, judge=opus-4.8 v1 rubric, all runs
de-primed (no user hint that ACM exists).

Versions under test:

| column | anchor | what it is |
|---|---|---|
| **fableprev** | 31b38310 (`.wt-fable-before`) | pre-redesign baseline guidance |
| **fable** | e9008476 (`.wt-fable-after`) | "compression-as-intelligence" redesign |
| **head (v3)** | c0383eec (main `src`) | current 道/术/度 layered guidance + baseline-seeding fix |
| **pr12** | 07d53ee3 | judgment-layers proposal (#10 spine + #11 layers map) |
| **pr14** | df6b28ac | grok's "working-set judgment" redesign |

## Results (20/20 runs, task_completion 3/3 everywhere)

Fold/nudge ordering verified mechanically from events.jsonl (first
`acm:context-usage-reminder` message_start vs first `acm_travel`
tool_execution_start), not from judge impressions. "纯道" = first travel precedes any
reminder; "nudge" = reminder first.

| model | fableprev | fable | **head (v3)** | pr12 | pr14 |
|---|---|---|---|---|---|
| **gpt-5.5** [medium] | 22 ckpt, **0 fold** — 打点刷屏; 2/3 mid | fold P14 (nudge) + 4 ckpt; 3/3 strong | **fold P7 @57.5K (14%) 纯道零nudge** + 1 ckpt; 3/3 strong | 19 ckpt, **0 fold**; 2/3 mid | 10 ckpt, **0 fold** (peak 29%, nudge silent); 2/3 mid |
| **gpt-5.6-sol** [high] | 37 tv + 47 ckpt — **过折 thrash** (timing 1/3); 2/3 strong | fold P9 (nudge) + 9 ckpt; 3/3 strong | **6 tv 纯道**: P1 rehydrate 往返 @34.1K + folds P10/P12/P14; 3/3 strong | 12 tv + 36 ckpt — **机械 travel-to-root overfold**, 近空折 (timing 1/3); 2/3 strong | 11 ckpt, **0 fold @ peak 48%** (两次 nudge 全无视); 1/3 mid |
| **claude-opus-4-8** [max] | 7 ckpt, **0 fold**; 2/3 mid | **0 ACM**; 1/3 mid | fold P10 (nudge-responsive) + 1 ckpt; 2/3 mid | 7 ckpt + fold P14 (nudge; 折后丢 NEXT→README 任务退化); 2/3 strong | **0 ACM**; 1/3 strong |
| **gpt-5.6-terra** [high] | 46 ckpt + 3 tv — 刷屏+双 rebase thrash; 3/3 strong | fold P10 (nudge) + 1 ckpt; 2/3 mid | fold P8 @121.7K (nudge-adjacent) + P14 travel, 2 ckpt; 2/3 strong | **fold P7 @116K (29%) 纯道 + rebase-to-root P8**, 37 ckpt; 3/3 strong | 12 ckpt, **0 fold @ peak 51%** (30%/50% nudge 全无视); 2/3 mid |

Column totals (judge overall, folds, pathologies):

| column | folds | pure-道 folds | thrash/overfold | spam-no-fold | zero-ACM | judge Σ |
|---|---|---|---|---|---|---|
| **head (v3)** | **4/4** | **2** (gpt55, sol) | 0 | 0 | 0 | 10 |
| fable | 3/4 | 0 | 0 | 0 | 1 (opus) | 9 |
| pr12 | 3/4 | 1 (terra) | 1 (sol) | 1 (gpt55) | 0 | 9 |
| pr14 | **0/4** | 0 | 0 | 3 (gpt55, sol, terra) | 1 (opus) | 6 |
| fableprev | 2/4 | 0 | 2 (sol, terra) | 2 (gpt55, opus) | 0 | 9 |

## Findings

1. **head (v3) is the only column where every model folds — and the only one with
   zero pathology.** All four internalizers fold; two do it below the nudge
   threshold with no reminder at all (gpt-5.5 @14%, sol's P1 rehydrate @34.1K).
   Checkpoint counts stay lean (1/4/1/2). No thrash, no spam, no zero-ACM cell.
   The 道/术/度 layering is the only text that sells the *fold* to everyone it
   reached in Phase-7.

2. **fableprev is the pathology column: every cell is either thrash or spam.**
   sol over-folds 37× (near-empty travels, timing 1/3), terra spams 46 ckpt +
   double-rebase thrash, gpt-5.5 spams 22 ckpt with zero folds, opus 7 ckpt zero
   folds. The pre-redesign text activates the *tools* without the *judgment* —
   the worst of both worlds.

3. **pr14 suppresses the fold — for all four models.** opus goes zero-ACM (its
   only zero cell outside fable); gpt-5.5, sol and terra all degrade to
   checkpoint-only: terra ignores both 30% and 50% nudges and rides to 51% peak,
   sol ignores two nudges at 42–48%. Whatever the "working-set judgment" rewrite
   says, it reads as "bookmark, don't breathe" to every internalizer.

4. **pr12 is a coin-flip column.** It produces the single best pr12 cell
   (terra: pure-道 fold @29% + timeline-guided rebase-to-root, 3/3) *and* a
   sol overfold thrash (12 mechanical travel-to-root, near-empty folds at 5–18%
   pressure) *and* a gpt-5.5 spam-no-fold (19 ckpt). High variance = the
   judgment-layers map gives strong models hooks but no stable cadence floor.

5. **fable sits between: folds happen but late and nudge-driven.** 3/4 models
   fold, all after the 30% reminder; opus goes zero-ACM. It fixes fableprev's
   thrash/spam but doesn't sell sub-threshold folds to anyone.

6. **The fold instinct, not the save instinct, is the guidance-sensitive
   behavior.** Checkpointing appears in 17/20 cells across all versions (it's
   nearly free and universally understood); folding is what varies by column —
   from 4/4 (head) to 0/4 (pr14). Save-vs-fold dissociation (Phase-7 finding 3)
   is confirmed as *the* variant discriminator.

7. **Task completion stays decoupled** — 20/20 cells at 3/3, including
   thrash runs. One caveat: opus-pr12 folded at P14 and lost its own NEXT slot
   (README update), degrading the final deliverable — the first observed
   fold-induced task regression in the series.

## Verdict

**head (v3) wins Phase-8.** It is the only version that gets every internalizer
to fold, the only one with sub-threshold pure-道 folds, and the only one with no
pathological cell. fable is a safe second (late but sane). pr12 is too
variance-heavy to ship as-is. pr14 actively suppresses folding. fableprev
explains why the redesign was needed.

## Artifacts

- Runs: `eval/.runs/2026-07-17T1[67]*-flow-{gpt-5.5,gpt-5.6-sol,gpt-5.6-terra,claude-opus-4-8}-p*`
  (r1 timed-out runs superseded by r2: terra-head/fableprev, sol-head/fable, gpt55-fableprev)
- Re-judge tool: `bun eval/rejudge.mjs <runDir>...` (rebuilds judge prompt from
  persisted transcript.txt; used for 3 parse-failed runs)
- Reproduce: `bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p8<col> --full-env --context-window 400000 --flow exprlang-xl-flow --timeout-scale 2`
