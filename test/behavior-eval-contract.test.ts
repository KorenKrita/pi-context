import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ACM_BEHAVIOR_SCENARIOS,
  REQUIRED_BEHAVIORS,
} from "../eval/acm-behavior-scenarios.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runner = readFileSync(new URL("../scripts/eval-acm-behavior.mjs", import.meta.url), "utf8");
const mockExtension = readFileSync(new URL("../eval/mock-acm-extension.ts", import.meta.url), "utf8");

describe("ACM open-ended behavior eval contract", () => {
  test("covers every required behavior with multiple phrasings", () => {
    const byFamily = new Map<string, typeof ACM_BEHAVIOR_SCENARIOS>();
    for (const scenario of ACM_BEHAVIOR_SCENARIOS) {
      const scenarios = byFamily.get(scenario.family) ?? [];
      scenarios.push(scenario);
      byFamily.set(scenario.family, scenarios);
    }

    expect([...byFamily.keys()].sort()).toEqual([...REQUIRED_BEHAVIORS].sort());
    expect(REQUIRED_BEHAVIORS).toContain("receipt-discipline");
    for (const family of REQUIRED_BEHAVIORS) {
      expect(byFamily.get(family)?.length, family).toBeGreaterThanOrEqual(2);
    }
  });

  test("scores semantic invariants rather than one exact trajectory", () => {
    for (const scenario of ACM_BEHAVIOR_SCENARIOS) {
      expect(scenario.id.length).toBeGreaterThan(0);
      expect(scenario.prompt.length).toBeGreaterThan(80);
      expect(scenario.criteria.length).toBeGreaterThanOrEqual(3);
      expect(scenario.prompt).not.toContain("Expected answer");
      expect(scenario.prompt).not.toContain("exact tool order");
      expect(scenario.prompt).not.toContain("deepseek");
      expect(scenario.prompt).not.toContain("-done");
    }
  });

  test("observes actual assistant tool batches through a mock ACM extension", () => {
    expect(runner).toContain("eval/mock-acm-extension.ts");
    expect(runner).toContain("acm_checkpoint,acm_timeline,acm_travel,eval_observe_external");
    expect(runner).not.toContain("acm_checkpoint,acm_timeline,acm_travel,bash");
    expect(runner).toContain("agent_end");
    expect(runner).toContain("all toolCall parts inside one assistant message are one batch");
    expect(runner).not.toContain("tools are not connected");
    expect(mockExtension).toContain("description: TOOL_DESCRIPTIONS.checkpoint");
    expect(mockExtension).toContain("description: TOOL_DESCRIPTIONS.timeline");
    expect(mockExtension).toContain("description: TOOL_DESCRIPTIONS.travel");
    expect(mockExtension).toContain("attachAcmReceipt(toolCallId, \"acm_checkpoint\"");
    expect(mockExtension).toContain("attachAcmReceipt(toolCallId, \"acm_timeline\"");
    expect(mockExtension).toContain("attachAcmReceipt(toolCallId, \"acm_travel\"");
    expect(mockExtension).toContain('name: "eval_observe_external"');
    expect(mockExtension).toContain("performs no mutation");
    expect(mockExtension).toContain("executionMode: \"sequential\"");
  });

  test("keeps the stochastic eval outside the deterministic verification gate", () => {
    expect(packageJson.scripts["eval:acm"]).toBe("bun scripts/eval-acm-behavior.mjs");
    expect(packageJson.scripts["verify:acm"]).not.toContain("eval:acm");
  });
});
