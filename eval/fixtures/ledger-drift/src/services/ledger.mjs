import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const ledgerConfig = {
  retryLimit: 2,
  timeoutMs: 3250,
  poolSize: 30,
};

export async function handleLedger(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= ledgerConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("ledger", ledgerConfig.timeoutMs, ledgerConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("ledger.dur", Date.now() - started);
      return { ok: true, service: "ledger", result };
    } catch (error) {
      metrics.count("ledger.err");
      if (attempt === ledgerConfig.retryLimit) throw error;
    }
  }
}
