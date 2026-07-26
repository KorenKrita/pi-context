import { Pool } from "../lib/pool.mjs";
import { metrics } from "../lib/metrics.mjs";

// Local retry/timeout/pool constants. Added per-service over 14 months; the
// values were never reconciled against ops/slo-targets.json.
export const inventoryConfig = {
  retryLimit: 4,
  timeoutMs: 1500,
  poolSize: 20,
};

export async function handleInventory(request) {
  const started = Date.now();
  for (let attempt = 0; attempt <= inventoryConfig.retryLimit; attempt += 1) {
    try {
      const conn = await Pool.acquire("inventory", inventoryConfig.timeoutMs, inventoryConfig.poolSize);
      const result = await conn.run(request.payload);
      metrics.observe("inventory.dur", Date.now() - started);
      return { ok: true, service: "inventory", result };
    } catch (error) {
      metrics.count("inventory.err");
      if (attempt === inventoryConfig.retryLimit) throw error;
    }
  }
}
