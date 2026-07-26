import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const shippingConfig = {
  retryLimit: 2,
  timeoutMs: 1750,
  poolSize: 25,
};

export async function handleShipping(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= shippingConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("shipping", shippingConfig.timeoutMs, shippingConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("shipping.dur", Date.now() - started);
      return { ok: true, service: "shipping", result };
    } catch (error) {
      metrics.count("shipping.err");
      if (attempt === shippingConfig.retryLimit) throw error;
    }
  }
}
