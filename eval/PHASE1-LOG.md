# Phase-1 ACM Guidance Iteration Log

**Goal:** Get high-intelligence models (claude-opus-4-8, gpt-5.6-sol) to proactively
fold/rebase (not just save) under a fully de-primed cold flow, while keeping the
道术度 design (道 in CORE.md, 术 in TOOL-CONTRACTS.md), NO state machine / mandatory
preflight / transition table / suffix machinery (AGENTS.md:7/123/186), and task_completion=3.

**Eval:** `bun eval/run-flow.mjs --model <m> --thinking <t> --variant <v>`
- opus: `local-claude/claude-opus-4-8 --thinking high`
- sol:  `local-responses/gpt-5.6-sol --thinking medium`
- 60K shrunk context window; extension = main repo src (source-first, picks up working-tree guidance).
- Judge: claude-opus-4-8, rubric acm-activation-v1. 6 phases P1摸底/P2修幂bug/P3风险重构/P4加json/P5回捞/P6收口.
- Dims: activation, timing_and_measure, handoff_quality, recoverability, ceiling, task_completion (0-3).
- NOTE: gitHead in reports = a0f79a2e (stale; uncommitted working-tree guidance is what actually runs). Variant label is the real discriminator.

## Signature legend
`phases taken` = per-phase opportunityTaken as T/. across P1..P6. handoff_quality=1 "never-activated" means zero folds (save-only or nothing).

## Baseline (committed HEAD a0f79a2e, Fable pure-道) — n=1 each
| cell | phases | act | timing | handoff | recover | ceiling | task | overall |
|---|---|---|---|---|---|---|---|---|
| opus HEAD | `..T...` | 2 | 2 | 1 | 3 | 1 | 3 | 2 mid |
| sol  HEAD | `.TTT..` | 2 | - | 1 | - | 1 | 3 | 2 mid |
| opus PR12 | `.TTT..` | 3 | - | 3 | - | 2 | 3 | 3 strong |
| sol  PR12 | `TTTTTT` | 3 | - | 3 | - | 3 | 3 | 3 strong |

Diagnosis: on HEAD both high-intel models plateau at SAVE-ONLY (checkpoint yes, travel/fold never).
On PR12 both escalate to full fold (handoff 1→3). So they CAN fold; HEAD's framing made fold feel optional+risky.

## v1 (de-suppress HEAD, keep 道术度, no state machine)
CORE.md swaps:
1. cadence "the weighing, not the fold" → "folding is the default, not an optional extra: … fold it and carry pointers. Skip only when you can name why the raw detail must stay live." (invert default keep→fold)
2. lean paragraph: added "budget is only half the reason to fold: sediment clouds attention long before it fills the window, so low usage is never by itself a reason to keep raw process live." + compaction demoted to "fallback only when genuinely long work outruns folding". (two-reasons: budget vs attention)
3. Fold move: "+ and is as recoverable as a save: the raw path stays in the tree behind a pointer, one travel away." (fold-as-safe, symmetry with the save they trust)
TOOL-CONTRACTS.md: travel guideline "autonomous by default" → "a normal working move … as readily as you save a checkpoint"; two result cues "weigh a fold/rebase" → action-tilted ("fold it into a handoff…"; "Rebase instead: merge…").
guidance-quality.test.ts co-evolved: removed the "the weighing, not the fold" lock; added locks for "folding is the default, not an optional extra", "low usage is never by itself a reason to keep raw process live", "as recoverable as a save". ACM_CORE=5950/<6000. All 20 guidance tests + typecheck green.

### v1 results — n=1 each (REPS IN FLIGHT for n=3)
| cell | phases | act | timing | handoff | ceiling | task | overall | note |
|---|---|---|---|---|---|---|---|---|
| opus v1 #1 | `......` | 0 | 0 | 0 | 0 | 3 | 1 strong | REGRESSED to zero ACM calls |
| sol  v1 #1 | `.TTT..` | 3 | 2 overfold | 3 | 2 | 3 | 2 strong | fold achieved; event-driven-overfold (每阶段一折/低压力) |

