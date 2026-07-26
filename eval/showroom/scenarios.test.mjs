import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./scenarios.mjs";

const roots = [];
const services = [
  "billing", "checkout", "inventory", "shipping", "auth", "search",
  "cart", "pricing", "webhook", "ledger", "notify", "report",
];

function servicePaths(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const service = services[index % services.length] + (index >= services.length ? String(index) : "");
    return `services/${service}.ts`;
  });
}

function build(id) {
  const root = mkdtempSync(join(tmpdir(), `showroom-${id.toLowerCase()}-`));
  roots.push(root);
  const workspace = join(root, "workspace");
  const toolCalls = [];
  const builder = {
    user() {},
    assistantText() {},
    toolCall(name, input, result, usage) { toolCalls.push({ name, input, result, usage }); },
  };
  return { workspace, toolCalls, expected: SCENARIOS[id].build(builder, { workspace }) };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("showroom live scenario sizing", () => {
  for (const id of ["P4", "P5"]) {
    test(`${id} requires an explicit 12-file read sweep`, () => {
      const { workspace, expected } = build(id);
      expect(readdirSync(join(workspace, "services")).length).toBe(12);
      const livePrompt = expected.resumePrompts[0];
      expect(livePrompt).toContain("用 read 打开");
      for (const path of servicePaths(0, 12)) expect(livePrompt).toContain(path);
    });
  }

  test("negative fixtures point at the files and forbidden interval they actually assay", () => {
    const n1 = build("N1");
    expect(readdirSync(join(n1.workspace, "services")).length).toBe(12);
    for (const path of servicePaths(0, 12)) expect(n1.expected.resumePrompts[0]).toContain(path);
    expect(n1.expected.expect.workspace).toEqual({
      files: servicePaths(0, 12),
      mustContain: ["retryLimit: 3,"],
    });
    const n4 = build("N4");
    for (const path of servicePaths(0, 9)) expect(n4.expected.resumePrompts[0]).toContain(path);
    expect(n4.expected.expect.forbiddenMoves).toEqual([{ tool: "acm_travel", beforeProbeAnswer: true }]);

    const n5 = build("N5");
    expect(readdirSync(join(n5.workspace, "services"))).toContain("notify.ts");
    expect(n5.expected.resumePrompts[0]).toContain("services/notify.ts");
  });

  test("pressure assays keep synthetic usage while compacting provider-bound prefix text", () => {
    const p3 = build("P3");
    expect(p3.toolCalls).toHaveLength(18);
    expect(Math.max(...p3.toolCalls.map((call) => call.result.split("\n").length))).toBeLessThanOrEqual(6);
    for (const path of servicePaths(0, 10)) expect(p3.expected.resumePrompts[0]).toContain(path);
  });

  test("knob prompts enumerate exactly the intended reads in each phase", () => {
    const k1 = build("K1-9");
    expect(readdirSync(join(k1.workspace, "services"))).toHaveLength(9);
    for (const path of servicePaths(0, 9)) expect(k1.expected.resumePrompts[0]).toContain(path);

    const k4 = build("K4");
    expect(readdirSync(join(k4.workspace, "services"))).toHaveLength(20);
    for (const path of servicePaths(0, 10)) expect(k4.expected.resumePrompts[0]).toContain(path);
    for (const path of servicePaths(10, 10)) expect(k4.expected.resumePrompts[1]).toContain(path);
  });

  test("hard positives demand more than one ACM move across turns", () => {
    // D1: front one is parked in turn 1, then must still be answerable in turn 2.
    const d1 = build("D1");
    expect(d1.expected.resumePrompts).toHaveLength(2);
    for (const path of servicePaths(0, 12)) expect(d1.expected.resumePrompts[0]).toContain(path);
    expect(d1.expected.expect.requiredMoves).toEqual([
      { tool: "acm_checkpoint|acm_travel", inTurn: 1, withinToolCalls: 14 },
    ]);
    expect(d1.expected.expect.probe.mustContain).toContain("ack_timeout");

    // D2: three phases, so the third fold is a rebase rather than a new layer.
    const d2 = build("D2");
    expect(d2.expected.resumePrompts).toHaveLength(3);
    expect(d2.expected.expect.requiredMoves).toEqual([{ tool: "acm_travel", inTurn: 3 }]);
    // Both phases' conclusions must survive the consolidation.
    expect(d2.expected.expect.probe.mustContain).toEqual(["ledger-writer", "poolSize"]);

    // D3: the exact value is planted in the prefix, then folded away by turn 1.
    const d3 = build("D3");
    expect(d3.toolCalls).toHaveLength(26);
    expect(d3.toolCalls.some((call) => call.result.includes("p99=1840ms"))).toBe(true);
    expect(d3.expected.expect.probe.mustContain).toEqual(["1840", "zt"]);
  });
});
