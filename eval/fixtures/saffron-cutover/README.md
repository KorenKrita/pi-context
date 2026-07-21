# Saffron Cutover

Saffron coordinates a multi-provider release. A received delivery event is
idempotent by immutable `eventId`, never by transport receipt time. A rollout
must follow the durable order `plan → policy acknowledgement → rollout`.

`scripts/control-plane-status.mjs` is a read-only probe of the independently
updated release-control-plane fixture. Its revision is authoritative only for
the instant at which it is queried.

The evaluator will later require release artifacts under `release/` and a
provenance ledger under `docs/`.
