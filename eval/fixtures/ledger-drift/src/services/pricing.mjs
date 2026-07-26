import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const pricingConfig = {
  retryLimit: 3,
  timeoutMs: 2750,
  poolSize: 20,
};

export async function handlePricing(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= pricingConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("pricing", pricingConfig.timeoutMs, pricingConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("pricing.dur", Date.now() - started);
      return { ok: true, service: "pricing", result };
    } catch (error) {
      metrics.count("pricing.err");
      if (attempt === pricingConfig.retryLimit) throw error;
    }
  }
}
