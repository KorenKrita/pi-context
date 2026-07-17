# Cadence Platform — Scheduling & Retries

The Scheduler is **stateless** (see `01-overview.md`): it reads `READY` Tasks from the
Control Plane, ranks them, dispatches to workers, and writes state transitions back.
Restarting the Scheduler loses nothing.

## Dispatch ranking

`READY` Tasks are ordered by, in strict priority:

1. **Tenant tier** — `PLATINUM` > `GOLD` > `STANDARD`. Higher tier dispatches first.
2. **Run priority** — an integer `0–9` set at trigger time; higher runs first.
3. **Task age** — older `READY` timestamp first (FIFO within a bucket).

Ties beyond task age are broken by `task_id` lexical order (deterministic, arbitrary).

There is no preemption: once a Task is `RUNNING`, a higher-priority arrival waits.

## Concurrency limits

- Each worker runs at most **4** Attempts concurrently.
- Each tenant has a **concurrent-attempt cap** (see quotas in `05-operations.md`);
  Tasks that would exceed it stay `READY` and are simply not dispatched yet.
- A single Run has no internal concurrency cap beyond the tenant cap.

## Retry policy (authoritative)

This section is the **single source of truth** for retries; other documents defer here.

- A Task's first execution is Attempt `#0` (attempt numbers are 0-indexed, see
  `02-data-model.md`).
- On a retryable failure, the Scheduler creates the next Attempt and returns the Task
  to `READY`.
- **A Task may be retried up to 5 times.** That means attempts `#0` through `#5`, i.e.
  **at most 6 Attempts total** before the Task is declared `FAILED`.
- Retries use exponential backoff: `delay = base * 2^attempt`, with `base = 2s`,
  capped at 60s. So the delays before attempts `#1..#5` are `2s, 4s, 8s, 16s, 32s`.

### What counts as retryable

| Failure | Retryable? |
|---|---|
| Worker crash / lost heartbeat | Yes |
| Task handler returns a transient error | Yes |
| Task handler returns a permanent error | No — straight to `FAILED` |
| Attempt exceeds its wall-clock timeout | Yes |
| Tenant over quota at dispatch time | Not a failure — the Task waits, no Attempt is created |

A Task that exhausts its retry budget goes to `FAILED`, which cascades `SKIPPED` to all
downstream Tasks (see `02-data-model.md`) and fails the Run.

## Heartbeats & timeouts

- A `RUNNING` Attempt must heartbeat every **30 seconds**.
- If two consecutive heartbeats are missed (a 60-second gap), the Scheduler considers
  the worker lost, marks the Attempt failed, and retries per the policy above.
- The per-Attempt wall-clock timeout is a tenant quota (`05-operations.md`), not a
  scheduler constant.

## Fairness

Within a tenant tier, the Scheduler uses a weighted round-robin across tenants so a
single tenant flooding `READY` Tasks cannot starve its tier-mates. Weights are equal
by default; support can raise a tenant's weight temporarily during an incident.
