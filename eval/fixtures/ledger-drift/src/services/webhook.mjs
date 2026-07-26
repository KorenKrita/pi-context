import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const webhookConfig = {
  retryLimit: 4,
  timeoutMs: 3000,
  poolSize: 25,
};

export async function handleWebhook(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= webhookConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("webhook", webhookConfig.timeoutMs, webhookConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("webhook.dur", Date.now() - started);
      return { ok: true, service: "webhook", result };
    } catch (error) {
      metrics.count("webhook.err");
      if (attempt === webhookConfig.retryLimit) throw error;
    }
  }
}
