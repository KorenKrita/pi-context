# Cadence Platform — Quotas, Limits & On-Call Runbook

## Default tenant quotas

| Quota | STANDARD | GOLD | PLATINUM |
|---|---|---|---|
| Concurrent-attempt cap | 32 | 128 | 512 |
| Per-attempt wall-clock timeout | **900 s** (15 min) | 900 s | 3600 s (1 h) |
| Max tasks per workflow graph | 500 | 2000 | 5000 |
| API requests / minute (Gateway) | 600 | 3000 | unlimited* |
| Ledger retention (queryable) | 18 months | 18 months | 36 months |

\* PLATINUM API traffic is unmetered but still subject to abuse review.

The **per-attempt wall-clock timeout** above is the value referenced by the Scheduler
as "the per-Attempt timeout" (`03-scheduling.md`). When an Attempt exceeds it, the
Attempt is failed and retried per the retry policy.

## Operational guardrails

- The scheduler is stateless and safe to restart; drain is not required.
- **Retry guardrail: a Task retries at most 3 times before it is failed.** On-call may
  lower this per-tenant during an incident to shed load, never raise it.
- A tenant's fairness weight may be raised temporarily during an incident
  (`03-scheduling.md`); reset it when the incident closes.

## Alerts

| Alert | Meaning | First action |
|---|---|---|
| `usage-gap` | A terminal Attempt has no rated LedgerEntry | Check Meter ingestion lag; replay the UsageEvent stream from the last checkpoint. |
| `usage-orphan` | A LedgerEntry has no matching Attempt | Do **not** delete it; open a billing ticket — corrections are compensating entries only (`04-metering-billing.md`). |
| `heartbeat-storm` | Many Attempts losing heartbeats at once | Suspect a worker-fleet AZ outage; cordon the AZ, let retries reschedule. |
| `invoice-drift` | Nightly reconciliation delta over threshold | Compare Control Plane terminal Attempts vs Ledger; expect prior-period adjustments near month boundaries. |

## Month-close runbook

1. Freeze is automatic at 00:00 in the tenant timezone on the 1st.
2. Verify nightly reconciliation for the closing period is clean (no open `usage-gap`).
3. Late events after freeze are expected; confirm they land as prior-period adjustments
   on the next open Invoice, and that the frozen Invoice is unchanged
   (`04-metering-billing.md`).

## Capacity notes

- Worker concurrency is 4 Attempts/worker (`03-scheduling.md`); fleet size is scaled to
  keep tier-wide `READY` queue depth under 1000 during business hours.
- The 900 s STANDARD timeout is the most common cause of "my task was retried" tickets:
  long-running STANDARD tasks that legitimately need more time should be moved to GOLD,
  not granted timeout exceptions.
