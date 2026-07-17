# Phase-3 Log — Does the v2 conclusion GENERALIZE beyond the exprlang coding flow?

**Question:** all Phase-1/2 results came from ONE synthetic flow (exprlang, 6 coding phases with
tests-green exhales). Does the v2 conclusion (proactive fold for large models, safe for small,
no regression) hold on a genuinely DIFFERENT task shape?

**New shape = knowledge work.** `cadence-research-flow`: investigate a fictional platform's design
docs (`eval/fixtures/cadence-docs/`, 5 interlinked .md, zero ACM terms), answer cross-doc questions,
reconcile a planted contradiction, produce prose. No code, **no tests, no "green" exhale** — fold
points are synthesis boundaries; sediment is accumulated reading/analysis.

Planted answer key (agent never told):
- Contradiction (P3): scheduling.md "up to 5 retries / 6 attempts, authoritative" vs operations.md
  "at most 3 times" (an ops guardrail below the system max). Correct reconciliation defers to
  scheduling.md as the authority and/or explains 5=system-max vs 3=ops-guardrail.
- Buried detail (P5): STANDARD per-attempt wall-clock timeout = 900s, stated once in operations.md.

**Harness changes (this branch, uncommitted):** `flow.mjs` adds RESEARCH_FLOW + `getFlow()` + per-flow
`taskCompletionDesc`; `run-flow.mjs` adds `--flow` selector (default exprlang-long-flow) and threads
`taskCompletionDesc`; `judge.mjs` parameterizes the task_completion dimension. The research P1 is a
heavy open-ended synthesis → sol timed out at the default 420s; use `--timeout-scale 2.0` for this flow.

## Results — cadence-research-flow (variant p3research, --timeout-scale 2.0)
> NOTE: mimo was first run at thinking=off; user directed "别跑off 我平时也不用off" (off is unrepresentative). mimo re-run at **medium**; the off rows are DISCARDED from the conclusion.

**sol[medium] n=3 clean** (1 extra run timed out on P1 over-generation — harness artifact, not an ACM failure):
| run | sig | act | tim | hand | rec | ceil | task | peak% |
|---|---|---|---|---|---|---|---|---|
| 1 | `..T...` | 2 | 2 | 3 | 3 | 2 | **3** | 37 |
| 2 | `..T...` | 3 | 3 | 3 | 3 | 2 | **3** | 35 |
| 3 | `T.....` | 2 | 2 | 3 | 2 | 1 | **3** | 30 |
→ Folds proactively on knowledge work, hand=3 all, task=3 all, rec 3/3/2. **Clean generalization.**

**opus[high] n=3** — activation GENERALIZES (3/3 activate, NO zero — *better* than exprlang's 2/3), but fold DISCIPLINE degrades:
| run | sig | act | tim | hand | rec | ceil | task | peak% |
|---|---|---|---|---|---|---|---|---|
| 1 | `TT.T..` | 3 | 2 | 3 | 1 | 1 | **2** | 35 |
| 2 | `.T....` | 3 | 1 | 3 | 2 | 2 | **2** | 36 |
| 3 | `.T....` | 2 | 1 | 2 | 2 | 1 | **2** | 35 |
→ **task=2 in ALL 3 runs (REPLICATES).** timing weak (2/1/1). Folds swallow undelivered answers / rehydrate-misses inject factual slips. On no-green-signal research work opus OVER-folds and mildly degrades the deliverable — a shape-specific weakness the single coding flow hid.

**mimo[off] n=3 — DISCARDED (unrepresentative):** `.....T`/`......`/`.....T`, task=3 all but act 1/0/1, low pressure (~25%). Re-running at medium.

**Small models on research (representative thinking; mimo re-run at medium):**
| model | n | sigs | act | task | vs exprlang |
|---|---|---|---|---|---|
| kimi-k2.7[high] | 2 | `......` `......` | 0/0 | 3,3 | was 2/3 FLAWLESS on code → goes SILENT on research |
| deepseek[max] | 2 | `.....T` `......` | 1/0 | 3,3 | was 3/3 active on code → nearly silent |
| mimo[medium] | 3 | `......` `....T.` `......` | 0/1/0 | 2,2,3 | silent; task dips are raw research competence (no fold → NOT ACM harm) |
→ Small models mostly DON'T activate ACM on research (pressure ~30%, no green-signal boundaries), but stay SAFE — no ACM-induced harm (they didn't fold, so nothing to break). mimo's task=2 is competence, not ACM.

## FINAL VERDICT — the v2 conclusion PARTIALLY generalizes
1. **Large-model proactive fold GENERALIZES.** sol folds cleanly on knowledge work (task=3, hand=3, rec=3); opus activates even more reliably than on code (3/3 vs 2/3).
2. **NEW, confirmed shape-specific weakness — opus over-folds on research (task=2 in all 3).** With no tests-green completion signal, opus folds too eagerly: it swallows undelivered answers and skips rehydrate, injecting factual slips. Root cause: a fold should carry *already-extracted* work; an unanswered question isn't extracted, so folding mid-answer drops the deliverable. sol does NOT show this → opus-specific fold discipline, not a flow artifact.
3. **Small-model behavior is SHAPE-DEPENDENT.** Active + competent on coding (Phase-2), but they go largely SILENT on research (kimi27 0/2, deepseek ~0, mimo ~0). Safety still holds (no ACM-induced task damage), but the Phase-2 “small models proactively fold” finding does NOT transfer to knowledge work.
4. **Safety floor holds broadly** (sol + all small models: no ACM-induced harm). The single exception is opus's over-fold on research.

**Bottom line:** the single coding flow OVER-stated generalization. Truth: large-model activation generalizes; small-model activation is coding-specific; and opus's fold discipline is fragile on no-green-signal work. All are DOCUMENTED findings, not yet acted on — a fix for #2 (a 术-layer “deliver/answer before you fold the work that produced it” cue) risks the large-model coding win and needs its own non-regression guard before adoption.

## Harness caveats
- sol over-generates the open-ended research P1; ~1/4 runs time out even at --timeout-scale 2.0 (harness artifact, not an ACM failure).
- kimi27/deepseek at n=2, others n=3; qualitative verdict is solid but rates are not tightly estimated.
- mimo[off] rows discarded per user (“别跑off”); all representative runs use medium/high/max.
