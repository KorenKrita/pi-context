# Long-run evaluation

One 30-turn task lifecycle, run twice with ACM triggers ON and OFF, scored on
final coordinates rather than on process.

## Why this exists

The retired 15 showroom scenarios ran 1-3 turns. With real per-million prices
an untouched prompt is billed at `cacheRead` while every fold invalidates the
cache and re-bills the whole prompt at `input` price, so folding only pays off
after enough follow-up requests. `eval/cost-model.mjs` computes where that
crossing sits. On this scenario's measured shape it is **request 22** for
`gpt-5.6-sol` and **request 66** for `deepseek-v4-flash`. Every showroom
scenario sat far left of both, so they could only ever measure folding overhead
— and they did, reporting ACM as a pure cost item.

A weak model that never folds a 30-turn run is therefore behaving correctly:
its own crossing is at 66. Confirming that folding actually saves money
requires a model whose crossing the script clears.

## The three dependent variables

| # | Variable | Source |
| --- | --- | --- |
| 1 | Real billed dollars | `message.usage.cost` per category, summed by `settle.mjs` |
| 2 | Outcome delivered | `eval/fixtures/ledger-drift/verify.mjs` exit status |
| 3 | Fold-timing deviation | `scoreFoldTiming()` against the computed optimum |

Token counts are never used as a cost proxy: `cacheRead` is 10x (sol) to 50x
(deepseek) cheaper than `input`, so equal token counts can differ in price by
an order of magnitude.

## The scenario

`eval/fixtures/ledger-drift` is a service repo whose 12 per-service configs
drifted from `ops/slo-targets.json` over 14 months. `verify.mjs` starts failing
on 29 drifts.

| Phase | Turns | What happens |
| --- | --- | --- |
| survey | 1-7 | Read 6 service logs in depth plus the SLO targets and incident reports. ~87K tokens of real log text exists in the fixture; ~13.4K enters the prompt per turn. |
| **settle** | **8** | Write the conclusions to `ops/reconciliation-plan.md`. |
| apply | 9-24 | Reconcile the 12 configs, one file per turn, plus verification turns. |
| regress | 25-30 | Answer questions whose facts were only ever visible during survey. |

Measured on a completed 30-turn `deepseek-v4-flash` run: the prompt reaches
91.1K at the settling turn and 117.9K at turn 30, so a 400K window never comes
close to compaction. Apply-phase growth is only ~1.0K per turn because editing
three constants produces little text — far below the 3K the cost model was first
sketched with. That difference changes absolute dollars but **not** the
break-even point, which stayed at request 22: per-request growth enters both
policies symmetrically, so only the retained fraction, the price structure, and
the settling turn move the crossing.

### Fold timing is objective, not annotated

The settling turn is where the survey's conclusions land on disk. From that
point the raw logs are recoverable from files and their transcript copy is
sediment. Because the artifact either exists or does not, the settling point is
the same observable event for every model, every commit, and both arms — the
cost model's `settledAtRequest` is read off the script rather than guessed.

`recoveryTokens` (the price of one rehydrate after a premature fold) is
deliberately uncalibrated: it changes the penalty for folding too early but
provably affects neither the break-even point nor the optimum, which depend on
the settling turn alone. `eval/longrun/scenario.test.mjs` locks that property.

### Lost context breaks the deliverable, not a quiz

`search` holds an approved waiver from the 2026-05-17 pool-exhaustion incident:
`poolSize: 40` against its standard-tier target of 15. A run that folds away
the incident report and then applies tier values uniformly — the plausible
answer once that context is gone — fails `verify.mjs` on `search.poolSize`.
Context loss therefore surfaces as a broken deliverable rather than as a
memory test.

### Truncation gives two conditions from one fixture

Stopping at 20 turns lands left of the crossing, where not folding is correct.
The full 30 turns lands right of it, where the optimum is a fold right after
the settling turn. A model that declines to fold a 20-turn run scores
`optimal` with deviation 0 — correct restraint is not penalized.

## Running it

```bash
# Full pair (both arms, 30 turns)
node eval/longrun/run-pair.mjs --model local-responses/gpt-5.6-sol --thinking medium

# Short truncation, one arm
node eval/longrun/run-pair.mjs --model local-openai/deepseek-v4-flash \
  --thinking max --turns 20 --arm on --label ds-t20

# Settle a completed run (never reruns a model)
node eval/longrun/settle.mjs --run eval/.runs/longrun/<label>
```

The window is clamped to 400K. A 40K clamp forced native compaction in both
arms and masked the effect; 200K would be crossed before the settling turn at
the measured growth rate.

## What a settlement looks like

```
on:  $2.9130 | outcome=delivered | turns=30 | acm=4 calls/1 travels | timing=optimal dev=0 excess=$0.0000
off: $3.7420 | outcome=delivered | turns=30 | acm=0 calls/0 travels | timing=missed dev=8 excess=$0.8265
paired: on-off=$-0.8290 ratio=0.778 outcomeMatch=true
```

Numbers above are the shape of the output, not a measured result.
