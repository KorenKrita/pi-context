import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { analyzeToolProtocol, formatToolProtocolDefects, hasOpenUserTurnAtAssistant } from "../src/tool-protocol";
function unpairedToolCallIds(messages: readonly AgentMessage[]): string[] {
  // Batch-local oracle, matching the analysis under test: a call counts as
  // paired only when a result for its id sits in the contiguous toolResult
  // run immediately after its own assistant batch. A whole-array id set
  // would repeat the very bug these tests guard against.
  const unpaired: string[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const batchResultIds = new Set<string>();
    for (let following = index + 1; following < messages.length; following++) {
      const next = messages[following]!;
      if (next.role !== "toolResult") break;
      if (next.toolCallId) batchResultIds.add(next.toolCallId);
    }
    for (const block of message.content) {
      if (block.type === "toolCall" && !batchResultIds.has(block.id)) unpaired.push(block.id);
    }
  }
  return unpaired;
}


describe("LLM tool protocol analysis", () => {
  test("formats every protocol defect variant consistently", () => {
    expect(formatToolProtocolDefects([
      { kind: "invalid_tool_call_id", assistantIndex: 1, contentIndex: 2 },
      { kind: "invalid_tool_name", assistantIndex: 3, contentIndex: 4, toolCallId: "call-4" },
      { kind: "duplicate_tool_call_id", assistantIndex: 5, toolCallId: "duplicate" },
    ])).toBe(
      "invalid_tool_call_id at assistant 1, content 2; "
      + "invalid_tool_name at assistant 3, content 4 (call-4); "
      + "duplicate_tool_call_id at assistant 5 (duplicate)",
    );
  });

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

  test("strips an aborted assistant's unpaired tool call when removing its orphaned result", () => {
    const messages = [
      { role: "user" as const, content: "start", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tc1", name: "read", arguments: {} }],
        stopReason: "aborted" as const,
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "read",
        content: [],
        timestamp: 3,
      },
      { role: "user" as const, content: "continue", timestamp: 4 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("repaired");
    expect(unpairedToolCallIds(analysis.messages)).toEqual([]);
    expect(analysis.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(analysis.repairs).toContainEqual({
      kind: "stripped_unpaired_tool_call",
      toolCallId: "tc1",
      toolName: "read",
    });
  });

  test("leaves no dangling tool calls across healthy, aborted, and duplicate-result batches", () => {
    const messages = [
      { role: "user" as const, content: "start", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "healthy", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 2,
      },
      { role: "toolResult" as const, toolCallId: "healthy", toolName: "read", content: [], timestamp: 3 },
      { role: "toolResult" as const, toolCallId: "healthy", toolName: "read", content: [], timestamp: 4 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "aborted", name: "bash", arguments: {} }],
        stopReason: "aborted" as const,
        timestamp: 5,
      },
      { role: "toolResult" as const, toolCallId: "aborted", toolName: "bash", content: [], timestamp: 6 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(unpairedToolCallIds(analysis.messages)).toEqual([]);
    expect(analysis.repairs).toContainEqual({
      kind: "removed_duplicate_result",
      toolCallId: "healthy",
      toolName: "read",
    });
    expect(analysis.repairs).toContainEqual({
      kind: "stripped_unpaired_tool_call",
      toolCallId: "aborted",
      toolName: "bash",
    });
  });
  test("strips an aborted call whose id a later healthy batch reuses", () => {
    // Cross-batch toolCallId reuse: the later batch's lawful result must
    // pair with ITS call only. A whole-array id set would mistake the
    // aborted call for paired and hand the provider a duplicate tool call.
    const messages = [
      { role: "user" as const, content: "start", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "reused", name: "read", arguments: {} }],
        stopReason: "aborted" as const,
        timestamp: 2,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "reused", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 3,
      },
      { role: "toolResult" as const, toolCallId: "reused", toolName: "read", content: [], timestamp: 4 },
      { role: "user" as const, content: "done", timestamp: 5 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("repaired");
    expect(analysis.repairs).toContainEqual({
      kind: "stripped_unpaired_tool_call",
      toolCallId: "reused",
      toolName: "read",
    });
    // Exactly one assistant survives — the healthy batch — and its result
    // stays attached to it.
    const assistants = analysis.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { stopReason?: string }).stopReason).toBe("toolUse");
    expect(unpairedToolCallIds(analysis.messages)).toEqual([]);
    const resultIndex = analysis.messages.findIndex((message) => message.role === "toolResult");
    expect(analysis.messages[resultIndex - 1]?.role).toBe("assistant");
  });

  test("an aborted batch keeps its text but loses reused and unpaired calls alike", () => {
    // With text content the aborted assistant survives the strip; both its
    // calls (one reusing the later batch's id, one with no result anywhere)
    // must still go, and the oracle judges pairing batch-locally.
    const messages = [
      { role: "user" as const, content: "start", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "partial note" },
          { type: "toolCall" as const, id: "reused", name: "read", arguments: {} },
          { type: "toolCall" as const, id: "orphaned", name: "bash", arguments: {} },
        ],
        stopReason: "aborted" as const,
        timestamp: 2,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "reused", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 3,
      },
      { role: "toolResult" as const, toolCallId: "reused", toolName: "read", content: [], timestamp: 4 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("repaired");
    const stripped = analysis.repairs.filter((repair) => repair.kind === "stripped_unpaired_tool_call");
    expect(stripped).toContainEqual({ kind: "stripped_unpaired_tool_call", toolCallId: "reused", toolName: "read" });
    expect(stripped).toContainEqual({ kind: "stripped_unpaired_tool_call", toolCallId: "orphaned", toolName: "bash" });
    const assistants = analysis.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(2);
    const aborted = assistants[0] as { stopReason?: string; content: Array<{ type: string }> };
    expect(aborted.stopReason).toBe("aborted");
    expect(aborted.content.map((block) => block.type)).toEqual(["text"]);
    expect(unpairedToolCallIds(analysis.messages)).toEqual([]);
  });
  test("a result separated from its batch by a user message orphans and triggers synthesis, not silent pairing", () => {
    // Fixed fixture with direct packet assertions — no pairing oracle reuse.
    // The boundary under test: the toolResult's owning-batch lookup must stop
    // at the first non-toolResult message, so the interposed user message
    // turns the result into an orphan and the healthy batch's call gets a
    // synthesized result instead of silently pairing across the gap.
    const messages = [
      { role: "user" as const, content: "start", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "separated", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 2,
      },
      { role: "user" as const, content: "interposed", timestamp: 3 },
      { role: "toolResult" as const, toolCallId: "separated", toolName: "read", content: [], timestamp: 4 },
      { role: "user" as const, content: "end", timestamp: 5 },
    ] as AgentMessage[];

    const analysis = analyzeToolProtocol(messages);

    expect(analysis.status).toBe("repaired");
    expect(analysis.repairs).toContainEqual({
      kind: "removed_orphan_result",
      toolCallId: "separated",
      toolName: "read",
    });
    expect(analysis.repairs).toContainEqual({
      kind: "synthesized_missing_result",
      toolCallId: "separated",
      toolName: "read",
    });
    // The packet keeps exactly one user, one assistant, one (synthesized)
    // result, and the trailing user — in that order; the original result is
    // gone and the pair sits adjacent.
    expect(analysis.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "toolResult", "user", "user",
    ]);
    const pair = analysis.messages[2] as unknown as { toolCallId?: string; isError?: boolean };
    expect(pair.toolCallId).toBe("separated");
    expect(pair.isError).toBe(true);
  });

});
