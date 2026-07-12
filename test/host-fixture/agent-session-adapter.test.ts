import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createLiveAgentSessionAdapter,
  getLiveAgentSyncRecoveryGuidance,
  type AgentSessionHostClass,
} from "./.acm-build/live-agent-session-adapter.js";

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const installedPrototypes: object[] = [];
afterEach(() => {
  for (const prototype of installedPrototypes.splice(0)) delete (prototype as Record<PropertyKey, unknown>)[installationSymbol];
});

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
  installedPrototypes.push(TestAgentSession.prototype);
  return TestAgentSession as unknown as AgentSessionHostClass;
}

describe("live AgentSession adapter against pinned Pi", () => {
  test("captures by SessionManager identity and applies rebuilt active-branch messages", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
    const agent = { state: { messages: [{ role: "user", content: "stale", timestamp: Date.now() }] as AgentMessage[] } };
    const HostClass = createHostClass();
    const session = new (HostClass as any)(sessionManager, agent);
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass, hostVersion: "0.80.6" });

    expect(adapter.installation).toEqual({ status: "ready" });
    session.getContextUsage();
    expect(adapter.schedule(sessionManager, sessionManager.getLeafId() ?? undefined)).toMatchObject({ status: "pending" });
    expect(adapter.apply(sessionManager)).toMatchObject({ status: "applied", messageCount: 1 });
    expect(agent.state.messages).toEqual(sessionManager.buildSessionContext().messages);
  });

  test("installs one wrapper and invokes the original method exactly once", () => {
    const counter = { calls: 0 };
    const HostClass = createHostClass(counter);
    const sessionManager = SessionManager.inMemory();
    const session = new (HostClass as any)(sessionManager, { state: { messages: [] } });
    const first = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass, hostVersion: "0.80.6" });
    const wrapped = HostClass.prototype.getContextUsage;
    const second = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass, hostVersion: "0.80.6" });
    expect(HostClass.prototype.getContextUsage).toBe(wrapped);
    HostClass.prototype.getContextUsage.call(session);
    expect(counter.calls).toBe(1);
    expect(first.schedule(sessionManager).status).toBe("pending");
    expect(second.apply(sessionManager).status).toBe("applied");
  });

  test("reports unsupported version, unsupported shape, missing association, and replacement failure", () => {
    expect(createLiveAgentSessionAdapter({ hostVersion: "0.80.5" }).installation).toMatchObject({ status: "unavailable", reason: "unsupported_host_version" });
    expect(createLiveAgentSessionAdapter({ AgentSessionClass: { prototype: {} } as AgentSessionHostClass, hostVersion: "0.80.6" }).installation).toMatchObject({ status: "unavailable", reason: "unsupported_host_shape" });

    const HostClass = createHostClass();
    const adapter = createLiveAgentSessionAdapter({ AgentSessionClass: HostClass, hostVersion: "0.80.6" });
    expect(adapter.schedule({})).toMatchObject({ status: "skipped", reason: "missing_association" });

    const sessionManager = SessionManager.inMemory();
    const state = { messages: [] as AgentMessage[] };
    Object.defineProperty(state, "messages", { get: () => [], set: () => { throw new Error("replacement refused"); } });
    const session = new (HostClass as any)(sessionManager, { state });
    session.getContextUsage();
    expect(adapter.schedule(sessionManager).status).toBe("pending");
    const failure = adapter.apply(sessionManager);
    expect(failure).toMatchObject({ status: "failed", reason: "replace_messages_failed", message: "replacement refused" });
    expect(getLiveAgentSyncRecoveryGuidance(failure)).toContain("Reload");

    const brokenManager = { getLeafId: () => { throw new Error("leaf unavailable"); } };
    const brokenSession = new (HostClass as any)(brokenManager, { state: { messages: [] } });
    brokenSession.getContextUsage();
    expect(adapter.schedule(brokenManager).status).toBe("pending");
    expect(adapter.apply(brokenManager)).toMatchObject({ status: "failed", reason: "read_leaf_failed", message: "leaf unavailable" });
    expect(adapter.getStatus(brokenManager)).toMatchObject({ status: "failed", reason: "read_leaf_failed" });
  });
});
