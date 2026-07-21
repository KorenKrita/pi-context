import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fixOrphanedToolUse } from "./.acm-build/tool-protocol.js";

describe("message sanitation", () => {
  test("orders preserved and synthesized tool results by assistant tool-call order", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "call-a", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall" as const, id: "call-b", name: "read", arguments: { path: "b.ts" } },
          { type: "toolCall" as const, id: "call-c", name: "read", arguments: { path: "c.ts" } },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
        stopReason: "toolUse" as const,
        timestamp: Date.now(),
      },
      {
        role: "toolResult" as const,
        toolCallId: "call-b",
        toolName: "read",
        content: [{ type: "text" as const, text: "real b result" }],
        isError: false,
        timestamp: Date.now(),
      },
    ] satisfies AgentMessage[];

    const repaired = fixOrphanedToolUse(messages);
    const toolResultIds = repaired
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId);

    expect(toolResultIds).toEqual(["call-a", "call-b", "call-c"]);
    expect(repaired[2]).toBe(messages[1]);
  });
});
