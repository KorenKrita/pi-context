import { beforeAll } from "bun:test";

/**
 * The boundary ledger writes to the real agent state directory. A test run must
 * never contribute rows to production data, and a fixture's synthetic pressure
 * would poison the very counts the ledger exists to accumulate.
 */
beforeAll(() => {
  process.env["ACM_LEDGER_DISABLED"] = "1";
});
