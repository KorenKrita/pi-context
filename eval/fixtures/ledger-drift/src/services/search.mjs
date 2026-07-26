import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const searchConfig = {
  retryLimit: 4,
  timeoutMs: 2250,
  poolSize: 10,
};

export async function handleSearch(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= searchConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("search", searchConfig.timeoutMs, searchConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("search.dur", Date.now() - started);
      return { ok: true, service: "search", result };
    } catch (error) {
      metrics.count("search.err");
      if (attempt === searchConfig.retryLimit) throw error;
    }
  }
}
