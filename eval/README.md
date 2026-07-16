# ACM Open-Ended Behavior Eval

This non-CI eval gives a candidate model real `acm_checkpoint`, `acm_timeline`, and `acm_travel` calls from `eval/mock-acm-extension.ts`, then asks a separate judge model to score the resulting assistant-message batches against paraphrased working-set invariants. The mock tools reuse canonical descriptions and schemas but do not mutate a real session tree. Isolation scenarios use the deterministic read-only `eval_observe_external` probe, so the eval never grants the candidate a general shell.

The eval deliberately avoids one expected tool-call sequence: equivalent responses pass when they preserve recoverability, active uncertainty, cold start, travel isolation, and sound summary-debt judgment.

Run all scenarios:

```bash
bun run eval:acm -- \
  --candidate local-openai/mimo-v2.5 \
  --judge local-responses/gpt-5.4-mini
```

Useful options:

```bash
# One phrasing per family for a quick smoke run
bun run eval:acm -- --variants 1

# Run one family and keep a machine-readable report
bun run eval:acm -- --family travel-isolation --output /tmp/acm-eval.json

# Require every sampled scenario to pass
bun run eval:acm -- --strict
```

Environment fallbacks are `ACM_EVAL_CANDIDATE_MODEL`, `ACM_EVAL_JUDGE_MODEL`, and `ACM_EVAL_TIMEOUT_MS`. The command is intentionally absent from `verify:acm`: it spends model calls, depends on configured providers, and is expected to measure stochastic behavior rather than gate deterministic builds.

A passing default run requires at least 80% of scenarios to pass and at least one passing scenario in every sampled family. `--strict` raises the threshold to 100%.
