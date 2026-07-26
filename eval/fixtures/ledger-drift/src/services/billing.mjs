import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const billingConfig = {
  retryLimit: 2,
  timeoutMs: 1000,
  poolSize: 10,
};

export async function handleBilling(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= billingConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("billing", billingConfig.timeoutMs, billingConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("billing.dur", Date.now() - started);
      return { ok: true, service: "billing", result };
    } catch (error) {
      metrics.count("billing.err");
      if (attempt === billingConfig.retryLimit) throw error;
    }
  }
}
