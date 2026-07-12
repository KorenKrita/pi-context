import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerAcmLifecycle } from "./.acm-build/runtime-lifecycle.js";
import { AcmSessionRuntime } from "./.acm-build/runtime.js";
import { registerTimelineTool } from "./.acm-build/timeline-tool.js";
import { registerTravelTool } from "./.acm-build/travel-tool.js";
import {
  createLiveAgentSessionAdapter,
  type AgentSessionHostClass,
  type AgentSessionSyncOutcome,
  type LiveAgentSessionAdapter,
} from "./.acm-build/live-agent-session-adapter.js";

const HANDOFF = [
  "Goal: verify live synchronization failure recovery",
  "State: travel completed or failed as asserted",
  "Evidence: pinned Pi host fixture",
  "External: none",
  "Exclusions: no synthetic compaction or tool calls",
  "Recover: failure-recovery-checkpoint",
  "NEXT: continue from the persistent active branch",
].join("\n");

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
    getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
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
  return {
    installation: { status: "ready" },
    scheduled: 0,
    applied: 0,
    schedule() {
      this.scheduled++;
      return { status: "pending" };
    },
    apply() {
      this.applied++;
      return { status: "applied", leafId: null, messageCount: 0 };
    },
    getStatus() { return initial; },
    clear() {},
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

describe("live synchronization failure recovery", () => {
  test("unsupported host leaves persistent travel rebuild active and reports reload guidance", async () => {
    const { rootId, sessionManager } = createSession();
    const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
    const adapter = createLiveAgentSessionAdapter({ hostVersion: "0.80.5" });
    const runtime = new AcmSessionRuntime(adapter);
    const { context, handlers, timelineTool, travelTool } = registerFixture(sessionManager, runtime);

    const result = await travelTool.execute("unsupported", { target: rootId, summary: HANDOFF }, undefined, undefined, context);
    expect(result.details).toMatchObject({
      contextRefreshState: "pending",
      liveAgentSessionSyncState: "unavailable",
      liveAgentSessionSync: { status: "unavailable", reason: "unsupported_host_version" },
    });
    expect((result.content[0] as { text: string }).text).toContain("Persistent context rebuild remains active");

    const rebuilt = sessionManager.buildSessionContext().messages as AgentMessage[];
    const contextResult = await emit(handlers, "context", { messages: staleMessages }, context) as { messages?: AgentMessage[] };
    expect(contextResult.messages).toEqual(rebuilt);
    expect(JSON.stringify(rebuilt)).not.toContain("folded payload");

    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    const text = (timeline.content[0] as { text: string }).text;
    expect(text).toContain("Live Agent Sync:  unavailable");
    expect(text).toContain("Reload the session");
  });

  test("replacement failure preserves traveled branch and clears only its pending work", async () => {
    const { rootId, sessionManager } = createSession();
    const HostClass = createThrowingHostClass();
    const state = { messages: [] as AgentMessage[] };
    Object.defineProperty(state, "messages", {
      get: () => [],
      set: () => { throw new Error("replacement refused"); },
    });
    const liveSession = new (HostClass as any)(sessionManager, { state });
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass, hostVersion: "0.80.6" });
    liveSession.getContextUsage();
    const runtime = new AcmSessionRuntime(adapter);
    const { context, handlers, notifications, timelineTool, travelTool } = registerFixture(sessionManager, runtime);

    const result = await travelTool.execute(
      "replacement-failure",
      { target: rootId, summary: HANDOFF, backupCurrentHeadAs: "replacement-failure-done" },
      undefined,
      undefined,
      context,
    );
    expect(result.details).toMatchObject({ liveAgentSessionSyncState: "pending" });
    const traveledLeaf = sessionManager.getLeafId();

    await emit(handlers, "tool_execution_end", { toolCallId: "replacement-failure", toolName: "acm_travel" }, context);
    expect(runtime.getLiveAgentSyncStatus(sessionManager)).toMatchObject({
      status: "failed",
      reason: "replace_messages_failed",
      message: "replacement refused",
    });
    expect(notifications.at(-1)).toContain("Live AgentSession synchronization failed");
    expect(notifications.at(-1)).toContain("Reload the session");
    expect(sessionManager.getLeafId()).toBe(traveledLeaf);
    expect(sessionManager.getEntry(traveledLeaf!)).toMatchObject({ type: "branch_summary", summary: HANDOFF });
    expect(sessionManager.getEntries().some((entry) => entry.type === "label" && entry.label === "replacement-failure-done")).toBe(true);

    await emit(handlers, "tool_execution_end", { toolCallId: "replacement-failure", toolName: "acm_travel" }, context);
    expect(runtime.getLiveAgentSyncStatus(sessionManager)).toMatchObject({ status: "failed" });
    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    expect((timeline.content[0] as { text: string }).text).toContain("Live Agent Sync:  failed");
    expect((timeline.content[0] as { text: string }).text).toContain("Reload the session");
    expect(timeline.details).toMatchObject({
      liveAgentSessionSyncState: "failed",
      liveAgentSessionSync: { status: "failed", reason: "replace_messages_failed" },
    });
  });

  test("failed and indeterminate branch mutations never schedule live replacement", async () => {
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

      const result = await travelTool.execute(`branch-${mode}`, { target: rootId, summary: HANDOFF }, undefined, undefined, context);
      expect(result.details).toMatchObject({
        branchState: mode,
        liveAgentSessionSyncState: "skipped",
        liveAgentSessionSync: { status: "skipped", reason: "branch_not_applied" },
      });
      expect(adapter.scheduled).toBe(0);
      await emit(handlers, "tool_execution_end", { toolCallId: `branch-${mode}`, toolName: "acm_travel" }, context);
      expect(adapter.applied).toBe(0);
      expect(result.details.contextRefreshPending).toBe(mode === "indeterminate");
    }
  });
});
