import { describe, expect, test } from "bun:test";

import { ROW_FIELDS, buildRow, collectScores, parseArgs, resolveProductCommit, summarizeRows } from "./run-all.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const BASE_ARGV = ["node", "run-all.mjs", "--model", "local-claude/claude-opus-4-8"];

describe("showroom batch arguments", () => {
  test("defaults to the whole scenario bank", () => {
    const args = parseArgs(BASE_ARGV);
    expect(args.scenarios).toEqual(Object.keys(SCENARIOS));
    expect(args.arm).toBe("both");
    expect(args.seed).toBe(7);
  });

  test("rejects an unknown scenario instead of silently skipping it", () => {
    expect(() => parseArgs([...BASE_ARGV, "--scenarios", "P1,NOPE"])).toThrow(/unknown scenario/);
  });

  test("requires a model", () => {
    expect(() => parseArgs(["node", "run-all.mjs"])).toThrow(/usage/);
  });
});

describe("single-commit guarantee", () => {
  const gitStub = (commit, porcelain) => (args) => {
    if (args[0] === "rev-parse") return commit;
    if (args[0] === "status") return porcelain;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  test("a clean tree yields a citable commit", () => {
    const product = resolveProductCommit({ allowDirty: false, git: gitStub("abc123", "") });
    expect(product).toEqual({ commit: "abc123", dirty: false, citable: true });
  });

  test("a dirty tree is refused rather than recorded as that commit", () => {
    expect(() => resolveProductCommit({ allowDirty: false, git: gitStub("abc123", " M src/runtime.ts") }))
      .toThrow(/working tree is dirty/);
  });

  test("--allow-dirty proceeds but marks the artifact non-citable", () => {
    const product = resolveProductCommit({ allowDirty: true, git: gitStub("abc123", " M src/runtime.ts") });
    expect(product.dirty).toBe(true);
    expect(product.citable).toBe(false);
  });
});

describe("evidence row shape", () => {
  const verdict = (onVerdict, offVerdict, extra = {}) => ({
    arms: {
      on: { verdict: onVerdict, diagnostics: { toolCalls: 11, reads: 9, writes: 0, firstAcmCallIndex: 0, ...extra } },
      off: { verdict: offVerdict, diagnostics: { toolCalls: 1, reads: 0, writes: 0, firstAcmCallIndex: -1 } },
    },
  });

  test("row field names line up with row arity", () => {
    const row = buildRow("P1", SCENARIOS.P1, verdict("pass", "fail"));
    expect(row.length).toBe(ROW_FIELDS.length);
    expect(row[0]).toBe("P1");
    expect(row[1]).toBe("outcome");
    expect(row[2]).toBe("pass");
    expect(row[3]).toBe("fail");
  });

  test("a diagnostics arm marks the row as diagnostics, not an outcome", () => {
    const row = buildRow("K1-7", SCENARIOS["K1-7"], verdict("diagnostics", "diagnostics"));
    expect(row[1]).toBe("diagnostics");
  });

  test("a missing arm is recorded rather than dropped", () => {
    const row = buildRow("P1", SCENARIOS.P1, { arms: {} });
    expect(row[2]).toBe("missing");
    expect(row[4]).toBeNull();
  });

  test("summary counts outcomes per arm and excludes diagnostics rows", () => {
    const rows = [
      buildRow("P1", SCENARIOS.P1, verdict("pass", "fail")),
      buildRow("P2", SCENARIOS.P2, verdict("pass", "pass")),
      buildRow("K1-7", SCENARIOS["K1-7"], verdict("diagnostics", "diagnostics")),
    ];
    const summary = summarizeRows(rows);
    expect(summary).toEqual({
      scenarios: 3,
      outcomeScenarios: 2,
      diagnosticsOnlyScenarios: 1,
      on: { pass: 2, fail: 0, runError: 0 },
      off: { pass: 1, fail: 1, runError: 0 },
    });
  });
});

describe("score aggregation", () => {
  const armScore = (toolCalls, acmCalls) => ({ score: { toolCalls, acmCalls } });

  test("pairs both arms and derives the on/off overhead ratio", () => {
    const scores = collectScores("N1", { arms: { on: armScore(62, 3), off: armScore(21, 1) } });

    expect(scores.delta).toEqual({ toolCalls: 41, acmCalls: 2, toolCallRatio: 2.95 });
  });

  test("omits the delta when an arm was not run", () => {
    const scores = collectScores("P1", { arms: { on: armScore(11, 1) } });

    expect(scores.on).toEqual({ toolCalls: 11, acmCalls: 1 });
    expect(scores.off).toBeNull();
    expect(scores.delta).toBeUndefined();
  });

  test("guards a zero-tool control arm instead of dividing by zero", () => {
    const scores = collectScores("N2", { arms: { on: armScore(4, 0), off: armScore(0, 0) } });

    expect(scores.delta.toolCallRatio).toBeNull();
  });
});
