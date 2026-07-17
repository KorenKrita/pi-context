# Phase-4 Log — Make ACM a HABIT (道-driven), not a pressure reflex

## Why Phase-4 exists

Phases 1–3 were all measured at a **60K shrunk window**, which pushed pressure to 38–70% and made the
percentage nudge fire. So every prior number measured **guidance + nudge under artificial pressure**,
not the static CORE (道) alone. The `--native` run exposed the truth:

**Current HEAD (v2) @ native window (1M → 400K budget, ~7% peak pressure, nudge fired 0×) — BASELINE (n=2 each):**
| model | run1 | run2 | read |
|---|---|---|---|
| opus[high] | `......` act0 | `......` act0 | **reliably ZERO ACM** — 道 alone drives nothing |
| sol[medium] | `.TT...` act2 hand1 rec3 | `.TTT..` act2 hand1 rec2 | activates for **recoverability (save-before-risk)** but **never a real fold** (hand1) — 道 makes sol save, not compress |
| both | task=3 | task=3 | no task harm |

**Diagnosis (user's framing):** v2 inverted the design — pressure became the *engine*, 道 became inert.
Intended: 道 makes self-management a **daily habit**; the nudge is only a *backstop reminder*. At realistic
large windows the nudge rarely fires, so ACM must be carried by 道.

## v3 change (this phase)

1. **CORE.md cadence reframe (道):** folding is a **habit set by the rhythm of the work** (finish a unit → its
   raw process is sediment → fold, at any occupancy), not a reaction to a full gauge. Budget/cruise demoted to
   *result of the habit, not its trigger*; pressure demoted to *backstop*. All locked phrases preserved
   ("around a third of the working budget", "That is a preference, never an override",
   "folding is the default, not an optional extra", "low usage is never by itself a reason…").
2. **TOOL-CONTRACTS.md honesty guard (术):** a fold is context hygiene, **never a substitute for the turn's
   deliverable**; if the turn owes the user an answer, NEXT carries it and you deliver it — recording a
   conclusion in State is not delivering it (a handoff can pass cold start while the answer was never given).
   Added to the travel guideline + travel result cue. (Directly targets the opus P2 over-fold: it folded,
   wrote the answer into State, then asked "请问你的下一个问题?" — never delivered.)

No state machine / preflight / suffix machinery. ACM_CORE must stay <6000.

## Acceptance = NATIVE WINDOW (nudge silent)

The bar is now: **can 道 alone make opus + sol fold at ~7% pressure?** All prior 60K data is invalid for this
question. Test variant = `p4habit`, `--native`, exprlang flow, opus[high] + sol[medium].

Hypothesis (honest): may lift **sol** (道 already reaches it — it saves). Likely **won't lift opus** (Phase-1
proved opus tunnels static CORE regardless of wording). If opus stays zero, the real conclusion is
"habit needs an active, non-pressure signal" → next lever = a *structural* (task-seam) reminder, not a % one.

## Results — p4habit @ native
(pending)
