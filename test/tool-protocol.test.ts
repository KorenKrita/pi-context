import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { analyzeToolProtocol, hasOpenUserTurnAtAssistant } from "../src/tool-protocol";

describe("LLM tool protocol analysis", () => {
  test("detects a structurally open user turn at the travel tool batch", () => {
    const user = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "give me the official retry answer", timestamp: 1 },
    } as SessionEntry;
    const toolOnly = {
      type: "message",
      id: "assistant-tool",
      parentId: user.id,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "travel-1", name: "acm_travel", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 2,
      },
    } as SessionEntry;
    const answered = {
      ...toolOnly,
      id: "assistant-answered",
      message: {
        ...toolOnly.message,
        content: [
          { type: "text", text: "The official answer is five retries." },
          { type: "toolCall", id: "travel-2", name: "acm_travel", arguments: {} },
        ],
      },
    } as SessionEntry;

    expect(hasOpenUserTurnAtAssistant([user, toolOnly], 1)).toBe(true);
    expect(hasOpenUserTurnAtAssistant([user, answered], 1)).toBe(false);
  });

  test("reports synthesized results while repairing an interrupted tool call", () => {
    const messages = [{
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "read-missing", name: "read", arguments: {} }],
      stopReason: "toolUse" as const,
      timestamp: 1,
    }] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.repairs).toEqual([{
      kind: "synthesized_missing_result",
      toolCallId: "read-missing",
      toolName: "read",
    }]);
    expect(analysis.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "read-missing",
      toolName: "read",
      isError: true,
    });
  });

  test("reports duplicate removal and result reordering", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "call-a", name: "read", arguments: {} },
          { type: "toolCall" as const, id: "call-b", name: "read", arguments: {} },
        ],
        stopReason: "toolUse" as const,
        timestamp: 1,
      },
      { role: "toolResult" as const, toolCallId: "call-b", toolName: "read", content: [], timestamp: 2 },
      { role: "toolResult" as const, toolCallId: "call-a", toolName: "read", content: [], timestamp: 3 },
      { role: "toolResult" as const, toolCallId: "call-a", toolName: "read", content: [], timestamp: 4 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.messages.slice(1).map((message) => (
      message.role === "toolResult" ? message.toolCallId : message.role
    ))).toEqual(["call-a", "call-b"]);
    expect(analysis.repairs).toContainEqual({
      kind: "removed_duplicate_result",
      toolCallId: "call-a",
      toolName: "read",
    });
    expect(analysis.repairs).toContainEqual({
      kind: "reordered_results",
      assistantIndex: 0,
      before: ["call-b", "call-a"],
      after: ["call-a", "call-b"],
    });
  });

  test("marks duplicate tool-call ids as invalid instead of reusing one result", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "duplicate", name: "read", arguments: { path: "a" } },
          { type: "toolCall" as const, id: "duplicate", name: "read", arguments: { path: "b" } },
        ],
        stopReason: "toolUse" as const,
        timestamp: 1,
      },
      { role: "toolResult" as const, toolCallId: "duplicate", toolName: "read", content: [], timestamp: 2 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("invalid");
    expect(analysis.defects).toEqual([{
      kind: "duplicate_tool_call_id",
      assistantIndex: 0,
      toolCallId: "duplicate",
    }]);
    expect(analysis.messages).toEqual(messages);
  });

  test("marks empty tool-call identity fields as invalid", () => {
    const messages = [{
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "", name: "", arguments: {} }],
      stopReason: "toolUse" as const,
      timestamp: 1,
    }] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("invalid");
    expect(analysis.defects).toEqual([
      { kind: "invalid_tool_call_id", assistantIndex: 0, contentIndex: 0 },
      { kind: "invalid_tool_name", assistantIndex: 0, contentIndex: 0 },
    ]);
  });

  test("ignores malformed aborted tool calls but removes their orphaned result", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "aborted-call", name: "", arguments: {} },
          { type: "toolCall" as const, id: "aborted-call", name: "", arguments: {} },
        ],
        stopReason: "aborted" as const,
        timestamp: 1,
      },
      {
        role: "toolResult" as const,
        toolCallId: "aborted-call",
        toolName: "read",
        content: [],
        timestamp: 2,
      },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("repaired");
    expect(analysis.defects).toEqual([]);
    expect(analysis.repairs).toEqual([{
      kind: "removed_orphan_result",
      toolCallId: "aborted-call",
      toolName: "read",
    }]);
    expect(analysis.messages).toEqual([messages[0]]);
  });
});
