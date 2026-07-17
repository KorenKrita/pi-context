# Cadence Platform — Data Model

All durable state described here lives in the **Control Plane** database, except the
**Ledger** and **Invoice** entities, which are owned by the Meter and Billing services
respectively (see `04-metering-billing.md`).

## Identifiers

| Entity | ID format | Notes |
|---|---|---|
| Tenant | `t_<26 char ULID>` | Assigned at signup, never reused. |
| WorkflowVersion | `wf_<ULID>@<n>` | `@n` is the monotonic version number, starting at `@1`. |
| Run | `run_<ULID>` | One per execution. |
| Task | `task_<ULID>` | One per node per Run. |
| Attempt | `att_<ULID>` | One per execution try. **Attempt numbers are 0-indexed**: the first try is attempt `#0`, the first retry is `#1`. |
| UsageEvent | `ue_<ULID>` | Emitted per Attempt (see `04-metering-billing.md`). |

## Run state machine

```
PENDING ──▶ RUNNING ──▶ SUCCEEDED
                │
                ├──▶ FAILED
                └──▶ CANCELLED
```

- A Run enters `RUNNING` when its first Task is dispatched.
- A Run is `SUCCEEDED` only when **every** Task is `SUCCEEDED` or `SKIPPED`.
- A Run is `FAILED` as soon as any Task reaches `FAILED` and no retry remains.
- `CANCELLED` is only reachable by an explicit tenant cancel request.

## Task state machine

```
PENDING ──▶ READY ──▶ RUNNING ──▶ SUCCEEDED
   ▲                     │
   │                     ├──▶ FAILED
   └──── (retry) ────────┘
                         └──▶ SKIPPED
```

- `PENDING` — the Task exists but at least one upstream dependency is not yet terminal.
- `READY` — all dependencies are `SUCCEEDED`; the Scheduler may dispatch it.
- `RUNNING` — assigned to a worker; a heartbeat is expected every 30 seconds.
- `SUCCEEDED` — the worker reported success and a UsageEvent was accepted.
- `FAILED` — the Attempt errored or timed out and no retry budget remains.
- `SKIPPED` — an upstream Task `FAILED`, so this Task will never run. `SKIPPED` Tasks
  emit **no** UsageEvent.

> Note: a `RUNNING` Task whose heartbeat lapses is returned to `READY` and retried by
> the Scheduler; the retry rules (including the maximum number of retries) are defined
> in `03-scheduling.md`, which is the authoritative source for retry policy.

## Dependency edges

Edges are stored as `(run_id, upstream_task_id, downstream_task_id)`. A Task becomes
`READY` when *all* of its upstream edges point at `SUCCEEDED` Tasks. There is no
"any-of" join in the current model; every join is an "all-of" join. Fan-out (one task,
many downstream) is supported; fan-in is always all-of.

## Immutability

- A `WorkflowVersion` is immutable once stored; editing a workflow creates `@n+1`.
- A `Run` and all of its Tasks/Attempts are immutable once the Run is terminal.
- Re-running a workflow always creates a fresh `Run` with new `task_` and `att_` IDs.

## What the Control Plane does NOT store

- Rated usage or money amounts — those live in the **Ledger** (Meter).
- Invoice documents — those live in **Billing**.
- Worker-local scratch data — discarded when the Attempt ends.
