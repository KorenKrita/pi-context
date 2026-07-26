import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const notifyConfig = {
  retryLimit: 3,
  timeoutMs: 3500,
  poolSize: 10,
};

export async function handleNotify(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= notifyConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("notify", notifyConfig.timeoutMs, notifyConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("notify.dur", Date.now() - started);
      return { ok: true, service: "notify", result };
    } catch (error) {
      metrics.count("notify.err");
      if (attempt === notifyConfig.retryLimit) throw error;
    }
  }
}
