import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acmLedgerPath,
  appendLedgerRow,
  buildBoundaryRow,
  buildFoldRow,
  createLedgerState,
  isLedgerDisabled,
  markBoundaryCounted,
  markFoldCounted,
  shouldCountBoundary,
} from "../src/boundary-ledger.js";

/**
 * The ledger exists because a fold missed at a request boundary is otherwise
 * unobservable. Its two hard properties are therefore: it must record, and it
 * must never be able to break a tool result.
 */

function tempEnv(): Record<string, string | undefined> {
  return { PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "acm-ledger-")) };
}

describe("boundary ledger", () => {
  test("appends one row per call under a fixed schema", () => {
    const env = tempEnv();
    const state = createLedgerState("s1");
    expect(appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 23.9, windowPercent: 9.4,
      foldTurnPercent: 16.7, foldTaskPercent: 16.2, entries: 42,
    }), env)).toBe(true);

    const rows = readFileSync(acmLedgerPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    // Percentages are floored so a row matches what the gauge rendered.
    expect(rows[0]).toMatchObject({
      kind: "boundary", session: "s1", boundary: 1,
      budget: 23, window: 9, foldTurn: 16, foldTask: 16, foldsSoFar: 0, entries: 42,
    });
  });

  test("records only counts and percentages, never message content", () => {
    const env = tempEnv();
    const state = createLedgerState("s2");
    appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 10, windowPercent: 5,
      foldTurnPercent: null, foldTaskPercent: null, entries: 3,
    }), env);
    appendLedgerRow("fold", buildFoldRow({
      state, budgetBefore: 80, budgetAfter: 20, messageDelta: 120, summaryDepth: 1,
    }), env);

    const raw = readFileSync(acmLedgerPath(env), "utf8");
    for (const row of raw.trim().split("\n")) {
      const keys = Object.keys(JSON.parse(row));
      // An allowlist, not a denylist: a future field carrying text must fail here.
      expect(keys.every((k) => [
        "kind", "ts", "session", "boundary", "budget", "window", "foldTurn",
        "foldTask", "foldsSoFar", "entries", "afterBoundary", "budgetBefore",
        "budgetAfter", "messageDelta", "summaryDepth",
      ].includes(k))).toBe(true);
    }
  });

  test("a missing or unusable value is null, never zero", () => {
    const env = tempEnv();
    const state = createLedgerState("s3");
    appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: undefined, windowPercent: Number.NaN,
      foldTurnPercent: null, foldTaskPercent: undefined, entries: 1,
    }), env);
    const row = JSON.parse(readFileSync(acmLedgerPath(env), "utf8").trim());
    expect(row.budget).toBeNull();
    expect(row.window).toBeNull();
    expect(row.foldTurn).toBeNull();
    expect(row.foldTask).toBeNull();
  });

  test("counts a boundary once per distinct entry, not once per tool result", () => {
    // The same boundary is observed on every tool result of that turn; counting
    // observations would report tool activity instead of request structure.
    const state = createLedgerState("s4");
    expect(shouldCountBoundary(state, "u1")).toBe(true);
    markBoundaryCounted(state, "u1");
    expect(shouldCountBoundary(state, "u1")).toBe(false);
    expect(shouldCountBoundary(state, "u2")).toBe(true);
    expect(markBoundaryCounted(state, "u2")).toBe(2);
    expect(shouldCountBoundary(state, null)).toBe(false);
    expect(markFoldCounted(state)).toBe(1);
  });

  test("an unwritable target fails silently instead of throwing", () => {
    // Hard requirement: the ledger is not allowed to become a failure surface.
    const env = { PI_CODING_AGENT_DIR: "/dev/null/definitely-not-a-directory" };
    const state = createLedgerState("s5");
    expect(() => appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 1, windowPercent: 1,
      foldTurnPercent: 1, foldTaskPercent: 1, entries: 1,
    }), env)).not.toThrow();
    expect(appendLedgerRow("fold", buildFoldRow({
      state, budgetBefore: 1, budgetAfter: 1, messageDelta: 1, summaryDepth: 1,
    }), env)).toBe(false);
  });

  test("the kill switch silences writing entirely", () => {
    const env = { ...tempEnv(), ACM_LEDGER_DISABLED: "1" };
    expect(isLedgerDisabled(env)).toBe(true);
    const state = createLedgerState("s6");
    expect(appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 1, windowPercent: 1,
      foldTurnPercent: 1, foldTaskPercent: 1, entries: 1,
    }), env)).toBe(false);
    expect(existsSync(acmLedgerPath(env))).toBe(false);
  });

  test("the writer is append-only with no read or query path", () => {
    const source = readFileSync(new URL("../src/boundary-ledger.ts", import.meta.url), "utf8");
    expect(source).toContain("appendFileSync");
    for (const readApi of ["readFileSync", "createReadStream", "readdirSync", "watch"]) {
      expect(source).not.toContain(readApi);
    }
  });
});
