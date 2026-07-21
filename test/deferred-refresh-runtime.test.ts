import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionSyncOutcome,
  LiveAgentSessionAdapter,
} from "../src/live-agent-session-adapter.js";
import { registerAcmLifecycle } from "../src/runtime-lifecycle.js";
import { AcmSessionRuntime } from "../src/runtime.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function createAdapter(): LiveAgentSessionAdapter & {
  scheduled: Array<{ toolCallId: string; leafId?: string }>;
  applied: string[];
  clearCalls: number;
} {
  const idle: AgentSessionSyncOutcome = {
    status: "skipped",
    reason: "not_pending",
    message: "idle",
  };
  return {
    installation: { status: "ready" },
    scheduled: [],
    applied: [],
    clearCalls: 0,
    schedule(_session, toolCallId, leafId) {
      this.scheduled.push({ toolCallId, ...(leafId === undefined ? {} : { leafId }) });
      return leafId === undefined ? { status: "pending" } : { status: "pending", preferredLeafId: leafId };
    },
    apply(_session, toolCallId) {
      this.applied.push(toolCallId);
      return { status: "applied", leafId: `applied-${toolCallId}`, messageCount: 1 };
    },
    getStatus: () => idle,
    clear() { this.clearCalls++; },
  };
}

function persistedUserEntry(id: string, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "2026-07-21T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  } as SessionEntry;
}

function createSession(id: string) {
  const entry = persistedUserEntry(id, `persisted ${id}`);
  return {
    getLeafId: () => id,
    getEntries: () => [entry],
    getBranch: () => [entry],
  };
}

function createProtocolInvalidSession(id: string) {
  const root = persistedUserEntry(`${id}-root`, "persisted root");
  const invalidAssistant = {
    id,
    type: "message",
    parentId: root.id,
    timestamp: "2026-07-21T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "", name: "broken-tool", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as SessionEntry;
  return {
    getLeafId: () => id,
    getEntries: () => [root, invalidAssistant],
    getBranch: () => [root, invalidAssistant],
  };
}

function createLifecycleFixture(runtime: AcmSessionRuntime, sessionManager: object) {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  let idle: boolean | "throw" = true;
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    sendMessage() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  registerAcmLifecycle(pi, runtime);
  const context = {
    sessionManager,
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    isIdle() {
      if (idle === "throw") throw new Error("idle state unavailable");
      return idle;
    },
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  return {
    notifications,
    setIdle(value: boolean | "throw") { idle = value; },
    async emit(event: string, data: object = {}) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...data }, context);
      return result;
    },
  };
}

