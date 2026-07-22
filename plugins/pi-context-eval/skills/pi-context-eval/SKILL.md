---
name: pi-context-eval
description: Run, resume, inspect, or report the pi-context fixed Saffron 400K-versus-1M model matrix with immutable checkout, seed, sandbox, lock, and runtime provenance. Use for context-window comparisons, formal model evaluations, failed-cell retries, live matrix status, infrastructure-invalid diagnosis, or evidence-backed paired conclusions in the pi-context repository.
---

# Pi Context Eval

Treat the committed runner as the authority. Keep task quality, coverage, and infrastructure validity separate.

## Establish the evidence boundary

1. Resolve the repository root with `git rev-parse --show-toplevel` and read its `AGENTS.md` plus the evaluation section of `README.md`.
2. Inspect `git status`, the exact outgoing range, existing matrix processes, and exclusive locks before starting anything.
3. Push the exact evaluated commit, then create a clean detached worktree for that commit. Install dependencies inside it with `npm ci --ignore-scripts`.
4. Run `bun run verify:acm` in the immutable checkout before formal execution.
5. Keep the secret flow seed outside Git with mode `0600`. Pass it through `ACM_FLOW_SEED`; never print the plaintext seed or put it in a command-line argument.
6. Do not edit the formal checkout while a matrix is running. A harness fix requires a new commit, a new immutable checkout, and a separate output directory.

Do not use a dirty tree, mutable branch tip, ambient Pi binary, missing Darwin Seatbelt, stale lock takeover, or mixed-commit cells as formal evidence.

## Preview and execute

From the immutable checkout:

```bash
# No provider work; inspect the fixed manifest first.
bun run eval:saffron

# Run every fixed cell serially for the strongest isolation.
ACM_FLOW_SEED="$(cat "$seed_file")" \
  bun run eval:saffron -- --execute --concurrency 1 --timeout-scale 1
```

The fixed manifest owns model IDs, thinking levels, hard windows, `maxTokensCap=16000`, `agents-only` isolation, and the Saffron flow. Do not silently substitute a model or lower a reasoning level. If the user asks for a subset, use exact committed cell IDs:

```bash
ACM_FLOW_SEED="$(cat "$seed_file")" \
  bun run eval:saffron -- --execute --cell sol-medium-400k --concurrency 1
```

## Resume without contaminating provenance

Resume only the same commit, seed, output directory, and cell definition:

```bash
ACM_FLOW_SEED="$(cat "$seed_file")" \
  bun run eval:saffron -- \
    --execute \
    --resume eval/.runs/saffron-agents-matrix-<timestamp>-<sha> \
    --cell opus-4-8-high-1m \
    --concurrency 1 \
    --timeout-scale 1
```

Retry a transient provider failure once when the failure is clearly external, such as an EOF before a complete assistant turn. Preserve the failed attempt in matrix state. Do not turn `verification_failed` into a retry merely because the score is disappointing.

Use the bundled status helper for a scan-friendly live or final view:

```bash
python3 plugins/pi-context-eval/skills/pi-context-eval/scripts/matrix_status.py \
  eval/.runs/saffron-agents-matrix-<timestamp>-<sha>
```

## Classify cells before drawing conclusions

- `certifying_run`: deterministic verification passed and judge evidence exists. Check sandbox eligibility, lock release, runtime audit, and repository audit before calling it formal.
- `task_failure`: a valid task run failed deterministic verification. Treat it as a real outcome, not infrastructure noise.
- `coverage_insufficient`: the task may have completed, but required pressure or behavior coverage was not observed. Do not promote it to a pass/fail ceiling claim.
- `infrastructure_invalid`: the runner, sandbox, provenance, or integrity gate invalidated the cell. It says nothing about model quality.
- `run_error`: inspect `runError`. Provider transport failure is not a task-quality conclusion.

Never claim a 400K-versus-1M pair conclusion unless both arms are formal-evidence eligible and have outcome-bearing classifications. Report incomplete pairs explicitly.

## Report evidence

Lead with the current state: running, completed, or blocked, and whether a trustworthy pair conclusion exists. For each cell report:

- model, thinking level, hard context window, and attempt count;
- classification, reason, deterministic status, and judge score/tier when present;
- infrastructure invalidation or provider error verbatim enough to identify the failure class;
- commit, seed hash, output directory, report path, sandbox eligibility, lock release, and audit result;
- retries and whether they preserved commit/seed/output provenance.

Then compare only like-for-like arms. Separate direct evidence from inference, and preserve raw artifacts rather than copying selective excerpts into a new result file.
