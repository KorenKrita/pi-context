import { afterEach, describe, expect, test } from "bun:test";
import {
  estimateTokens,
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
} from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  shouldCompact,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "./.acm-build/index.js";

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const originalGetContextUsage = AgentSession.prototype.getContextUsage;
const TOOL_CALL_ID = "travel-live-sync";
const HANDOFF = [
  "Goal: exercise live travel synchronization",
  "State: travel completed",
  "Evidence: capability host fixture",
  "External: none",
  "Exclusions: none",
  "Recover: live-sync-done",
  "NEXT: continue from the traveled branch",
].join("\n");

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
});

function travelToolCall(): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: TOOL_CALL_ID,
      name: "acm_travel",
      arguments: { target: "root", summary: HANDOFF },
    }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function mixedTravelToolCall(travelFirst: boolean): AssistantMessage {
  const base = travelToolCall();
  const travelCall = base.content[0];
  if (!travelCall) throw new Error("travel tool call fixture is empty");
  const siblingCall = {
    type: "toolCall" as const,
    id: "sibling-read",
    name: "read",
    arguments: { path: "README.md" },
  };
  return {
    ...base,
    content: travelFirst ? [travelCall, siblingCall] : [siblingCall, travelCall],
  };
}

function hasToolCall(messages: readonly AgentMessage[], toolCallId: string): boolean {
  return messages.some((message) => message.role === "assistant" && Array.isArray(message.content) &&
    message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
}

function createExtensionFixture(sessionManager: SessionManager) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let travelTool: ToolDefinition | undefined;
  let timelineTool: ToolDefinition | undefined;
  const api = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "acm_travel") travelTool = tool;
      if (tool.name === "acm_timeline") timelineTool = tool;
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  registerAcmExtension(api);
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  if (!travelTool || !timelineTool) throw new Error("ACM tools were not registered");
  return { context, handlers, timelineTool, travelTool };
}

async function emit(handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>, type: string, event: object, context: ExtensionContext) {
  let result: unknown;
  for (const handler of handlers.get(type) ?? []) result = await handler({ type, ...event }, context);
  return result;
}

describe("travel batch safety", () => {
  for (const travelFirst of [true, false]) {
    test(
      `rejects a real-host mixed assistant tool batch before mutation when travel is ${travelFirst ? "first" : "after a sibling result"}`,
      async () => {
      const sessionManager = SessionManager.inMemory();
      const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
      const assistantId = sessionManager.appendMessage(mixedTravelToolCall(travelFirst));
      const leafId = travelFirst
        ? assistantId
        : sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "sibling-read",
          toolName: "read",
          content: [{ type: "text", text: "sibling completed" }],
          isError: false,
          timestamp: Date.now(),
        });
      const entriesBefore = sessionManager.getEntries();
      const { context, travelTool } = createExtensionFixture(sessionManager);

      const result = await travelTool.execute(
        TOOL_CALL_ID,
        { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "must-not-be-created" },
        undefined,
        undefined,
        context,
      );

      expect(result.details).toMatchObject({
        error: "mixed_tool_batch",
        toolCallId: TOOL_CALL_ID,
        toolCallCount: 2,
      });
      expect((result.content[0] as { text: string }).text).toContain("alone in its assistant tool batch");
      expect(sessionManager.getLeafId()).toBe(leafId);
      expect(sessionManager.getEntries()).toEqual(entriesBefore);
      expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
      expect(sessionManager.getEntries().some((entry) => entry.type === "label")).toBe(false);
      },
    );
  }

  test("counts malformed sibling tool-call blocks when rejecting a mixed batch", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const base = travelToolCall();
    const travelCall = base.content[0];
    if (!travelCall) throw new Error("travel tool call fixture is empty");
    const assistantId = sessionManager.appendMessage({
      ...base,
      content: [
        travelCall,
        { type: "toolCall", id: "malformed-sibling", name: "", arguments: {} },
      ],
    });
    const entriesBefore = sessionManager.getEntries();
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      error: "mixed_tool_batch",
      toolCallCount: 2,
    });
    expect(sessionManager.getLeafId()).toBe(assistantId);
    expect(sessionManager.getEntries()).toEqual(entriesBefore);
  });
});