describe("deferred post-travel context delivery", () => {
  test("preserves same-run protocol, ignores an error agent_end, then rebuilds only after agent_settled", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("persisted-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    expect(runtime.deferPostTravelRefresh(session, "travel-call", "traveled-leaf")).toEqual({ status: "pending" });
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_run_settle");
    expect(runtime.shouldKeepCurrentRunContext(session)).toBe(true);

    const sameRun = await fixture.emit("context", {
      messages: [{ role: "user", content: [{ type: "text", text: "live tool protocol must remain intact" }] }],
    });
    expect(sameRun).toBeUndefined();
    expect(runtime.keepDeferredRefreshThroughToolExecution(session, "travel-call")).toBe(true);
    expect(adapter.applied).toEqual([]);

    await fixture.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", content: [] }],
    });
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_run_settle");
    expect(adapter.applied).toEqual([]);

    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual(["travel-call"]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");

    const firstLaterContext = await fixture.emit("context", { messages: [] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(firstLaterContext.messages).toHaveLength(1);
    expect(JSON.stringify(firstLaterContext.messages)).toContain("persisted persisted-leaf");
    expect(runtime.getContextDeliveryPhase(session)).toBe("active");

    const secondLaterContext = await fixture.emit("context", { messages: [] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(secondLaterContext.messages).toHaveLength(1);
    expect(JSON.stringify(secondLaterContext.messages)).toContain("persisted persisted-leaf");
    expect(fixture.notifications).toEqual([]);
  });

  test("keeps the travel ticket pending until agent_settled can prove the session is idle", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("idle-guard-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "idle-guard-call", "traveled-leaf");
    fixture.setIdle(false);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_run_settle");

    fixture.setIdle("throw");
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_run_settle");

    fixture.setIdle(true);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual(["idle-guard-call"]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");
  });

  test("retains the delivery phase through rebuild failures and consumes it only after a later rebuild succeeds", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const entry = persistedUserEntry("rebuild-retry-leaf", "persisted after retry");
    let failRebuild = true;
    const session = {
      getLeafId: () => entry.id,
      getEntries: () => {
        if (failRebuild) throw new Error("temporary session read failure");
        return [entry];
      },
      getBranch: () => [entry],
    };
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "rebuild-retry-call", "traveled-leaf");
    await fixture.emit("agent_settled");
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");

    const failed = await fixture.emit("context", { messages: [{ role: "user", content: "retain live message" }] });
    expect(failed).toEqual({ messages: [{ role: "user", content: "retain live message" }] });
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");

    failRebuild = false;
    const rebuilt = await fixture.emit("context", { messages: [] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(rebuilt.messages)).toContain("persisted after retry");
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("active");
  });

  test("refuses an invalid persisted packet without consuming the settled delivery retry", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createProtocolInvalidSession("invalid-protocol-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "invalid-protocol-call", "traveled-leaf");
    await fixture.emit("agent_settled");
    const liveMessages = [{ role: "user", content: "retain live messages until the protocol is repaired" }];

    const result = await fixture.emit("context", { messages: liveMessages });

    expect(result).toEqual({ messages: liveMessages });
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");
    expect(fixture.notifications.at(-1)).toContain("invalid tool protocol");
    expect(fixture.notifications.at(-1)).toContain("invalid_tool_call_id");
  });

  test("keeps an exhausted persisted rebuild visibly non-active", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = {
      getLeafId: () => "exhausted-leaf",
      getEntries: () => { throw new Error("persistent session read failure"); },
      getBranch: () => [],
    };
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "exhausted-call", "traveled-leaf");
    await fixture.emit("agent_settled");
    for (let attempt = 0; attempt < 3; attempt++) {
      await fixture.emit("context", { messages: [] });
    }

    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    expect(runtime.getContextDeliveryPhase(session)).toBe("next_context_rebuild");
  });

  test("multiple successful travels retain only the latest ticket until settlement", () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = {};

    runtime.deferPostTravelRefresh(session, "travel-one", "leaf-one");
    runtime.deferPostTravelRefresh(session, "travel-two", "leaf-two");

    expect(adapter.scheduled).toEqual([
      { toolCallId: "travel-one" },
      { toolCallId: "travel-two" },
    ]);
    expect(runtime.keepDeferredRefreshThroughToolExecution(session, "travel-one")).toBe(false);
    expect(runtime.keepDeferredRefreshThroughToolExecution(session, "travel-two")).toBe(true);
    expect(runtime.settleDeferredRefresh(session)).toMatchObject({
      status: "applied",
      leafId: "applied-travel-two",
    });
    expect(adapter.applied).toEqual(["travel-two"]);
    expect(runtime.getRefreshTarget(session)).toBe("leaf-two");
  });

  test("isolates SessionManagers and leaves failed or indeterminate travel outside the settlement gate", () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const first = {};
    const second = {};
    const failedOrIndeterminate = {};

    runtime.deferPostTravelRefresh(first, "first-call", "first-leaf");
    runtime.deferPostTravelRefresh(second, "second-call", "second-leaf");
    // Failed/indeterminate mutation paths use scheduleRefresh for persistent
    // fallback only; they do not create an AgentSession settlement ticket.
    runtime.scheduleRefresh(failedOrIndeterminate, "uncertain-leaf");

    expect(runtime.getContextDeliveryPhase(first)).toBe("pending_run_settle");
    expect(runtime.getContextDeliveryPhase(second)).toBe("pending_run_settle");
    expect(runtime.getContextDeliveryPhase(failedOrIndeterminate)).toBe("active");
    expect(runtime.settleDeferredRefresh(failedOrIndeterminate)).toBeUndefined();

    runtime.settleDeferredRefresh(first);
    expect(adapter.applied).toEqual(["first-call"]);
    expect(runtime.getContextDeliveryPhase(first)).toBe("next_context_rebuild");
    expect(runtime.getContextDeliveryPhase(second)).toBe("pending_run_settle");
    expect(runtime.contextRefresh.isPending(failedOrIndeterminate)).toBe(true);

    runtime.clear(second);
    expect(runtime.getContextDeliveryPhase(second)).toBe("active");
    expect(adapter.clearCalls).toBeGreaterThan(0);
  });
});
