import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHandoff, checkRequiredMove, judgeArm } from "./judge.mjs";
const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function buildArmWorkspace(fileContents) {
  const armDir = mkdtempSync(join(tmpdir(), "showroom-judge-"));
  roots.push(armDir);
  mkdirSync(join(armDir, "workspace", "services"), { recursive: true });
  for (const [name, content] of Object.entries(fileContents)) {
    writeFileSync(join(armDir, "workspace", "services", name), content);
  }
  writeFileSync(join(armDir, "transcript.json"), JSON.stringify({
    turns: [{
      turn: 1,
      exitStatus: 0,
      timedOut: false,
      events: [{
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "12 services complete" }] },
      }],
    }],
  }));
  return armDir;
}

describe("showroom workspace judging", () => {
  test("gates the verdict on every declared file's final content", () => {
    const armDir = buildArmWorkspace({
      "billing.ts": "export const config = {\n  retryLimit: 3,\n};",
      "checkout.ts": "export const config = {\n  retryLimit: 30,\n};",
    });
    const expected = { expect: {
      probe: { mustContain: ["12"] },
      workspace: {
        files: ["services/billing.ts", "services/checkout.ts"],
        mustContain: ["retryLimit: 3,"],
      },
    } };

    expect(judgeArm(armDir, expected)).toMatchObject({
      verdict: "fail",
      checks: {
        probe: { satisfied: true },
        workspace: {
          satisfied: false,
          files: [
            { path: "services/billing.ts", satisfied: true, missing: [] },
            { path: "services/checkout.ts", satisfied: false, missing: ["retryLimit: 3,"] },
          ],
        },
      },
    });

    writeFileSync(join(armDir, "workspace", "services", "checkout.ts"), "export const config = {\n  retryLimit: 3,\n};");
    expect(judgeArm(armDir, expected)).toMatchObject({
      verdict: "pass",
      checks: { workspace: { satisfied: true } },
    });
  });

  test("rejects assertions that escape the arm workspace", () => {
    const armDir = buildArmWorkspace({ "billing.ts": "retryLimit: 3" });
    const expected = { expect: { workspace: { files: ["../outside.ts"], mustContain: [] } } };

    expect(judgeArm(armDir, expected)).toMatchObject({
      verdict: "fail",
      checks: {
        workspace: {
          satisfied: false,
          files: [{ path: "../outside.ts", satisfied: false, reason: "path escapes workspace" }],
        },
      },
    });
  });
});
function tool(name, turn = 1) {
  return { kind: "tool", name, turn, input: {} };
}

describe("showroom required-move judging", () => {
  test("counts a late required move before task end and reports latency diagnostically", () => {
    const facts = [
      ...Array.from({ length: 8 }, () => tool("read")),
      ...Array.from({ length: 27 }, () => tool("bash")),
      tool("acm_checkpoint"),
    ];

    expect(checkRequiredMove(
      { tool: "acm_checkpoint|acm_travel", afterReads: 8, withinToolCalls: 8 },
      facts,
    )).toEqual({
      satisfied: true,
      at: { index: 35, turn: 1, name: "acm_checkpoint" },
      latency: { toolCallsAfterPrefix: 28, targetToolCalls: 8, withinTarget: false },
    });
  });

  test("still fails when the required move never happens before task end", () => {
    const facts = [tool("read"), tool("bash"), tool("write")];

    expect(checkRequiredMove({ tool: "acm_checkpoint", withinToolCalls: 2 }, facts)).toEqual({
      satisfied: false,
      reason: "no acm_checkpoint before task end after searching 3 tool calls",
      latency: { observedToolCalls: 3, targetToolCalls: 2, withinTarget: false },
    });
  });

  test("reports turn placement diagnostically instead of rejecting an early move", () => {
    const facts = [tool("acm_checkpoint", 1), tool("read", 2)];

    expect(checkRequiredMove(
      { tool: "acm_checkpoint", inTurn: 2, withinToolCalls: 4 },
      facts,
    )).toEqual({
      satisfied: true,
      at: { index: 0, turn: 1, name: "acm_checkpoint" },
      latency: { toolCallsAfterPrefix: 1, targetToolCalls: 4, withinTarget: true },
      placement: { actualTurn: 1, targetTurn: 2, inTargetTurn: false },
    });
  });

  test("reports a response inside the latency target", () => {
    const facts = [tool("read"), tool("acm_travel")];

    expect(checkRequiredMove(
      { tool: "acm_travel", afterReads: 1, withinToolCalls: 3 },
      facts,
    )).toMatchObject({
      satisfied: true,
      latency: { toolCallsAfterPrefix: 1, targetToolCalls: 3, withinTarget: true },
    });
  });
  test("reads required evidence from a structured travel handoff", () => {
    const facts = [tool("acm_travel")];
    facts[0].input = { handoff: { goal: "fix checkout", state: "ledger-writer crosses fsync" } };

    expect(checkHandoff(["ledger-writer", "fsync"], facts)).toEqual({
      applicable: true,
      satisfied: true,
      missing: [],
    });
  });

  test("supports provider string fallback and legacy summary handoffs", () => {
    const stringFallback = [tool("acm_travel")];
    stringFallback[0].input = { handoff: '{"state":"shipping p99=1840ms"}' };
    expect(checkHandoff(["shipping"], stringFallback)).toMatchObject({ satisfied: true });

    const legacy = [tool("acm_travel")];
    legacy[0].input = { summary: "legacy checkout handoff" };
    expect(checkHandoff(["checkout"], legacy)).toMatchObject({ satisfied: true });
  });
});
