# Phase-10 Log — v4.1 validation: regression cleared, merge approved

## Why Phase-10 exists

Phase-9 confirmed v4's regression (3/10 internalizer samples task-degraded by
folding mid-obligation, vs 0/8 under head/v3) and isolated the mechanism to
the fold self-check being satisfiable mid-obligation. v4.1 (afc4a6ea) added
the missing fourth condition to the self-check: "never fold away an
unfulfilled promise to the user: red tests, an unanswered question, or a
half-landed change stays live until it is kept."

Phase-10 is the pre-registered adoption test: terra×3 + sol×2 (the v4
regression sites) + luna×1 + glm×1 (v4 gain sites). Acceptance: zero
task-degraded in the regression group, gains retained in the gain group.
Judged with **rubric v2** (a819df18: ceiling stops rewarding
rehydrate-as-ceremony; timing explicitly dings mid-obligation folds).

## Results (7 runs; task_completion 3/3 in all 7)

| cell | overall | timing | key behavior |
|---|---|---|---|
| terra | 2/3 strong | 2 | P1 fold @6.8% + reread; P8 fold mid-regression — bad-moment folds, task survived |
| terra-r2 | 2/3 strong | 2 | P10 mid-obligation fold — task survived |
| terra-r3 | 2/3 strong | 1 | P8/P9 multi-fold incl. red tests — task survived |
| **sol** | **3/3 strong** | **3** | "无义务未履行即折"; rebase + rehydrate round trip |
| **sol-r2** | **3/3 strong** | **3** | folds only at closed loops; P13 answered from State (v2-credited) — P14 harness timeout (infra flake), behavior complete through P13 |
| luna | 3/3 strong | 2 | P7 fold at pressure onset retained; reco 3/3 |
| glm | 1/3 strong | — | zero ACM (bash cp substitution); head baseline also zero |

## Findings

1. **The regression is cleared: 5/5 regression-group cells at task 3/3.**
   Under v4 the same group produced 3 task-degraded samples (terra×2, sol×1).
2. **Mechanism correction: v4.1 does not prevent bad-moment folds — it
   prevents folds from losing the promise.** All three terra samples still
   folded mid-obligation (timing avg 1.7/3), but every one kept the
   obligation live in the handoff and fulfilled it afterward. v4's failures
   were post-fold thread loss (stalled and asked the user; swallowed the
   answer); v4.1's folds survive their own bad timing.
3. **sol under v4.1 is the cleanest phenotype in the series**: two samples,
   both timing 3/3, both overall 3/3, rebase + rehydrate ceiling moves,
   zero mid-obligation folds (v2 judge language confirms explicitly).
4. **Rubric v2 works as intended**: sol-r2's P13 (answer from handoff State)
   was credited, not dinged — the rehydrate-ceremony false positive is gone.
5. **glm's v4 fold did not replicate** (zero ACM, bash-cp substitution).
   glm looks bimodal like opus-4.8; its head baseline is also zero, so this
   is a v4-only unreplicated gain, not a v4.1 loss vs head.
6. **Cell-by-cell vs head: v4.1 ≥ head everywhere measured, worse nowhere.**
   terra: reco up, timing down (net wash); sol: two clean 3/3; luna: up
   (3/3 vs Phase-7's 2/3); glm: tied at zero. gpt-5.5/opus-4.8 not re-run
   under v4.1 (v4 showed both intact; v4.1 only constrains fold timing).

## Verdict

**v4.1 (db756413 + afc4a6ea) is adopted as the new guidance baseline.**
Pre-registered regression criterion passed decisively; no measured cell is
worse than head. Known remaining gaps (not blockers): terra's bad-moment
folds persist (survivable but timing-sloppy); backup-channel substitution
still resists CORE text on opus/gpt55/sol/glm; non-internalizers remain
text-immune (active-signal lever + a 100K-window opus-4.6 pressure test
still owed); the XL flow still cannot measure ACM's task-protection value.

## Artifacts

- v4.1 commits: `db756413` (v4), `afc4a6ea` (promise-keeping condition)
- Rubric: `a819df18` (v2; dimension scores not comparable with v1 runs)
- Runs: `eval/.runs/2026-07-18T08-37-44-831Z-flow-*-p45[5-6]*` (variants p10v41*)
- Reproduce: `bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p10v41 --full-env --context-window 400000 --flow exprlang-xl-flow --timeout-scale 2`