Divergence: v1 moved sol save-only→fold (goal hit, but mild overfold), and left opus at zero.
opus needs a STRONGER pull than gentle de-suppression (it folded on PR12's more prescriptive text)
but sol already over-responds — need a middle push WITHOUT a state machine. But n=1 near the floor is noisy;
replicating opus×v1 and sol×v1 to n=3 before designing v2.

## v1 n=3 results (variant p1v2 supersedes)
| cell | run1 | run2 | run3 | verdict |
|---|---|---|---|---|
| opus v1 | `......` ovr1 | `......` ovr1 | `.T....` ovr2 | 2/3 ZERO ACM, 1/3 single good fold → opus does NOT reliably self-activate on de-suppressed 道 |
| sol v1 | `.TTT..` ovr2 (overfold) | `..T...` ovr3 | `..TT..` ovr2.8 | act3/3, fold3/3, task3/3, overfold only 1/3 → RELIABLE WIN for sol |

## opus root cause (forensics on opus zero-run 05-29-57-560)
- Peak usage 44.8% (26.9K/60K) → real pressure built. The 30%-tier context nudge WAS delivered to opus mid-task.
- opus received the steer and STILL did zero ACM → not "surfacing" problem; opus ignores the nudge.
- The 30% nudge text (context-usage-nudge.ts) carried the SAME suppressor DNA as old CORE:
  - only pointed at acm_checkpoint (save), framed fold as future/hypothetical ("would make a clean fold", "later fold")
  - ended with escape hatches: "Nothing is required now" + "correctness always outranks a smaller number"
- opus per-phase notes: "典型 never-activated"; excellent code every run; ACM never surfaces (deep task-tunnel).
- Conclusion: static system-prompt 道 is tunnel-ignored by opus; the mid-task nudge is the ONE channel that reaches it, but it was written to be ignorable. 50%/70% tiers already directive; 30% (first & often only tier to fire) was the weakest.

## v2 = v1 CORE + de-suppressed 30% nudge tier (context-usage-nudge.ts)
30% tier rewritten:
- "…comfortable cruise range — this is where folding pays off. If a burst has been distilled, a direction closed, or a phase finished, fold that raw process into a cold-start handoff now and carry pointers instead of the trail; if you are mid-step, drop an acm_checkpoint at the boundary so the fold stays cheap."
- "A fold is as recoverable as a save, so the bar is a faithful cold-start handoff, not a smaller number. Keep live only what NEXT will reason over."
Removed "Nothing is required now"; points at FOLD-now (conditional on real sediment); keeps quality guard w/o escape hatch; echoes CORE fold-as-safe. Still 术-layer, situational, NO state machine (contract-legal). 50/70 tiers untouched.
test/context-nudge.test.ts: "Nothing is required now" assertion → "fold that raw process into a cold-start handoff now". 22 guidance+nudge tests + typecheck green.
Experiment: opus×3 + sol×3 variant p1v2. Key Q: does v2 lift opus off zero? does sol overfold more?

### v2 results — COLLISION NOTE + n=2 clean each
Launch bug: 6 parallel jobs (opus 93/94/95, sol 96/97/98) → `createRunDir` used ISO-ms stamp only; jobs 93+95 and 97+98 each launched in the SAME millisecond and shared one run dir (last-writer-wins). 2 opus + 2 sol survived clean (6-phase perPhase intact, no interleave). FIXED `eval/setup.mjs` createRunDir to append `-p<pid>` (collision-proof); topped up +1 opus +1 sol (jobs 110/111) for clean n=3.

| cell | runA | runB | runC (top-up p<pid>) | verdict n=3 |
|---|---|---|---|---|
| opus v2 | `..T...` act2 hand3 rec1 ceil2 task3 ovr2 (1 fold@P3, MISSED save-before-risk) | `..TT..` act3 hand3 rec3 ceil2 task3 ovr3 (fold P3+P4, save done, strong) | `......` act0 hand0 rec0 ceil0 task3 ovr1 (ZERO ACM) | **2/3 activate+fold (hand=3 when it does), 1/3 ZERO**. Up from v1's 1/3-activate. But NOT reliable. |
| sol v2 | `.TTT.T` act3 hand3 rec3 ceil3 task3 ovr3 (4 folds, timing 3=justified) | `.TT...` act3 hand3 rec3 ceil2 task3 ovr2 (2 folds, clean) | `.TTT..` act3 tim2 hand3 rec3 ceil2 task3 ovr3 (3 folds) | **act3/3 fold3/3 task3/3**, timing 3/2/2 → NO overfold regression vs v1. RELIABLE WIN. |

### Decisive forensic — opus zero run (runC, dir …-p32726)
- Peak `pressurePercent`=39.5% (tokens 23689/60K working budget) → real sediment/pressure built.
- The **fully de-suppressed 30% fold-now nudge WAS delivered** (matched 3× in events.jsonl: "comfortable cruise range … fold that raw process into a cold-start handoff now …").
- opus received the directive steer and STILL did zero ACM. Judge perPhase: genuine sediment at P1 (raw dump), P2 (debug trail), P3 (high-risk rewrite, no save-before-risk) — all missed. Not a defensible hold; deep task-tunnel.
- **Conclusion:** opus has an irreducible ~1/3 tunnel rate that ignores even a directive mid-task nudge. Short of coercion (mandatory preflight / forced tool call / state machine — FORBIDDEN by AGENTS.md:7/123/186 and 道术度), the non-coercive nudge cannot close the last 1/3. And a more-coercive nudge would very likely worsen sol's overfold (sol already responds strongly). opus-tunnel vs sol-responsiveness pull opposite directions on the same lever.

## Phase-1 converge summary (HEAD → v1 → v2)
- **sol:** save-only plateau (HEAD, hand=1) → reliable fold (v1 & v2, act3/3 hand3 task3). GOAL MET.
- **opus:** save-only plateau (HEAD, hand=1) → 1/3 fold (v1) → 2/3 fold (v2, hand=3 when it folds). MATERIALLY IMPROVED, not reliable; residual 1/3 is an irreducible non-coercive ceiling.
- v2 is strictly ≥ v1 and ≫ HEAD: no task-quality regression (task=3 across ALL v2 runs), no sol overfold regression, all constraints held (ACM_CORE=5950<6000, no state machine, task_completion=3, 33 guidance+nudge tests + typecheck green).
- **Open decision for user (Materiality Gate — touches the no-state-machine floor):** accept v2 as Phase-1 converged & commit, vs attempt a non-coercive v3 lever for opus (low-confidence, risks sol), vs add reps to tighten the opus rate estimate. NOT committed yet (user tied commit to a validated winner; the opus residual + constraint tradeoff warrants user input).