describe("successful travel synchronizes a capability-compatible live AgentSession", () => {
  test("rejects a raw backup whose immediate pre-travel packet needs protocol repair", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "inspect the parser", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "unfinished-read", name: "read", arguments: { path: "src/parser.ts" } }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const travelCallId = sessionManager.appendMessage(travelToolCall());
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "unsafe-raw" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      error: "backup_protocol_incomplete",
      repairs: [expect.objectContaining({
        kind: "synthesized_missing_result",
        toolCallId: "unfinished-read",
      })],
    });
    expect(sessionManager.getLeafId()).toBe(travelCallId);
    expect(sessionManager.getEntries().some((entry) => entry.type === "label" && entry.label === "unsafe-raw")).toBe(false);
    expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
  });

  test("rejects a raw backup with duplicate tool-call ids", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "inspect two files", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "duplicate-read", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "duplicate-read", name: "read", arguments: { path: "b.ts" } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "duplicate-read",
      toolName: "read",
      content: [{ type: "text", text: "ambiguous result" }],
      isError: false,
      timestamp: Date.now(),
    });
    const travelCallId = sessionManager.appendMessage(travelToolCall());
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "invalid-raw" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      error: "backup_protocol_invalid",
      defects: [expect.objectContaining({
        kind: "duplicate_tool_call_id",
        toolCallId: "duplicate-read",
      })],
    });
    expect(sessionManager.getLeafId()).toBe(travelCallId);
    expect(sessionManager.getEntries().some((entry) => entry.type === "label" && entry.label === "invalid-raw")).toBe(false);
    expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
  });

  test("places the raw backup on the immediate completed tool result", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "inspect the parser", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "read-before-travel", name: "read", arguments: { path: "src/parser.ts" } }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const toolResultId = sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "read-before-travel",
      toolName: "read",
      content: [{ type: "text", text: "parser source" }],
      isError: false,
      timestamp: Date.now(),
    });
    sessionManager.appendMessage(travelToolCall());
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "raw-after-read" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      backupEntryId: toolResultId,
      backupOutcome: "created",
    });
    expect(sessionManager.getEntries()).toContainEqual(expect.objectContaining({
      type: "label",
      targetId: toolResultId,
      label: "raw-after-read",
    }));
  });

  test("preserves a model-change leaf as the raw backup anchor", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "switch model then travel", timestamp: Date.now() });
    const modelChangeId = sessionManager.appendModelChange("test-provider", "test-model-2");
    sessionManager.appendMessage(travelToolCall());
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "raw-after-model-change" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      backupEntryId: modelChangeId,
      backupOutcome: "created",
    });
    expect(sessionManager.getEntries()).toContainEqual(expect.objectContaining({
      type: "label",
      targetId: modelChangeId,
      label: "raw-after-model-change",
    }));
  });

  test("uses the compaction-projected packet instead of historical protocol defects", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "old task", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "historical-orphan",
      toolName: "read",
      content: [{ type: "text", text: "orphaned historical output" }],
      isError: false,
      timestamp: Date.now(),
    });
    const keptUserId = sessionManager.appendMessage({ role: "user", content: "authoritative current task", timestamp: Date.now() });
    const compactionId = sessionManager.appendCompaction(
      "Current task is authoritative; historical orphan is excluded.",
      keptUserId,
      10_000,
    );
    sessionManager.appendMessage(travelToolCall());
    const { context, travelTool } = createExtensionFixture(sessionManager);

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "raw-after-compaction" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      backupEntryId: compactionId,
      backupOutcome: "created",
    });
  });

  test("applies only after the matching tool_execution_end and preserves tree recovery", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "old branch root", timestamp: Date.now() });
    const abandonedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "abandoned branch payload".repeat(20_000) }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage(travelToolCall());
    const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
    const contextWindow = 100_000;
    const compactionSettings = { enabled: true, reserveTokens: 90_000, keepRecentTokens: 1_000 };
    const storedTokensBefore = staleMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(shouldCompact(storedTokensBefore, contextWindow, compactionSettings)).toBe(true);

    AgentSession.prototype.getContextUsage = function () {
      return { tokens: storedTokensBefore, contextWindow, percent: (storedTokensBefore / contextWindow) * 100 };
    };
    const { context, handlers, timelineTool, travelTool } = createExtensionFixture(sessionManager);
    const liveSession = Object.create(AgentSession.prototype) as AgentSession & {
      sessionManager: SessionManager;
      agent: { state: { messages: AgentMessage[] } };
    };
    Object.defineProperties(liveSession, {
      sessionManager: { value: sessionManager },
      agent: { value: { state: { messages: staleMessages } } },
    });
    liveSession.getContextUsage();

    const result = await travelTool.execute(
      TOOL_CALL_ID,
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "live-sync-done" },
      undefined,
      undefined,
      context,
    );
    expect(result.details).toMatchObject({
      contextRefreshState: "pending",
      liveAgentSessionSyncState: "pending",
      activeSummaryDepthBefore: 0,
      activeSummaryDepthAfter: 1,
      activeSummaryDepthDelta: 1,
    });
    expect((result.content[0] as { text: string }).text).toContain("summaryDepth=0 → 1 (delta=+1)");
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(handlers, "tool_execution_end", { toolCallId: "unrelated", toolName: "acm_travel" }, context);
    expect(liveSession.agent.state.messages).toBe(staleMessages);
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: TOOL_CALL_ID,
      toolName: "acm_travel",
      content: [{ type: "text", text: "Travel complete" }],
      isError: false,
      timestamp: Date.now(),
    };
    const inFlightContext = [...staleMessages, toolResult];
    expect(hasToolCall(inFlightContext, TOOL_CALL_ID)).toBe(true);
    expect(inFlightContext.some((message) => message.role === "toolResult" && message.toolCallId === TOOL_CALL_ID)).toBe(true);

    await emit(handlers, "tool_execution_end", { toolCallId: TOOL_CALL_ID, toolName: "acm_travel" }, context);

    const rebuilt = sessionManager.buildSessionContext().messages as AgentMessage[];
    expect(liveSession.agent.state.messages).toEqual(rebuilt);
    expect(JSON.stringify(rebuilt)).not.toContain("abandoned branch payload");
    expect(hasToolCall(rebuilt, TOOL_CALL_ID)).toBe(false);
    const storedTokensAfter = rebuilt.reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(storedTokensAfter).toBeLessThan(storedTokensBefore);
    expect(shouldCompact(storedTokensAfter, contextWindow, compactionSettings)).toBe(false);
    expect(sessionManager.getEntry(abandonedId)).toBeDefined();
    expect(sessionManager.getEntries().some((entry) => entry.type === "label" && entry.label === "live-sync-done")).toBe(true);
    expect(sessionManager.getEntries().some(
      (entry) => entry.type === "label" && entry.label?.startsWith("pre-compact-"),
    )).toBe(false);

    const contextResult = await emit(handlers, "context", { messages: staleMessages }, context) as { messages?: AgentMessage[] };
    expect(contextResult.messages).toEqual(rebuilt);
    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    expect(timeline.content[0]).toMatchObject({ type: "text" });
    expect((timeline.content[0] as { text: string }).text).toContain("Live Agent Sync:  applied");
    expect((timeline.content[0] as { text: string }).text).toContain("1 active handoff summary layer(s) on the current spine");
    expect((timeline.content[0] as { text: string }).text).not.toContain("normalized rebase");

    const rebaseResult = await travelTool.execute(
      "root-rebase",
      { target: rootId, summary: HANDOFF },
      undefined,
      undefined,
      context,
    );
    expect(rebaseResult.details).toMatchObject({
      activeSummaryDepthBefore: 1,
      activeSummaryDepthAfter: 1,
      activeSummaryDepthDelta: 0,
      targetSummaryDepth: 0,
    });
    expect((rebaseResult.content[0] as { text: string }).text).toContain("summaryDepth=1 → 1 (delta=0)");
    expect((rebaseResult.content[0] as { text: string }).text).toContain("Root rebase replaced prior active handoff layers with one new handoff; resulting summary depth is 1 rather than 0.");

    const nonRootResult = await travelTool.execute(
      "non-root-fold",
      { target: abandonedId, summary: HANDOFF },
      undefined,
      undefined,
      context,
    );
    expect(nonRootResult.details).toMatchObject({ targetIsStructuralRoot: false });
    expect((nonRootResult.content[0] as { text: string }).text).not.toContain("Root rebase");
  });
});
