# Cadence Platform — Metering & Billing

The **Meter** and **Billing** services own usage and money. They never read the Control
Plane database directly; they consume the **UsageEvent stream** and reconcile
asynchronously (see `01-overview.md`).

## UsageEvents

- Exactly **one UsageEvent per Attempt** is emitted by the worker on completion
  (success *or* failure). `SKIPPED` Tasks emit none (see `02-data-model.md`).
- Because every Attempt emits an event, **retries are billable**: a Task that fails
  twice and succeeds on the third try produces three UsageEvents and is rated three
  times. Retries are not free.
- A UsageEvent carries: `ue_id`, `att_id`, `task_id`, `run_id`, `tenant_id`,
  `handler`, `cpu_ms`, `mem_mb_peak`, `egress_bytes`, and `wall_ms`.

## Deduplication

Workers may emit the same UsageEvent more than once (at-least-once delivery). The Meter
deduplicates on `att_id`: **the first event for an `att_id` wins; later duplicates for
the same `att_id` are dropped.** Since every Attempt has a unique `att_id`, this yields
exactly-once rating per Attempt.

## Rating

Each accepted UsageEvent is rated into a **LedgerEntry**:

```
cost = cpu_ms      * rate.cpu
     + mem_mb_peak  * wall_ms * rate.mem
     + egress_bytes * rate.egress
```

Rates are per-tenant and per-effective-date. A tenant's rate card is versioned; a
UsageEvent is always rated with the rate card in effect at the event's timestamp, even
if the card changes later.

## The Ledger

The Ledger is **append-only** (see `01-overview.md`). Corrections are never done by
editing or deleting a LedgerEntry; instead a **compensating entry** (a negative-cost
LedgerEntry referencing the original `ue_id`) is appended. The net of an entry and its
compensation is the correction.

## Invoice generation

- A tenant's billing period is one calendar month in the tenant's configured timezone.
- At **month close**, Billing sums all LedgerEntries whose event timestamp falls in the
  period (including compensations) into an immutable **Invoice**.
- An Invoice is **frozen**: once generated it is never mutated. A correction discovered
  after close appears as a line item on the *next* month's Invoice, carried via a
  compensating LedgerEntry.

## Late events

UsageEvents can arrive after month close (a worker was partitioned, then recovered).
Policy: an event is always rated into the period of **its own timestamp**. If that
period is already closed, its LedgerEntry is still written to the (now historical)
period's ledger, and the resulting delta is surfaced on the next open Invoice as a
"prior-period adjustment". The closed Invoice itself never changes.

## Reconciliation with the Control Plane

Nightly, the Meter cross-checks: every terminal Attempt in the Control Plane should have
exactly one rated LedgerEntry (modulo compensations). Missing entries raise a
`usage-gap` alert; extra entries raise a `usage-orphan` alert (see `05-operations.md`).
