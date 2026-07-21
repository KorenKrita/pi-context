import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createLiveAgentSessionAdapter,
  getLiveAgentSyncRecoveryGuidance,
  type AgentSessionHostClass,
} from "./.acm-build/live-agent-session-adapter.js";

function createHostClass(counter = { calls: 0 }): AgentSessionHostClass {
  class TestAgentSession {
    constructor(
      readonly sessionManager: SessionManager,
      readonly agent: { state: { messages: AgentMessage[] } },
    ) {}
    getContextUsage() {
      counter.calls++;
      return undefined;
    }
  }
  return TestAgentSession as unknown as AgentSessionHostClass;
}

describe("live AgentSession capability adapter", () => {
  test("captures by SessionManager identity and applies rebuilt active-branch messages", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
    const agent = { state: { messages: [{ role: "user", content: "stale", timestamp: Date.now() }] as AgentMessage[] } };
    const HostClass = createHostClass();
    const session = new (HostClass as any)(sessionManager, agent);
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });

    expect(adapter.installation).toEqual({ status: "ready" });
    session.getContextUsage();
    expect(adapter.schedule(sessionManager, "travel", sessionManager.getLeafId() ?? undefined)).toMatchObject({ status: "pending" });
    expect(adapter.apply(sessionManager, "travel")).toMatchObject({ status: "applied", messageCount: 1 });
    expect(agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
  });

  test("accepts the real Agent state setter copying the replacement array", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
    const agent = new Agent({
      initialState: {
        messages: [{ role: "user", content: "stale", timestamp: Date.now() }],
      },
    });
    const HostClass = createHostClass();
    const session = new (HostClass as any)(sessionManager, agent);
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });

    session.getContextUsage();
    expect(adapter.schedule(sessionManager, "travel", sessionManager.getLeafId() ?? undefined)).toMatchObject({ status: "pending" });
    expect(adapter.apply(sessionManager, "travel")).toMatchObject({ status: "applied", messageCount: 1 });
    expect(agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
  });

  test("installs one wrapper and invokes the original method exactly once", () => {
    const counter = { calls: 0 };
    const HostClass = createHostClass(counter);
    const sessionManager = SessionManager.inMemory();
    const session = new (HostClass as any)(sessionManager, { state: { messages: [] } });
    const first = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    const wrapped = HostClass.prototype.getContextUsage;
    const second = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    expect(HostClass.prototype.getContextUsage).toBe(wrapped);
    HostClass.prototype.getContextUsage.call(session);
    expect(counter.calls).toBe(1);
    expect(first.schedule(sessionManager, "travel").status).toBe("pending");
    expect(second.apply(sessionManager, "travel").status).toBe("applied");
  });

  test("falls back without throwing when the host method cannot be wrapped", () => {
    let calls = 0;
    const prototype = {} as AgentSessionHostClass["prototype"];
    const original = function () { calls++; };
    Object.defineProperty(prototype, "getContextUsage", {
      value: original,
      configurable: false,
      writable: false,
    });

    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: { prototype } });

    expect(adapter.installation).toMatchObject({ status: "unavailable", reason: "unsupported_host_shape" });
    expect(prototype.getContextUsage).toBe(original as never);
    prototype.getContextUsage.call({} as never);
    expect(calls).toBe(1);
  });

  test("never lets capability observation break the original lifecycle method", () => {
    const counter = { calls: 0 };
    const HostClass = createHostClass(counter);
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    const manager = SessionManager.inMemory();
    const session = { sessionManager: manager } as { sessionManager: SessionManager; agent?: unknown };
    Object.defineProperty(session, "agent", { get: () => { throw new Error("probe getter exploded"); } });

    expect(() => HostClass.prototype.getContextUsage.call(session as never)).not.toThrow();
    expect(counter.calls).toBe(1);
    expect(adapter.schedule(manager, "travel")).toMatchObject({
      status: "unavailable",
      reason: "unsupported_session_shape",
      message: "AgentSession capability probe failed: probe getter exploded",
    });
  });

  test("re-probes current capabilities and reports replacement failures", () => {
    expect(createLiveAgentSessionAdapter({ AgentSessionClass: { prototype: {} } as AgentSessionHostClass }).installation).toMatchObject({ status: "unavailable", reason: "unsupported_host_shape" });

    const HostClass = createHostClass();
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    expect(adapter.schedule({}, "missing")).toMatchObject({ status: "skipped", reason: "missing_association" });

    const unsupportedManager = SessionManager.inMemory();
    const unsupportedSession = new (HostClass as any)(unsupportedManager, { state: {} });
    unsupportedSession.getContextUsage();
    expect(adapter.schedule(unsupportedManager, "unsupported")).toMatchObject({ status: "unavailable", reason: "unsupported_session_shape" });
    unsupportedSession.agent.state.messages = [];
    expect(adapter.schedule(unsupportedManager, "recovered")).toMatchObject({ status: "pending" });
    expect(adapter.apply(unsupportedManager, "recovered")).toMatchObject({ status: "applied" });

    const sessionManager = SessionManager.inMemory();
    const state = { messages: [] as AgentMessage[] };
    Object.defineProperty(state, "messages", { get: () => [], set: () => { throw new Error("replacement refused"); } });
    const session = new (HostClass as any)(sessionManager, { state });
    session.getContextUsage();
    expect(adapter.schedule(sessionManager, "replacement").status).toBe("pending");
    const failure = adapter.apply(sessionManager, "replacement");
    expect(failure).toMatchObject({ status: "failed", reason: "replace_messages_failed", message: "replacement refused" });
    expect(getLiveAgentSyncRecoveryGuidance(failure)).toContain("Reload");

    const ignoredManager = SessionManager.inMemory();
    ignoredManager.appendMessage({ role: "user", content: "must replace", timestamp: Date.now() });
    const retainedMessages: AgentMessage[] = [];
    const ignoredState = {} as { messages: AgentMessage[] };
    Object.defineProperty(ignoredState, "messages", { get: () => retainedMessages, set: () => undefined });
    const ignoredSession = new (HostClass as any)(ignoredManager, { state: ignoredState });
    ignoredSession.getContextUsage();
    expect(adapter.schedule(ignoredManager, "ignored").status).toBe("pending");
    expect(adapter.apply(ignoredManager, "ignored")).toMatchObject({
      status: "failed",
      reason: "replace_messages_failed",
      message: "AgentSession.agent.state.messages did not retain the replacement message sequence",
    });

    const brokenManager = { getLeafId: () => { throw new Error("leaf unavailable"); } };
    const brokenSession = new (HostClass as any)(brokenManager, { state: { messages: [] } });
    brokenSession.getContextUsage();
    expect(adapter.schedule(brokenManager, "broken").status).toBe("pending");
    expect(adapter.apply(brokenManager, "broken")).toMatchObject({ status: "failed", reason: "read_leaf_failed", message: "leaf unavailable" });
    expect(adapter.getStatus(brokenManager)).toMatchObject({ status: "failed", reason: "read_leaf_failed" });
  });

  test("only the matching latest tool ticket may consume pending synchronization", () => {
    const HostClass = createHostClass();
    const manager = SessionManager.inMemory();
    const session = new (HostClass as any)(manager, { state: { messages: [] } });
    const first = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    const second = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
    session.getContextUsage();

    expect(first.schedule(manager, "first")).toMatchObject({ status: "pending" });
    expect(second.schedule(manager, "second")).toMatchObject({ status: "pending" });
    expect(first.apply(manager, "first")).toMatchObject({ status: "skipped", reason: "not_pending" });
    expect(first.getStatus(manager)).toMatchObject({ status: "pending" });
    expect(second.apply(manager, "second")).toMatchObject({ status: "applied" });
  });
});

test("settlement rebuilds from the current active leaf after it advances during the deferred run", () => {
  const sessionManager = SessionManager.inMemory();
  const initialLeaf = sessionManager.appendMessage({ role: "user", content: "leaf A", timestamp: Date.now() });
  const agent = { state: { messages: [{ role: "user", content: "stale", timestamp: Date.now() }] as AgentMessage[] } };
  const HostClass = createHostClass();
  const session = new (HostClass as any)(sessionManager, agent);
  const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass });
  session.getContextUsage();

  // Deferred travel schedules ownership by tool call only. The verified travel
  // leaf remains a persistent-rebuild fallback, never a native replacement
  // target: the agent may legitimately advance the active branch before settle.
  expect(adapter.schedule(sessionManager, "travel")).toMatchObject({ status: "pending" });
  const currentLeaf = sessionManager.appendMessage({ role: "user", content: "leaf B", timestamp: Date.now() });
  expect(currentLeaf).not.toBe(initialLeaf);

  expect(adapter.apply(sessionManager, "travel")).toMatchObject({
    status: "applied",
    leafId: currentLeaf,
    messageCount: 2,
  });
  expect(agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
  expect(JSON.stringify(agent.state.messages)).toContain("leaf B");
});
