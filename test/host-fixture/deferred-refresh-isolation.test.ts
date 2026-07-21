import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "./.acm-build/index.js";
import { rebuildAcmContextPacket } from "./.acm-build/context-packet.js";

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const originalGetContextUsage = AgentSession.prototype.getContextUsage;

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
});

const handoff = (scope: string) => ({
  goal: `defer ${scope}`,
  state: `${scope} travel completed`,
  evidence: "capability host isolation fixture",
  external: "none",
  exclusions: "unrelated sessions",
  recover: `${scope}-done`,
  next: `continue ${scope}`,
});

function acmMessages(sessionManager: SessionManager): AgentMessage[] {
  const result = rebuildAcmContextPacket(sessionManager);
  if (!result.ok) throw new Error(result.message);
  return result.value.messages;
}

function createFixture(sessionManager: SessionManager, registrations = 1) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let travelTool: ToolDefinition | undefined;
  const api = {
    registerTool(tool: ToolDefinition) {
      if (tool.name === "acm_travel") travelTool = tool;
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  for (let index = 0; index < registrations; index++) registerAcmExtension(api);
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  if (!travelTool) throw new Error("ACM travel tool was not registered");
  return { context, handlers, travelTool };
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
  sessionManager.appendMessage({ role: "user", content: `${scope} abandoned`, timestamp: Date.now() });
  return { sessionManager, rootId };
}

/**
 * Use Pi's actual AgentSession prototype, rather than a lookalike, so these
 * tests exercise the adapter's capability probe and its SessionManager-keyed
 * association.  The host normally supplies a context-usage implementation;
 * the fixture only needs a harmless deterministic equivalent.
 */
function installObservedHost() {
  AgentSession.prototype.getContextUsage = function () {
    return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
  };
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

async function travel(
  fixture: ReturnType<typeof createFixture>,
  rootId: string,
  toolCallId: string,
  scope: string,
) {
  const result = await fixture.travelTool.execute(
    toolCallId,
    { target: rootId, handoff: handoff(scope) },
    undefined,
    undefined,
    fixture.context,
  );
  expect(result.details).toMatchObject({ contextDeliveryPhase: "pending_run_settle" });
}

describe("deferred refresh isolation", () => {
  test("settling a capability-compatible subagent replaces only its native array while the parent remains in-flight", async () => {
    installObservedHost();
    const parent = createBranch("parent");
    const subagent = createBranch("subagent");
    const parentFixture = createFixture(parent.sessionManager);
    const subagentFixture = createFixture(subagent.sessionManager);
    const parentStale = parent.sessionManager.buildSessionContext().messages as AgentMessage[];
    const subagentStale = subagent.sessionManager.buildSessionContext().messages as AgentMessage[];
    const parentLiveSession = captureLiveSession(parent.sessionManager, parentStale);
    const subagentLiveSession = captureLiveSession(subagent.sessionManager, subagentStale);

    await travel(parentFixture, parent.rootId, "parent-travel", "parent");
    await travel(subagentFixture, subagent.rootId, "subagent-travel", "subagent");
    expect(await emit(parentFixture.handlers, "context", { messages: parentStale }, parentFixture.context)).toBeUndefined();
    expect(await emit(subagentFixture.handlers, "context", { messages: subagentStale }, subagentFixture.context)).toBeUndefined();

    // Clearing the parent must not consume the subagent's deferred delivery.
    await emit(subagentFixture.handlers, "agent_settled", {}, subagentFixture.context);
    expect(subagentLiveSession.agent.state.messages).toEqual(acmMessages(subagent.sessionManager));
    expect(JSON.stringify(subagentLiveSession.agent.state.messages)).toContain("subagent travel completed");
    expect(parentLiveSession.agent.state.messages).toBe(parentStale);
    expect(JSON.stringify(parentLiveSession.agent.state.messages)).toContain("parent abandoned");

    // A parent lifecycle reset must not consume the subagent receipt that has
    // already settled, and the still-in-flight parent must stay untouched.
    await emit(parentFixture.handlers, "session_shutdown", {}, parentFixture.context);
    const subagentContext = await emit(
      subagentFixture.handlers,
      "context",
      { messages: subagentStale },
      subagentFixture.context,
    ) as { messages?: AgentMessage[] };
    expect(subagentContext.messages).toEqual(acmMessages(subagent.sessionManager));
    expect(JSON.stringify(subagentContext.messages)).toContain("subagent travel completed");
    expect(JSON.stringify(subagentContext.messages)).not.toContain("parent travel completed");

    await emit(parentFixture.handlers, "agent_settled", {}, parentFixture.context);
    expect(parentLiveSession.agent.state.messages).toBe(parentStale);
    expect(await emit(parentFixture.handlers, "context", { messages: parentStale }, parentFixture.context)).toBeUndefined();
  });

  test("identical manager metadata does not cross-deliver a settled native branch", async () => {
    installObservedHost();
    const first = createBranch("same-metadata-first");
    const second = createBranch("same-metadata-second");
    const firstFixture = createFixture(first.sessionManager);
    const secondFixture = createFixture(second.sessionManager);
    const firstStale = first.sessionManager.buildSessionContext().messages as AgentMessage[];
    const secondStale = second.sessionManager.buildSessionContext().messages as AgentMessage[];
    const firstLiveSession = captureLiveSession(first.sessionManager, firstStale);
    const secondLiveSession = captureLiveSession(second.sessionManager, secondStale);

    await travel(firstFixture, first.rootId, "first-only", "first-only");
    await emit(firstFixture.handlers, "agent_settled", {}, firstFixture.context);
    expect(firstLiveSession.agent.state.messages).toEqual(acmMessages(first.sessionManager));
    expect(secondLiveSession.agent.state.messages).toBe(secondStale);
    const firstContext = await emit(
      firstFixture.handlers,
      "context",
      { messages: firstStale },
      firstFixture.context,
    ) as { messages?: AgentMessage[] };
    expect(firstContext.messages).toEqual(acmMessages(first.sessionManager));
    expect(JSON.stringify(firstContext.messages)).toContain("first-only travel completed");
    expect(await emit(secondFixture.handlers, "context", { messages: secondStale }, secondFixture.context)).toBeUndefined();

    await travel(secondFixture, second.rootId, "second-only", "second-only");
    await emit(secondFixture.handlers, "agent_settled", {}, secondFixture.context);
    expect(secondLiveSession.agent.state.messages).toEqual(acmMessages(second.sessionManager));
    expect(JSON.stringify(secondLiveSession.agent.state.messages)).not.toContain("first-only travel completed");
    const secondContext = await emit(
      secondFixture.handlers,
      "context",
      { messages: secondStale },
      secondFixture.context,
    ) as { messages?: AgentMessage[] };
    expect(secondContext.messages).toEqual(acmMessages(second.sessionManager));
    expect(JSON.stringify(secondContext.messages)).toContain("second-only travel completed");
    expect(JSON.stringify(secondContext.messages)).not.toContain("first-only travel completed");
  });

  test("duplicate extension registration preserves one latest native ticket until settlement", async () => {
    installObservedHost();
    const branch = createBranch("duplicate-registration");
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    const fixture = createFixture(branch.sessionManager, 2);
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    await travel(fixture, branch.rootId, "duplicate-registration-first", "duplicate-registration-first");
    await travel(fixture, branch.rootId, "duplicate-registration-second", "duplicate-registration-second");
    await emit(fixture.handlers, "tool_execution_end", {
      toolCallId: "duplicate-registration-first",
      toolName: "acm_travel",
    }, fixture.context);
    await emit(fixture.handlers, "tool_execution_end", {
      toolCallId: "duplicate-registration-second",
      toolName: "acm_travel",
    }, fixture.context);
    expect(await emit(fixture.handlers, "context", { messages: staleMessages }, fixture.context)).toBeUndefined();
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(acmMessages(branch.sessionManager));
    expect(JSON.stringify(liveSession.agent.state.messages)).toContain("duplicate-registration-second travel completed");
    expect(JSON.stringify(liveSession.agent.state.messages)).not.toContain("duplicate-registration-first travel completed");
    const nextContext = await emit(
      fixture.handlers,
      "context",
      { messages: staleMessages },
      fixture.context,
    ) as { messages?: AgentMessage[] };
    expect(nextContext.messages).toEqual(acmMessages(branch.sessionManager));
  });
});
