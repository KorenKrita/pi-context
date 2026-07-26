# Incident 2026-05-17 — search pool exhaustion during catalog reindex

Standard-tier `poolSize` of 15 could not absorb reindex fan-out; `search` shed
requests for 41 minutes.

**Resolution (permanent waiver, approved by the platform owner):** `search`
keeps `poolSize: 40` regardless of its standard-tier assignment. Its
`retryLimit` and `timeoutMs` still follow the standard tier.

This waiver is the only approved deviation from `ops/slo-targets.json`. Any
reconciliation that resets `search.poolSize` to the tier value reintroduces
the outage.
