import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage, ToolResultMessage } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "./.acm-build/index.js";
import { rebuildAcmContextPacket } from "./.acm-build/context-packet.js";
import { analyzeToolProtocol } from "./.acm-build/tool-protocol.js";

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const originalGetContextUsage = AgentSession.prototype.getContextUsage;
const HANDOFF = {
  goal: "exercise deferred post-travel refresh",
  state: "the persisted branch contains the new handoff",
  evidence: "exact Pi host fixture",
  external: "none",
  exclusions: "the originating run's live message sequence",
  recover: "deferred-refresh-save-point",
  next: "continue with the current task",
};

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
});

function rebuild(sessionManager: SessionManager): AgentMessage[] {
  const result = rebuildAcmContextPacket(sessionManager);
  if (!result.ok) throw new Error(result.message);
  return result.value.messages;
}

function createFixture(
  sessionManager: SessionManager,
  options: {
    readonly beforeAcmRegistration?: (api: ExtensionAPI) => void;
    readonly isIdle?: () => boolean;
    readonly getContextUsage?: () => { tokens: number; contextWindow: number; percent: number };
  } = {},
) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  let travelTool: ToolDefinition | undefined;
  let timelineTool: ToolDefinition | undefined;
  const api = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "acm_travel") travelTool = tool;
      if (tool.name === "acm_timeline") timelineTool = tool;
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
      sessionManager.appendCustomEntry(customType, data);
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      sentMessages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;
  // Extensions are invoked in registration order.  Allow this fixture to
  // model a preceding extension that synchronously starts the next run while
  // Pi is dispatching agent_settled.
  options.beforeAcmRegistration?.(api);
  registerAcmExtension(api);
  const context = {
    sessionManager,
    isIdle: options.isIdle ?? (() => true),
    getContextUsage: options.getContextUsage ?? (() => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 })),
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  if (!travelTool || !timelineTool) throw new Error("ACM tools were not registered");
  return { appendedEntries, context, handlers, sentMessages, timelineTool, travelTool };
}

async function emit(
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>,
  type: string,
  event: object,
  context: ExtensionContext,
) {
  let result: unknown;
  for (const handler of handlers.get(type) ?? []) result = await handler({ type, ...event }, context);
  return result;
}

function createBranch(scope: string) {
  const sessionManager = SessionManager.inMemory();
  const rootId = sessionManager.appendMessage({ role: "user", content: `${scope} root`, timestamp: Date.now() });
  sessionManager.appendMessage({ role: "user", content: `${scope} material to fold`, timestamp: Date.now() });
  return { rootId, sessionManager };
}

function captureLiveSession(sessionManager: SessionManager, messages: AgentMessage[]) {
  const liveSession = Object.create(AgentSession.prototype) as AgentSession & {
    sessionManager: SessionManager;
    agent: { state: { messages: AgentMessage[] } };
  };
  Object.defineProperties(liveSession, {
    sessionManager: { value: sessionManager },
    agent: { value: { state: { messages } } },
  });
  liveSession.getContextUsage();
  return liveSession;
}

function completedTravelResult(toolCallId: string, details?: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "acm_travel",
    content: [{ type: "text", text: "Travel complete" }],
    ...(details === undefined ? {} : { details }),
    isError: false,
    timestamp: Date.now(),
  };
}

function pendingTravelCall(toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: "acm_travel",
      arguments: { target: "root", handoff: HANDOFF },
    }],
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

