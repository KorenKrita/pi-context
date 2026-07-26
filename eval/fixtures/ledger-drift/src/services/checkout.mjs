import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const checkoutConfig = {
  retryLimit: 3,
  timeoutMs: 1250,
  poolSize: 15,
};

export async function handleCheckout(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= checkoutConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("checkout", checkoutConfig.timeoutMs, checkoutConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("checkout.dur", Date.now() - started);
      return { ok: true, service: "checkout", result };
    } catch (error) {
      metrics.count("checkout.err");
      if (attempt === checkoutConfig.retryLimit) throw error;
    }
  }
}
