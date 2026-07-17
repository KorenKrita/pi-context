# Phase-2 ACM Guidance Iteration Log — Small Models

**Goal:** 小模型正常使用 ACM，同时不影响大模型效果。
Get small models to use ACM *normally* (activate appropriately, produce valid-enough handoffs, no thrash, no ACM-induced task damage) WITHOUT regressing the Phase-1 large-model wins (sol reliable fold, opus 2/3) achieved by v2 guidance.

**Baseline guidance = v2** (branch `acm-fold-desuppression-phase1`, PR #16, gitHead 4f802fc2). The guidance is UNIFIED — one CORE (道) + one 术 layer (TOOL-CONTRACTS + 30% nudge) for ALL models. There is no model-specific text. Therefore "不影响大模型" is automatically satisfied UNLESS a Phase-2 change adds small-model-specific guidance that dilutes/distracts the large-model pull.

**Models:** mimo-v2.5 (thinking=off, weakest), deepseek-v4-flash (thinking=max), kimi-k2.7-code-highspeed (thinking=high). kimi-k3 EXCLUDED by user (prior timeout truncation, do not re-run).
**Eval:** same harness as Phase-1 (`bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p2v2base`), 60K window, exprlang long-flow, judge=claude-opus-4-8 rubric acm-activation-v1. Dirs now collision-proof (`-p<pid>` suffix added to `eval/setup.mjs::createRunDir`).

## Small-model behavior under v2 — n=3 each
| model | run1 | run2 | run3 |
|---|---|---|---|
| mimo-v2.5 (off) | `T.....` act2 tim1 hand0 rec1 ceil0 **task3** | `.TT...` act3 tim2 hand3 rec2 ceil1 **task3** | `.TT...` act3 tim3 hand3 rec3 ceil2 **task3** |
| deepseek-v4-flash | `.T....` act2 tim2 hand2 rec1 ceil1 **task3** | `.T....` act2 tim2 hand3 rec2 ceil1 **task3** | `..T...` act1 tim1 hand0 rec1 ceil0 **task3** |
| kimi-k2.7 | `..T..T` act3 tim3 hand3 rec3 ceil3 **task3** | `..T.TT` act3 tim2 hand3 rec3 ceil2 **task3** | `......` act0 … **task3** |

## Key findings
1. **task_completion = 3 in ALL 9 runs.** v2 does NOT break small models. Judge repeatedly: "ACM 未拖累任务" / "折叠未损害任务". The feared "小模型不正常使用" (thrash / broken fold drops context / task damage) is NOT occurring.
2. **No overfold/thrash.** Small models UNDER-use ACM (1–2 ops per run), the opposite of thrash.
3. **Even mimo (thinking=off) produces valid hand=3 folds 2/3 of runs.** deepseek folds 3/3 (hand up to 3). kimi-k2.7 flawless 2/3.
4. **The residual is CONSISTENCY, not misuse:** ~1/3 of runs per model are weak/zero (mimo checkpoint-only ×1; deepseek hand=0 ×1; kimi zero ×1). This is the SAME irreducible-tunnel variance seen for opus in Phase-1 — a model occasionally misses ACM entirely — not a small-model-specific breakage.
5. Contrast with OLD pre-v2 data: HEAD-cold → small models mostly ZERO activation; "original" (primed) → activated but hand=0 + one task=1. v2 is strictly better: safe floor + frequently competent folds.

## Interpretation
Under v2 the unified guidance already delivers Phase-2's core intent for small models: **safe (never harms task), non-thrashing, and frequently competent** (all three reach hand=3). Large models are unaffected because the guidance is unified and unchanged. The open question is whether to spend a v3 chasing the ~1/3 weak/zero consistency — which is the same non-coercive tunnel ceiling from Phase-1, and pushing it risks either large-model overfold or crossing the no-state-machine floor.

## Open decision (for user)
- Accept v2 as satisfying Phase-2 (small models safe + frequently competent; large unaffected), OR
- Push a v3 for small-model consistency (accepting the tunnel/overfold/large-model-regression tradeoff), OR
- Target a specific narrow quality gap (e.g. deepseek's messy hot-set formatting) via a 术-layer tweak, then re-run opus×3 + sol×3 as a non-regression guard.
