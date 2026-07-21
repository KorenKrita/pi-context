import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerAcmLifecycle } from "./.acm-build/runtime-lifecycle.js";
import { rebuildAcmContextPacket } from "./.acm-build/context-packet.js";
import { AcmSessionRuntime } from "./.acm-build/runtime.js";
import { registerTimelineTool } from "./.acm-build/timeline-tool.js";
import { registerTravelTool } from "./.acm-build/travel-tool.js";
import {
  createLiveAgentSessionAdapter,
  type AgentSessionHostClass,
  type AgentSessionSyncOutcome,
  type LiveAgentSessionAdapter,
} from "./.acm-build/live-agent-session-adapter.js";

const HANDOFF = {
  goal: "verify deferred synchronization fallback",
  state: "travel completed or failed as asserted",
  evidence: "capability host fixture",
  external: "none",
  exclusions: "no synthetic compaction or tool calls",
  recover: "failure-recovery-checkpoint",
  next: "continue from the persistent active branch",
};

function createSession() {
  const sessionManager = SessionManager.inMemory();
  const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "folded payload" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return { rootId, sessionManager };
}

function registerFixture(sessionManager: SessionManager, runtime: AcmSessionRuntime) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
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
  } as unknown as ExtensionAPI;
  registerTravelTool(api, runtime);
  registerTimelineTool(api, runtime);
  registerAcmLifecycle(api, runtime);
  const notifications: string[] = [];
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  if (!travelTool || !timelineTool) throw new Error("ACM tools were not registered");
  return { context, handlers, notifications, timelineTool, travelTool };
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

function createSpyAdapter(): LiveAgentSessionAdapter & { scheduled: number; applied: number } {
  const initial: AgentSessionSyncOutcome = {
    status: "skipped",
    reason: "not_pending",
    message: "nothing pending",
  };
  let pendingToolCallId: string | undefined;
  return {
    installation: { status: "ready" },
    scheduled: 0,
    applied: 0,
    schedule(_session, toolCallId) {
      this.scheduled++;
      pendingToolCallId = toolCallId;
      return { status: "pending" };
    },
    apply(_session, toolCallId) {
      if (pendingToolCallId !== toolCallId) return initial;
      pendingToolCallId = undefined;
      this.applied++;
      return { status: "applied", leafId: null, messageCount: 0 };
    },
    getStatus() { return initial; },
    clear() { pendingToolCallId = undefined; },
  };
}

function createThrowingHostClass(): AgentSessionHostClass {
  class ThrowingAgentSession {
    constructor(
      readonly sessionManager: SessionManager,
      readonly agent: { state: { messages: AgentMessage[] } },
    ) {}
    getContextUsage() { return undefined; }
  }
  return ThrowingAgentSession as unknown as AgentSessionHostClass;
}

