import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const authConfig = {
  retryLimit: 3,
  timeoutMs: 2000,
  poolSize: 30,
};

export async function handleAuth(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= authConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("auth", authConfig.timeoutMs, authConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("auth.dur", Date.now() - started);
      return { ok: true, service: "auth", result };
    } catch (error) {
      metrics.count("auth.err");
      if (attempt === authConfig.retryLimit) throw error;
    }
  }
}