describe("deferred post-travel delivery on exact Pi host", () => {
  test("cuts the provider to the newest trusted packet immediately after the persisted receipt while native messages remain in-flight", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 133_000, contextWindow: 204_000, percent: 65.2 };
    };
    // This session-like fixture models the 204K -> 133K cutover shape without
    // asking the host fixture to allocate the full production transcript.
    const branch = createBranch("204K-to-133K");
    branch.sessionManager.appendMessage(pendingTravelCall("provider-now"));
    const staleMessages = [
      ...(branch.sessionManager.buildSessionContext().messages as AgentMessage[]),
      completedTravelResult("provider-now"),
    ];
    const fixture = createFixture(branch.sessionManager);
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    const receipt = await fixture.travelTool.execute(
      "provider-now",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(receipt.details).toMatchObject({
      mutationStatus: "applied",
      providerDeliveryPhase: "pending_tool_result",
      providerPacketMessageCount: null,
      nativeContextReplacement: { status: "pending" },
    });
    const finalReceiptMessage = staleMessages.at(-1);
    if (finalReceiptMessage?.role !== "toolResult") throw new Error("missing final travel result fixture");
    finalReceiptMessage.details = receipt.details;

    // This later user turn must remain higher priority than the continuation.
    branch.sessionManager.appendMessage({
      role: "user",
      content: "later user priority after the fold",
      timestamp: Date.now(),
    });
    await emit(fixture.handlers, "tool_result", {
      toolName: "acm_travel",
      toolCallId: "provider-now",
      isError: false,
      input: { handoff: HANDOFF },
      details: {
        handoffFormat: "structured-v1",
        resultingLeafId: branch.sessionManager.getLeafId(),
        currentUserTurnOpen: true,
      },
    }, fixture.context);

    const firstProvider = await emit(
      fixture.handlers,
      "context",
      { messages: staleMessages },
      fixture.context,
    ) as { messages: AgentMessage[] };
    const firstSerialized = JSON.stringify(firstProvider.messages);
    expect(firstSerialized).toContain("HIGHEST-PRIORITY SESSION STATE");
    expect(firstSerialized).toContain("CURRENT USER TURN IS STILL OPEN");
    expect(firstSerialized).toContain("later user priority after the fold");
    expect(firstSerialized).not.toContain("204K-to-133K material to fold");
    expect(firstProvider.messages.some((message) => message.role === "toolResult" && message.toolCallId === "provider-now")).toBe(false);
    expect(firstProvider.messages.filter((message) => message.role === "custom" && message.customType === "acm:continuation")).toHaveLength(1);
    expect(fixture.sentMessages).toEqual([]);
    expect(analyzeToolProtocol(firstProvider.messages).status).toBe("complete");
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    const afterFirst = await fixture.timelineTool.execute("provider-now-first", { view: "active" }, undefined, undefined, fixture.context);
    expect(afterFirst.details).toMatchObject({
      contextDeliveryPhase: "provider_active_native_pending",
      providerDeliveryPhase: "active",
      providerPacketMessageCount: firstProvider.messages.length,
      nativeContextReplacement: { status: "pending" },
    });

    // A new persisted tool pair after provider cutover must be picked up by
    // the next provider context without waiting for native settlement.
    branch.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "post-cutover-read", name: "read", arguments: { path: "fresh.md" } }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    branch.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "post-cutover-read",
      toolName: "read",
      content: [{ type: "text", text: "post-travel tool work" }],
      isError: false,
      timestamp: Date.now(),
    });
    const secondProvider = await emit(
      fixture.handlers,
      "context",
      { messages: staleMessages },
      fixture.context,
    ) as { messages: AgentMessage[] };
    expect(JSON.stringify(secondProvider.messages)).toContain("post-travel tool work");
    expect(analyzeToolProtocol(secondProvider.messages).status).toBe("complete");
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    // A provider-active turn establishes the post-travel baseline before the
    // native replacement arrives.
    await emit(fixture.handlers, "turn_end", {
      message: { role: "assistant", usage: { input: 133_000, cacheRead: 0, cacheWrite: 0 } },
    }, fixture.context);
    expect(fixture.appendedEntries).toContainEqual({
      customType: "acm:context-usage-state",
      data: expect.objectContaining({ kind: "context-usage-baseline", tokens: 133_000 }),
    });

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(rebuild(branch.sessionManager));
    expect(JSON.stringify(liveSession.agent.state.messages)).toContain("post-travel tool work");
  });

  test("ignores stale 70% native usage while provider is active and native replacement is pending", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 70_000, contextWindow: 100_000, percent: 70 };
    };
    const branch = createBranch("native-usage-estimate");
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    const fixture = createFixture(branch.sessionManager, {
      getContextUsage: () => ({ tokens: 70_000, contextWindow: 100_000, percent: 70 }),
    });
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);
    const receipt = await fixture.travelTool.execute(
      "native-usage-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    const finalResult = {
      role: "toolResult" as const,
      toolCallId: "native-usage-travel",
      toolName: "acm_travel",
      content: receipt.content,
      details: receipt.details,
      isError: false,
      timestamp: Date.now(),
    };

    await emit(fixture.handlers, "context", { messages: [...staleMessages, finalResult] }, fixture.context);
    await emit(fixture.handlers, "context", { messages: [...staleMessages, finalResult] }, fixture.context);
    await emit(fixture.handlers, "tool_result", {
      toolName: "read",
      toolCallId: "read-after-provider-cutover",
      content: [],
      isError: false,
    }, fixture.context);

    expect(fixture.sentMessages).toEqual([]);
    expect(liveSession.agent.state.messages).toBe(staleMessages);
    const timeline = await fixture.timelineTool.execute(
      "native-usage-timeline",
      { view: "active" },
      undefined,
      undefined,
      fixture.context,
    );
    expect((timeline.content[0] as { text: string }).text).toContain("native AgentSession estimate");
    expect((timeline.content[0] as { text: string }).text).toContain("ACM Pressure:     N/A (provider actual)");
    expect(timeline.details).toMatchObject({
      contextUsageAuthority: "provider_pending",
      authoritativeContextPressure: null,
      contextDeliveryPhase: "provider_active_native_pending",
      nativeContextReplacement: { status: "pending" },
    });
  });

  test("does not let origin-run turn usage consume the seeded travel baseline", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("origin-turn-usage");
    const fixture = createFixture(branch.sessionManager);
    captureLiveSession(branch.sessionManager, branch.sessionManager.buildSessionContext().messages as AgentMessage[]);

    const receipt = await fixture.travelTool.execute(
      "origin-turn-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    await emit(fixture.handlers, "turn_end", {
      message: {
        role: "assistant",
        usage: { input: 70_000, cacheRead: 0, cacheWrite: 0 },
      },
    }, fixture.context);
    expect(fixture.appendedEntries).toEqual([]);

    await emit(fixture.handlers, "context", {
      messages: [completedTravelResult("origin-turn-travel", receipt.details)],
    }, fixture.context);
    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    await emit(fixture.handlers, "turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    }, fixture.context);

    expect(fixture.appendedEntries).toContainEqual({
      customType: "acm:context-usage-state",
      data: expect.objectContaining({ kind: "context-usage-baseline", tokens: 20_000 }),
    });
  });

  test("repairs a branchWithSummary orphan in the outgoing same-run packet without settling", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("orphaned-same-run");
    const fixture = createFixture(branch.sessionManager);

    await fixture.travelTool.execute(
      "current-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    // Exact Pi's SessionManager keeps a historical result on the new summary
    // branch even though its call was folded away. The current travel call has
    // not received its finalized result yet.
    branch.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "historical-travel",
      toolName: "acm_travel",
      content: [{ type: "text", text: "late persisted historical result" }],
      isError: false,
      timestamp: Date.now(),
    });
    const persistedWithOrphan = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    expect(persistedWithOrphan.some((message) => message.role === "toolResult" && message.toolCallId === "historical-travel")).toBe(true);
    const outgoing = [
      ...persistedWithOrphan,
      pendingTravelCall("current-travel"),
    ];

    const result = await emit(fixture.handlers, "context", { messages: outgoing }, fixture.context) as { messages: AgentMessage[] };

    const callIndex = result.messages.findIndex((message) => message.role === "assistant"
      && message.content.some((part) => part.type === "toolCall" && part.id === "current-travel"));
    const resultIndexes = result.messages.flatMap((message, index) =>
      message.role === "toolResult" && message.toolCallId === "current-travel" ? [index] : []);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndexes).toEqual([callIndex + 1]);
    expect(result.messages[resultIndexes[0]!]).toMatchObject({
      role: "toolResult",
      toolCallId: "current-travel",
      toolName: "acm_travel",
      isError: true,
      content: [{ type: "text", text: "[Interrupted by context travel]" }],
    });
    expect(result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "historical-travel")).toBe(false);
    const timeline = await fixture.timelineTool.execute("same-run-orphan-timeline", { view: "active" }, undefined, undefined, fixture.context);
    expect(timeline.details).toMatchObject({ contextDeliveryPhase: "pending_tool_result" });
  });

  test("preserves same-run messages and tool pair through retry; agent_settled replaces native context and later provider contexts stay current", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("normal");
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    const fixture = createFixture(branch.sessionManager);
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    const result = await fixture.travelTool.execute(
      "normal-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({
      contextRefreshState: "pending_tool_result",
      contextDeliveryPhase: "pending_tool_result",
      // The receipt exposes native capability state as raw data.  Delivery is
      // still deferred even though this exact host has a live association.
      nativeContextReplacementState: "pending",
      nativeContextReplacement: { status: "pending" },
      liveAgentSessionSyncState: "pending",
      liveAgentSessionSync: { status: "pending" },
    });
    const inFlightMessages = [
      ...staleMessages,
      pendingTravelCall("normal-travel"),
    ];

    // Neither an unrelated nor matching tool end may replace messages while the
    // originating run may still continue or retry.
    expect(await emit(fixture.handlers, "tool_execution_end", {
      toolCallId: "unrelated-travel",
      toolName: "acm_travel",
    }, fixture.context)).toBeUndefined();
    expect(await emit(fixture.handlers, "tool_execution_end", {
      toolCallId: "normal-travel",
      toolName: "acm_travel",
    }, fixture.context)).toBeUndefined();
    const pendingProvider = await emit(
      fixture.handlers,
      "context",
      { messages: inFlightMessages },
      fixture.context,
    ) as { messages?: AgentMessage[] };
    expect(JSON.stringify(pendingProvider.messages)).toContain("Interrupted by context travel");
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    // A provider error can auto-retry; it must not be treated as the terminal
    // ownership handoff to a later user run.
    await emit(fixture.handlers, "agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "error" }],
    }, fixture.context);
    const retryPendingProvider = await emit(
      fixture.handlers,
      "context",
      { messages: inFlightMessages },
      fixture.context,
    ) as { messages?: AgentMessage[] };
    expect(JSON.stringify(retryPendingProvider.messages)).toContain("Interrupted by context travel");
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    const finalizedProvider = await emit(fixture.handlers, "context", {
      messages: [completedTravelResult("normal-travel", result.details)],
    }, fixture.context) as { messages?: AgentMessage[] };
    expect(finalizedProvider.messages).toEqual(rebuild(branch.sessionManager));
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    const rebuilt = rebuild(branch.sessionManager);
    expect(liveSession.agent.state.messages).toEqual(rebuilt);
    expect(JSON.stringify(rebuilt)).toContain("HIGHEST-PRIORITY SESSION STATE");
    expect(JSON.stringify(rebuilt)).not.toContain("normal material to fold");

    // Later provider contexts originate from the native message array now held
    // by AgentSession; none may resurrect the pre-travel stale sequence.
    for (let index = 0; index < 2; index++) {
      const later = await emit(
        fixture.handlers,
        "context",
        { messages: liveSession.agent.state.messages },
        fixture.context,
      ) as { messages?: AgentMessage[] } | undefined;
      expect(later?.messages ?? liveSession.agent.state.messages).toEqual(rebuilt);
    }
  });

  test("an aborted run also keeps same-run context until agent_settled", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("aborted");
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    const fixture = createFixture(branch.sessionManager);
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    const receipt = await fixture.travelTool.execute(
      "aborted-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    await emit(fixture.handlers, "agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
    }, fixture.context);
    expect(await emit(fixture.handlers, "context", { messages: staleMessages }, fixture.context)).toBeUndefined();
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(fixture.handlers, "context", {
      messages: [completedTravelResult("aborted-travel", receipt.details)],
    }, fixture.context);
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(rebuild(branch.sessionManager));
  });

  test("a preceding extension that starts another run keeps ACM's settled replacement deferred until Pi is idle again", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("cross-extension-settle");
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    let idle = true;
    let startNextRunAtFirstSettlement = true;
    const fixture = createFixture(branch.sessionManager, {
      isIdle: () => idle,
      beforeAcmRegistration(api) {
        api.on("agent_settled", () => {
          if (!startNextRunAtFirstSettlement) return;
          startNextRunAtFirstSettlement = false;
          // This is the observable contract from Pi's ExtensionContext: a
          // preceding handler schedules a successor run before ACM's handler
          // sees the same agent_settled event.
          idle = false;
        });
      },
    });
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    const result = await fixture.travelTool.execute(
      "cross-extension-travel",
      { target: branch.rootId, handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({ contextDeliveryPhase: "pending_tool_result" });
    await emit(fixture.handlers, "context", {
      messages: [completedTravelResult("cross-extension-travel", result.details)],
    }, fixture.context);

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toBe(staleMessages);
    const beforeIdleTimeline = await fixture.timelineTool.execute(
      "timeline-before-idle",
      { view: "active" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(beforeIdleTimeline.details).toMatchObject({ contextDeliveryPhase: "provider_active_native_pending" });

    // The successor run later settles with no further queued work.  This is
    // the only settled edge allowed to replace native AgentSession messages.
    idle = true;
    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(rebuild(branch.sessionManager));
  });
});
