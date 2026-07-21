import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateMatrixState,
  classifyRunnerReport,
  compactMatrixReport,
  createMatrixState,
  expandMatrixManifest,
  formatMatrixMarkdown,
  shouldSkipExisting,
  validateMatrixManifest,
} from "./matrix.mjs";

const manifest = {
  id: "test-matrix",
  cells: [
    {
      id: "strong-product",
      model: { provider: "local-responses", id: "gpt-5.6-sol" },
      thinking: "high",
      environment: "product-isolated",
      scenarios: ["directed-travel-handoff", "advanced-pointer-routing"],
      repeats: 2,
    },
    {
      id: "weak-core",
      model: "local-openai/deepseek-v4-flash",
      thinking: "medium",
      environment: "core-only",
      scenarios: ["pressure-keep-live-uncertainty"],
    },
  ],
};

function singleResult(overrides = {}) {
  return {
    results: [{
      pass: true,
      checks: [],
      toolCalls: [],
      skillAvailability: { status: "available_from_expected_checkout" },
      ...overrides,
    }],
  };
}

describe("declarative eval matrix", () => {
  test("validates and expands model × environment × scenario × repeat without ambient axes", () => {
    const expanded = expandMatrixManifest(manifest);
    expect(expanded.manifest.cells).toHaveLength(2);
    expect(expanded.jobs).toHaveLength(5);
    expect(expanded.jobs.map((job) => job.key)).toEqual([
      "strong-product--directed-travel-handoff--r01",
      "strong-product--directed-travel-handoff--r02",
      "strong-product--advanced-pointer-routing--r01",
      "strong-product--advanced-pointer-routing--r02",
      "weak-core--pressure-keep-live-uncertainty--r01",
    ]);
    expect(expanded.jobs[0]).toMatchObject({
      model: "local-responses/gpt-5.6-sol",
      thinking: "high",
      environment: "product-isolated",
      scenarioId: "directed-travel-handoff",
      repeat: 1,
    });
  });

  test("rejects duplicate cells, unsupported environments, duplicate scenarios, and nonpositive repetitions", () => {
    expect(() => validateMatrixManifest({ ...manifest, cells: [{ ...manifest.cells[0] }, { ...manifest.cells[0] }] })).toThrow("unique");
    expect(() => validateMatrixManifest({ ...manifest, cells: [{ ...manifest.cells[0], environment: "ambient" }] })).toThrow("one of");
    expect(() => validateMatrixManifest({ ...manifest, cells: [{ ...manifest.cells[0], scenarios: ["x", "x"] }] })).toThrow("duplicates");
    expect(() => validateMatrixManifest({ ...manifest, cells: [{ ...manifest.cells[0], repeats: 0 }] })).toThrow("positive integer");
    expect(() => expandMatrixManifest({
      id: "normalized-key-collision",
      cells: [
        { ...manifest.cells[0], id: "a/b", scenarios: ["x"], repeats: 1 },
        { ...manifest.cells[1], id: "a b", scenarios: ["x"], repeats: 1 },
      ],
    })).toThrow("key collision");
  });

  test("distinguishes task scoring, terminal assistant, provider/RPC, and infrastructure failures", () => {
    expect(classifyRunnerReport(singleResult())).toMatchObject({ status: "passed", failureClass: null });
    expect(classifyRunnerReport(singleResult({ pass: false, checks: [{ name: "handoff", pass: false }] }))).toMatchObject({
      status: "scenario_failure", failureClass: "scenario",
    });
    expect(classifyRunnerReport(singleResult({ pass: false, error: "assistant turn failed: provider stopped" }))).toMatchObject({
      status: "terminal_failure", failureClass: "terminal",
    });
    expect(classifyRunnerReport(singleResult({ pass: false, error: "RPC response timeout for prompt" }))).toMatchObject({
      status: "provider_failure", failureClass: "provider",
    });
    expect(classifyRunnerReport(singleResult({
      pass: false,
      infrastructureInvalid: { status: "missing", reason: "skill unavailable" },
    }))).toMatchObject({ status: "infrastructure_invalid", failureClass: "infrastructure" });
  });

  test("keeps durable completed reports during resume and aggregates checks, tools, and availability", () => {
    const expanded = expandMatrixManifest(manifest);
    const state = createMatrixState({
      matrixSource: "eval/test-matrix.mjs",
      manifest: expanded.manifest,
      jobs: expanded.jobs,
      outputDir: "/tmp/matrix",
      startedAt: "2026-07-21T00:00:00.000Z",
    });
    const [passed, scored, terminal, provider, pending] = Object.values(state.jobs);
    Object.assign(passed, {
      status: "passed",
      reportPath: "/tmp/one/report.json",
      report: singleResult({
        toolCalls: [{ name: "acm_checkpoint" }, { name: "acm_travel" }],
      }),
    });
    Object.assign(scored, {
      status: "scenario_failure",
      reportPath: "/tmp/two/report.json",
      report: singleResult({
        pass: false,
        checks: [{ name: "direct NEXT", pass: false }, { name: "direct NEXT", pass: false }],
        toolCalls: [{ name: "read" }],
        skillAvailability: { status: "absent_as_expected" },
      }),
    });
    Object.assign(terminal, {
      status: "terminal_failure",
      reportPath: "/tmp/three/report.json",
      report: singleResult({ pass: false, error: "assistant turn failed: aborted" }),
    });
    Object.assign(provider, {
      status: "provider_failure",
      reportPath: "/tmp/four/report.json",
      report: singleResult({ pass: false, error: "RPC response timeout for prompt" }),
    });
    state.lastInvocation = { skippedExistingKeys: [passed.key, scored.key] };

    expect(shouldSkipExisting(passed)).toBe(true);
    expect(shouldSkipExisting(scored)).toBe(true);
    expect(shouldSkipExisting(terminal)).toBe(false);

    const aggregate = aggregateMatrixState(state);
    expect(aggregate).toMatchObject({
      total: 5,
      completed: 4,
      passed: 1,
      scenarioFailures: 1,
      terminalFailures: 1,
      providerFailures: 1,
      pending: 1,
      skippedExisting: 2,
      passRate: 0.5,
    });
    expect(aggregate.failedChecks).toEqual({ "direct NEXT": 2 });
    expect(aggregate.toolSequences).toEqual({
      "acm_checkpoint → acm_travel": 1,
      read: 1,
      "(no tools)": 2,
    });
    expect(aggregate.skillAvailability).toEqual({
      available_from_expected_checkout: 3,
      absent_as_expected: 1,
    });

    const compact = compactMatrixReport(state, { generatedAt: "2026-07-21T01:00:00.000Z" });
    expect(compact.jobs.find((job) => job.key === passed.key)?.reportPath).toBe("/tmp/one/report.json");
    const markdown = formatMatrixMarkdown(compact);
    expect(markdown).toContain("Provider failures");
    expect(markdown).toContain("acm_checkpoint → acm_travel");
    expect(markdown).toContain("`/tmp/one/report.json`");
  });
});

describe("matrix runner CLI", () => {
  test("defaults to a persisted plan and never launches providers without --execute", () => {
    const output = mkdtempSync(join(tmpdir(), "pi-context-matrix-preview-"));
    const result = Bun.spawnSync({
      cmd: ["bun", "eval/run-matrix.mjs", "--matrix", "eval/matrix.default.mjs", "--output", output],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
    expect(result.exitCode).toBe(0);
    expect(text).toContain("Preview only: no providers started.");
    const report = JSON.parse(readFileSync(join(output, "matrix-report.json"), "utf8"));
    expect(report.status).toBe("planned");
    expect(report.summary).toMatchObject({ total: 30, pending: 30, completed: 0 });
    expect(report.jobs.every((job) => job.reportPath === null)).toBe(true);
    expect(report.piProvenance).toMatchObject({
      cliPath: expect.any(String),
      version: expect.any(String),
      projectExactHostContract: "0.80.7",
    });
  });
});
