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
        receipt: {
          version: 1,
          toolCallId: TOOL_CALL_ID,
          tool: "acm_travel",
          outcome: "failure",
          mutationState: "not_applied",
          workingSetState: "unchanged",
        },
      });
      expect((result.content[0] as { text: string }).text).toContain("alone in its assistant tool batch");
      expect(sessionManager.getLeafId()).toBe(leafId);
      expect(sessionManager.getEntries()).toEqual(entriesBefore);
      expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
      expect(sessionManager.getEntries().some((entry) => entry.type === "label")).toBe(false);
      },
    );
  }
});

describe("successful travel synchronizes a capability-compatible live AgentSession", () => {
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
      receipt: {
        version: 1,
        toolCallId: TOOL_CALL_ID,
        tool: "acm_travel",
        outcome: "success",
        mutationState: "applied",
        workingSetState: "replaced",
      },
    });
    expect((result.content[0] as { text: string }).text).toContain("summaryDepth=0 → 1 (delta=+1)");
    expect((result.content.at(-1) as { text: string }).text).toStartWith("ACM_RECEIPT ");
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
    expect(timeline.details).toMatchObject({
      receipt: {
        toolCallId: "timeline",
        tool: "acm_timeline",
        outcome: "success",
        mutationState: "not_applicable",
        workingSetState: "unchanged",
      },
    });
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