describe("deferred live synchronization fallback", () => {
  test("unavailable native synchronization defers to agent_settled and then uses persistent rebuild", async () => {
    const { rootId, sessionManager } = createSession();
    const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: { prototype: {} } as AgentSessionHostClass });
    const runtime = new AcmSessionRuntime(adapter);
    const { context, handlers, timelineTool, travelTool } = registerFixture(sessionManager, runtime);

    const result = await travelTool.execute("unsupported", { target: rootId, handoff: HANDOFF }, undefined, undefined, context);
    expect(result.details).toMatchObject({
      contextRefreshState: "pending_run_settle",
      contextDeliveryPhase: "pending_run_settle",
    });
    expect(await emit(handlers, "context", { messages: staleMessages }, context)).toBeUndefined();

    await emit(handlers, "agent_settled", {}, context);
    const rebuiltResult = rebuildAcmContextPacket(sessionManager);
    if (!rebuiltResult.ok) throw new Error(rebuiltResult.message);
    const rebuilt = rebuiltResult.value.messages;
    const contextResult = await emit(handlers, "context", { messages: staleMessages }, context) as { messages?: AgentMessage[] };
    expect(contextResult.messages).toEqual(rebuilt);
    expect(JSON.stringify(rebuilt)).not.toContain("folded payload");

    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    const text = (timeline.content[0] as { text: string }).text;
    expect(text).toContain("Context Delivery:");
    expect(text).toContain("unavailable");
  });

  test("replacement failure is observed only at agent_settled and persistent rebuild remains recoverable", async () => {
    const { rootId, sessionManager } = createSession();
    const HostClass = createThrowingHostClass();
    const state = { messages: [] as AgentMessage[] };
    Object.defineProperty(state, "messages", {
      get: () => [],
      set: () => { throw new Error("replacement refused"); },
    });
    const liveSession = new (HostClass as any)(sessionManager, { state });
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    liveSession.getContextUsage();
    const runtime = new AcmSessionRuntime(adapter);
    const { context, handlers, notifications, timelineTool, travelTool } = registerFixture(sessionManager, runtime);

    const result = await travelTool.execute(
      "replacement-failure",
      { target: rootId, handoff: HANDOFF, backupCurrentHeadAs: "replacement-failure-done" },
      undefined,
      undefined,
      context,
    );
    expect(result.details).toMatchObject({
      contextDeliveryPhase: "pending_run_settle",
    });
    await emit(handlers, "tool_execution_end", { toolCallId: "replacement-failure", toolName: "acm_travel" }, context);
    expect(runtime.getLiveAgentSyncStatus(sessionManager)).toMatchObject({ status: "pending" });
    expect(notifications).toEqual([]);

    await emit(handlers, "agent_settled", {}, context);
    expect(runtime.getLiveAgentSyncStatus(sessionManager)).toMatchObject({
      status: "failed",
      reason: "replace_messages_failed",
      message: "replacement refused",
    });
    expect(notifications.at(-1)).toContain("Native context replacement after settled travel failed");
    expect(notifications.at(-1)).toContain("Reload the session");
    const rebuiltResult = rebuildAcmContextPacket(sessionManager);
    if (!rebuiltResult.ok) throw new Error(rebuiltResult.message);
    const contextResult = await emit(handlers, "context", {
      messages: sessionManager.buildSessionContext().messages,
    }, context) as { messages?: AgentMessage[] };
    expect(contextResult.messages).toEqual(rebuiltResult.value.messages);

    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    expect((timeline.content[0] as { text: string }).text).toContain("Context Delivery:");
    expect(timeline.details).toMatchObject({
      contextDeliveryPhase: "active",
      nativeContextReplacement: { status: "failed", reason: "replace_messages_failed" },
    });
  });

  test("not-applied mutation never defers, while indeterminate mutation keeps immediate persistent recovery", async () => {
    for (const mode of ["not_applied", "indeterminate"] as const) {
      const { rootId, sessionManager } = createSession();
      const originalBranch = sessionManager.branchWithSummary.bind(sessionManager);
      Object.defineProperty(sessionManager, "branchWithSummary", {
        configurable: true,
        value: mode === "not_applied"
          ? () => { throw new Error("branch refused"); }
          : (fromId: string, _summary: string, details: unknown, fromExtension: boolean) => {
              originalBranch(fromId, "unexpected summary", details, fromExtension);
              throw new Error("branch returned after partial mutation");
            },
      });
      const adapter = createSpyAdapter();
      const runtime = new AcmSessionRuntime(adapter);
      const { context, handlers, travelTool } = registerFixture(sessionManager, runtime);
      const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];

      const result = await travelTool.execute(`branch-${mode}`, { target: rootId, handoff: HANDOFF }, undefined, undefined, context);
      expect(result.details).toMatchObject({
        branchState: mode,
        contextDeliveryPhase: "active",
      });
      expect(adapter.scheduled).toBe(0);
      await emit(handlers, "tool_execution_end", { toolCallId: `branch-${mode}`, toolName: "acm_travel" }, context);
      expect(adapter.applied).toBe(0);

      const contextResult = await emit(handlers, "context", { messages: staleMessages }, context) as { messages?: AgentMessage[] } | undefined;
      if (mode === "not_applied") {
        expect(contextResult).toBeUndefined();
        expect(result.details.contextRefreshPending).toBe(false);
      } else {
        const rebuilt = rebuildAcmContextPacket(sessionManager);
        if (!rebuilt.ok) throw new Error(rebuilt.message);
        expect(contextResult?.messages).toEqual(rebuilt.value.messages);
        expect(result.details.contextRefreshPending).toBe(true);
      }
    }
  });
});
