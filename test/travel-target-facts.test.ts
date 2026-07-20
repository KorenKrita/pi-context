import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildTravelTargetFacts } from "../src/travel-target-facts.js";
import type { ToolProtocolAnalysis } from "../src/tool-protocol.js";

function user(id: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "old request", timestamp: 1 },
  } as SessionEntry;
}

function protocol(status: ToolProtocolAnalysis["status"]): ToolProtocolAnalysis {
  return {
    status,
    messages: [],
    repairs: status === "repaired"
      ? [{ kind: "synthesized_missing_result", toolCallId: "read-1", toolName: "read" }]
      : [],
    defects: status === "invalid"
      ? [{ kind: "duplicate_tool_call_id", assistantIndex: 0, toolCallId: "duplicate" }]
      : [],
  };
}

describe("travel target facts", () => {
  test("keeps protocol, open-user, tool-batch, summary, and off-path facts independent", () => {
    const root = user("root");
    const assistant = {
      type: "message",
      id: "assistant-tool",
      parentId: root.id,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "OLD_TASK.md" } }],
        stopReason: "toolUse",
        timestamp: 2,
      },
    } as SessionEntry;

    const result = buildTravelTargetFacts({
      targetId: assistant.id,
      targetEntry: assistant,
      targetBranch: [root, assistant],
      protocol: protocol("repaired"),
      fromOffPath: true,
    });

    expect(result.facts).toMatchObject({
      targetId: assistant.id,
      targetRole: "assistant",
      targetStopReason: "toolUse",
      targetAssistantHasToolCalls: true,
      targetAssistantHasVisibleText: false,
      survivingLatestUserTurnOpen: true,
      protocolStatus: "repaired",
      fromOffPath: true,
    });
    expect(result.warnings).toEqual([
      "target_packet_repaired",
      "target_prefix_open_user_turn",
      "target_is_assistant_tool_batch",
      "target_from_off_path",
    ]);
  });

  test("reports a branch summary warning separately from protocol validity", () => {
    const root = user("root");
    const summary = {
      type: "branch_summary",
      id: "summary-1",
      parentId: root.id,
      timestamp: "2026-01-01T00:00:01.000Z",
      fromId: root.id,
      summary: "legacy summary",
    } as SessionEntry;

    const result = buildTravelTargetFacts({
      targetId: summary.id,
      targetEntry: summary,
      targetBranch: [root, summary],
      protocol: protocol("complete"),
      fromOffPath: false,
    });

    expect(result.facts.protocolStatus).toBe("complete");
    expect(result.facts.targetIsBranchSummary).toBe(true);
    expect(result.warnings).toContain("target_is_branch_summary");
  });

  test("retains invalid defects for the mutation gate", () => {
    const root = user("root");
    const result = buildTravelTargetFacts({
      targetId: root.id,
      targetEntry: root,
      targetBranch: [root],
      protocol: protocol("invalid"),
      fromOffPath: false,
    });

    expect(result.facts.protocolStatus).toBe("invalid");
    expect(result.facts.protocolDefects).toEqual([
      { kind: "duplicate_tool_call_id", assistantIndex: 0, toolCallId: "duplicate" },
    ]);
  });
});
