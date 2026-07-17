# Cadence Platform — System Overview

Cadence is a multi-tenant workflow orchestration and usage-metering platform.
Tenants define **workflows** (directed graphs of **tasks**), Cadence schedules and
runs them across a worker fleet, records **usage events** for every task attempt,
and rolls those events up into monthly **invoices**.

This corpus is the internal design reference. The documents are:

- `01-overview.md` — this file: components, request lifecycle, glossary.
- `02-data-model.md` — entities, identifiers, and the task/run state machines.
- `03-scheduling.md` — how the scheduler picks, dispatches, and retries tasks.
- `04-metering-billing.md` — usage events, rating, and invoice generation.
- `05-operations.md` — quotas, limits, timeouts, and the on-call runbook.

## Components

| Component | Responsibility |
|---|---|
| **Gateway** | Terminates tenant API calls, authenticates, enforces per-tenant rate limits. |
| **Control Plane** | Stores workflow definitions, materializes runs, owns the task state machine. |
| **Scheduler** | Picks ready tasks and assigns them to workers; owns retry/backoff policy. |
| **Worker Fleet** | Executes task payloads in sandboxes; emits heartbeats and usage events. |
| **Meter** | Ingests usage events, deduplicates them, and writes the rated ledger. |
| **Billing** | Closes each tenant's monthly ledger into an immutable invoice. |

The Control Plane is the source of truth for *state*; the Meter is the source of
truth for *usage*. These two never share a database — they reconcile asynchronously
through the usage-event stream (see `04-metering-billing.md`).

## Request lifecycle (happy path)

1. Tenant submits a **workflow definition** through the Gateway.
2. Control Plane validates the graph (acyclic, every task references a known
   handler) and stores it as an immutable **WorkflowVersion**.
3. Tenant triggers a **Run** of a WorkflowVersion.
4. Control Plane materializes one **Task** per node and marks source tasks `READY`.
5. Scheduler dispatches `READY` tasks to workers, moving them to `RUNNING`.
6. A worker executes the task, emits a **UsageEvent**, and reports success/failure.
7. Control Plane advances the run: successors become `READY`; the run finishes when
   every task reaches a terminal state.
8. Meter rates the UsageEvents; at month close, Billing freezes the invoice.

## Design principles

- **Runs are immutable once terminal.** A finished run is never mutated; a re-execution
  is a brand-new run that references the same WorkflowVersion.
- **Usage is append-only.** UsageEvents are never edited or deleted; corrections are
  posted as compensating events (see `04-metering-billing.md`).
- **The scheduler is stateless.** All durable scheduling state lives in the Control
  Plane; the Scheduler can be restarted at any time without loss.

## Glossary

- **Workflow / WorkflowVersion** — a tenant's task graph; versions are immutable.
- **Run** — one execution of a WorkflowVersion.
- **Task** — one node of a Run; carries its own state (see `02-data-model.md`).
- **Attempt** — one execution try of a Task; retries create new Attempts.
- **UsageEvent** — a metered record emitted per Attempt.
- **Ledger** — the Meter's append-only store of rated usage.
- **Invoice** — a frozen monthly rollup of a tenant's ledger.

> Terminology note: "job" is a legacy synonym for **Task** that still appears in some
> older sections and in the Scheduler's metrics. Treat "job" and "Task" as the same
> concept unless a document says otherwise.
