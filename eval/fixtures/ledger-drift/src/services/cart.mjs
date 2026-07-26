import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const cartConfig = {
  retryLimit: 2,
  timeoutMs: 2500,
  poolSize: 15,
};

export async function handleCart(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= cartConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("cart", cartConfig.timeoutMs, cartConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("cart.dur", Date.now() - started);
      return { ok: true, service: "cart", result };
    } catch (error) {
      metrics.count("cart.err");
      if (attempt === cartConfig.retryLimit) throw error;
    }
  }
}
