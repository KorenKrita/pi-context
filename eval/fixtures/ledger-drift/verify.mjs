// Objective outcome check for the ledger-drift reconciliation task.
// Exit 0 only when every service config derives from ops/slo-targets.json,
// with the single approved waiver from ops/incidents/2026-05-17-search-pool.md
// preserved. No ACM vocabulary and no dependence on how the work was done.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const failures = [];

const targets = JSON.parse(readFileSync(join(HERE, "ops/slo-targets.json"), "utf8"));

// The waiver: search keeps an elevated pool; everything else is tier-exact.
const WAIVERS = { search: { poolSize: 40 } };

for (const [service, tier] of Object.entries(targets.assignments)) {
  const expected = { ...targets.tiers[tier], ...(WAIVERS[service] ?? {}) };
  let actual;
  try {
    const module = await import(join(HERE, "src/services", `${service}.mjs`));
    actual = module[`${service}Config`];
  } catch (error) {
    failures.push(`${service}: cannot load config (${error.message})`);
    continue;
  }
  if (!actual) {
    failures.push(`${service}: missing exported ${service}Config`);
    continue;
  }
  for (const key of ["retryLimit", "timeoutMs", "poolSize"]) {
    if (actual[key] !== expected[key]) {
      failures.push(`${service}.${key}: expected ${expected[key]} (${tier}${WAIVERS[service]?.[key] !== undefined ? " + waiver" : ""}), found ${actual[key]}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`ledger-drift verification failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`ledger-drift verification passed: ${Object.keys(targets.assignments).length} services reconciled\n`);
