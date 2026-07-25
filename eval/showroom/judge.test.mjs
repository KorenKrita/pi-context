import { describe, expect, test } from "bun:test";
import { checkRequiredMove } from "./judge.mjs";

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

  test("keeps turn placement as a semantic constraint", () => {
    const facts = [tool("acm_checkpoint", 1), tool("read", 2)];

    expect(checkRequiredMove(
      { tool: "acm_checkpoint", inTurn: 2, withinToolCalls: 4 },
      facts,
    )).toMatchObject({ satisfied: false });
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
});
