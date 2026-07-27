import { beforeAll } from "bun:test";

/**
 * Host-fixture runs exercise the real lifecycle against an installed host, so
 * they reach the ledger writer. Fixture pressure is synthetic; letting it reach
 * the real agent state directory would poison the very counts the ledger exists
 * to accumulate.
 */
beforeAll(() => {
  process.env["ACM_LEDGER_DISABLED"] = "1";
});
