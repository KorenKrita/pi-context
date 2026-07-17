# Phase-7 Log — Seven models × two windows: who does 道 reach, who does pressure move?

## Why Phase-7 exists

Phases 5–6 mapped five models at a 100K gradient window. Phase-7 widens the model net and
crosses it with the pressure dimension in one matrix: **native window** (1M, 400K budget —
the XL flow peaks at 5–15% pressure, nudge structurally silent → 道-only) vs **200K window**
(30% tier = 60K, crossed late in the flow → 道 + late nudge). Same XL flow, same v3 guidance
+ baseline-seeding fix (72e5fd28), n=1 per cell, judge=opus v1.

## Results (14/14 runs, task_completion 3/3 everywhere)

| model | native (道-only) | 200K (道 + late nudge) |
|---|---|---|
| **gpt-5.5[medium]** | **fold P7 @31.2K — pure 道 (7.8% of budget)** + 3 ckpt; 2/3 strong | **fold P10 @44.7K — pure 道 (22% of 60K threshold)** + 3 ckpt; 2/3 strong |
| **gpt-5.6-terra[high]** | ~20 checkpoints (mechanical, harmless), no fold; 2/3 mid | **fold P7 @41.1K — pure 道** + **rebase-to-root P11 @61K (nudge-adjacent)**; **3/3 strong** |
| **gpt-5.6-luna[max]** | fold P14 @123.1K — **nudge-adjacent** (30% tier fired first) + ckpt discipline; 2/3 strong | fold P7 @73.4K — nudge-adjacent (crossed 60K) + ckpts; 2/3 strong |
| **claude-opus-4.6[max]** | zero ACM; 1/3 | zero ACM — peak 53.3K = 27%, **nudge never fired**; 1/3 |
| **glm-5.2[high]** | zero ACM; 1/3 | 3 precise save-before-risk ckpts, no fold; 2/3 mid |
| **deepseek-v4-pro[max]** | zero ACM; 1/3 weak | 1 ckpt, no fold; 1/3 weak |
| **mimo-v2.5[high]** | zero ACM; 1/3 | 1 nudge-responsive ckpt @68.5K, no fold; 1/3 |

Fold/nudge ordering verified mechanically from events.jsonl (reminder custom messages vs
acm_travel tool calls), not from judge impressions.

## Findings

1. **The gpt family internalizes 道; nobody else in this round does.** gpt-5.5 folded
   *below the nudge threshold in BOTH windows* — the only pure 道-driven folder of the
   round, and the first native-window fold in the series (Phase-4/5 native runs were all
   zero-ACM or save-only). terra's first 200K fold was also sub-threshold (道), its rebase
   nudge-adjacent. luna folded only after a nudge in both windows.
2. **The internalizer/non-internalizer line is NOT capability tier.** gpt-5.5[medium]
   out-folds claude-opus-4.6[max] (zero ACM in both cells). Cross-round internalizers:
   opus-4.8, gpt-5.5, terra, luna(pressure-assisted), sol(pressure-assisted).
   Non-internalizers: kimi, mimo×2, dspro, glm, opus-4.6.
3. **Save-vs-fold dissociation is the norm for non-internalizers.** glm (3 precise
   save-before-risk), terra-native (~20 mechanical checkpoints), luna-native (full ckpt
   discipline) — the save instinct lands widely; the fold instinct is what 道 must sell,
   and it only sells to some.
4. **opus-4.6[max] is untested on pressure, not proven immune.** Its 200K run peaked at
   27% (terse model, few tool calls) — the nudge never fired. A 100K-window run would
   cross 30% around P8–P9. Its native zero-ACM replicates opus-4.8's Phase-4 native
   baseline — the claude line needs pressure (or had it, for 4.8@100K).
5. **Checkpoint spam is real but harmless.** terra-native checkpointed ~2/phase
   (judge: "event-driven-overfold" tendency) — zero context cost, no task damage, but it
   is ritual, not management. The rubric's timing dimension already dings it.
6. **Every model completed every task (14× 3/3).** ACM behavior and task quality remain
   fully decoupled in this flow.

## Cross-phase model map (all rounds, XL/long flows)

| profile | models |
|---|---|
| 道-driven folder (folds below threshold) | **gpt-5.5**, opus-4.8, terra (first folds) |
| pressure-responsive folder | sol, mimo-v2.5-pro, ds-v4-flash, luna, terra (second folds), kimi (intermittent, high-variance) |
| save-only | glm-5.2, mimo-v2.5, kimi (typical), terra-native |
| zero ACM | opus-4.6 (pressure untested), ds-v4-pro, glm-native, mimo-native |

## Implications for variant work (user's direction)

道-level variant comparison belongs on **internalizers** — gpt-5.5 (purest), opus-4.8,
terra — where guidance text actually moves behavior. Non-internalizers need the active
signal lever (seam detector / external judge), not more text (Phase-6 closed that).
opus-4.6 @100K is the one missing cell before declaring the claude line
pressure-dependent.

## Artifacts

- Runs: `eval/.runs/2026-07-17T14-59-10-6*Z-flow-*` (p34691–p34797)
- Reproduce: `bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p7native|p7cw200k [--native|--context-window 200000] --flow exprlang-xl-flow`
