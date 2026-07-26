import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const reportConfig = {
  retryLimit: 4,
  timeoutMs: 3750,
  poolSize: 15,
};

export async function handleReport(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= reportConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("report", reportConfig.timeoutMs, reportConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("report.dur", Date.now() - started);
      return { ok: true, service: "report", result };
    } catch (error) {
      metrics.count("report.err");
      if (attempt === reportConfig.retryLimit) throw error;
    }
  }
}
