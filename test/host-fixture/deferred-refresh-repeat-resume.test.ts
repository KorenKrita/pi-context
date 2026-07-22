import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const temporaryDirectories: string[] = [];

const handoff = (state: string) => ({
  goal: "exercise repeated deferred refresh",
  state,
  evidence: "capability host fixture",
  external: "none",
  exclusions: "none",
  recover: "repeat-deferred-refresh-done",
  next: "continue from the resulting branch",
});

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function acmMessages(sessionManager: SessionManager): AgentMessage[] {
  const result = rebuildAcmContextPacket(sessionManager);
  if (!result.ok) throw new Error(result.message);
  return result.value.messages;
}

function createFixture(sessionManager: SessionManager) {
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
  registerAcmExtension(api);
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  if (!travelTool || !timelineTool) throw new Error("ACM tools were not registered");
  return { context, handlers, timelineTool, travelTool };
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
  target: string,
  toolCallId: string,
  state: string,
) {
  const result = await fixture.travelTool.execute(
    toolCallId,
    { target, handoff: handoff(state) },
    undefined,
    undefined,
    fixture.context,
  );
  expect(result.details).toMatchObject({
    contextRefreshState: "pending_tool_result",
    contextDeliveryPhase: "pending_tool_result",
  });
  return result;
}

async function authorizeTravel(
  fixture: ReturnType<typeof createFixture>,
  toolCallId: string,
  result: Awaited<ReturnType<typeof fixture.travelTool.execute>>,
) {
  const provider = await emit(fixture.handlers, "context", {
    messages: [{
      role: "toolResult",
      toolCallId,
      toolName: "acm_travel",
      content: result.content,
      details: result.details,
      isError: false,
      timestamp: Date.now(),
    }],
  }, fixture.context) as { messages?: AgentMessage[] };
  expect(provider.messages).toEqual(acmMessages(fixture.context.sessionManager as SessionManager));
}

function installObservedHost() {
  AgentSession.prototype.getContextUsage = function () {
    return { tokens: 1_000, contextWindow: 100_000, percent: 1 };
  };
}

describe("repeated travel, restoration, and resume with deferred delivery", () => {
  test("settling repeated travel applies only the latest persisted leaf", async () => {
    installObservedHost();
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "first abandoned path", timestamp: Date.now() });
    const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
    const fixture = createFixture(sessionManager);
    const liveSession = captureLiveSession(sessionManager, staleMessages);

    await travel(fixture, rootId, "travel-1", "first travel");
    const firstLeaf = sessionManager.getLeafId();
    const latestReceipt = await travel(fixture, rootId, "travel-2", "second travel");
    const latestLeaf = sessionManager.getLeafId();
    expect(latestLeaf).not.toBe(firstLeaf);
    await authorizeTravel(fixture, "travel-2", latestReceipt);

    await emit(fixture.handlers, "tool_execution_end", { toolCallId: "travel-1", toolName: "acm_travel" }, fixture.context);
    await emit(fixture.handlers, "tool_execution_end", { toolCallId: "travel-2", toolName: "acm_travel" }, fixture.context);
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(acmMessages(sessionManager));
    const serialized = JSON.stringify(liveSession.agent.state.messages);
    expect(serialized).toContain("second travel");
    expect(serialized).not.toContain("first travel");
    expect(serialized).not.toContain("first abandoned path");
    // Native replacement occurs at settlement, while the persistent packet
    // rebuild is deliberately consumed on the first later context event.
    const firstLaterContext = await emit(
      fixture.handlers,
      "context",
      { messages: liveSession.agent.state.messages },
      fixture.context,
    ) as { messages?: AgentMessage[] };
    expect(firstLaterContext.messages).toEqual(acmMessages(sessionManager));
    const timeline = await fixture.timelineTool.execute("timeline", { view: "active" }, undefined, undefined, fixture.context);
    expect(timeline.details).toMatchObject({
      contextDeliveryPhase: "provider_active_native_applied",
      nativeContextReplacement: { leafId: latestLeaf },
    });
  });

  test("off-path restore waits for its own settlement and then rebuilds the expanded branch", async () => {
    installObservedHost();
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const archivedId = sessionManager.appendMessage({ role: "user", content: "archived detail", timestamp: Date.now() });
    sessionManager.appendLabelChange(archivedId, "archived-path");
    const fixture = createFixture(sessionManager);
    const liveSession = captureLiveSession(
      sessionManager,
      sessionManager.buildSessionContext().messages as AgentMessage[],
    );

    const shrinkReceipt = await travel(fixture, rootId, "shrink", "shrunk");
    await authorizeTravel(fixture, "shrink", shrinkReceipt);
    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(JSON.stringify(liveSession.agent.state.messages)).not.toContain("archived detail");

    const beforeRestore = liveSession.agent.state.messages;
    const restoreReceipt = await travel(fixture, "archived-path", "restore", "restored");
    await authorizeTravel(fixture, "restore", restoreReceipt);
    await emit(fixture.handlers, "tool_execution_end", { toolCallId: "restore", toolName: "acm_travel" }, fixture.context);
    expect(liveSession.agent.state.messages).toBe(beforeRestore);
    await emit(fixture.handlers, "agent_settled", {}, fixture.context);

    expect(liveSession.agent.state.messages).toEqual(acmMessages(sessionManager));
    expect(JSON.stringify(liveSession.agent.state.messages)).toContain("archived detail");
    expect(sessionManager.getEntry(archivedId)).toBeDefined();
  });

  test("session lifecycle reset paths clear only their own pending deferred delivery", async () => {
    installObservedHost();
    for (const eventName of ["session_start", "session_compact", "session_tree", "session_shutdown"] as const) {
      const sessionManager = SessionManager.inMemory();
      const rootId = sessionManager.appendMessage({ role: "user", content: `${eventName} root`, timestamp: Date.now() });
      sessionManager.appendMessage({ role: "user", content: `${eventName} abandoned`, timestamp: Date.now() });
      const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
      const fixture = createFixture(sessionManager);
      const liveSession = captureLiveSession(sessionManager, staleMessages);

      await travel(fixture, rootId, `${eventName}-travel`, `${eventName} pending`);
      await emit(fixture.handlers, eventName, {}, fixture.context);
      await emit(fixture.handlers, "agent_settled", {}, fixture.context);

      expect(liveSession.agent.state.messages).toBe(staleMessages);
      const contextResult = await emit(fixture.handlers, "context", { messages: staleMessages }, fixture.context);
      expect(contextResult).toBeUndefined();
      const timeline = await fixture.timelineTool.execute(`${eventName}-timeline`, { view: "active" }, undefined, undefined, fixture.context);
      expect(timeline.details).toMatchObject({ contextDeliveryPhase: "active" });
    }
  });

  test("resume keeps persisted branch state and a new travel settles against the resumed manager", async () => {
    installObservedHost();
    const directory = mkdtempSync(join(tmpdir(), "pi-context-deferred-refresh-"));
    temporaryDirectories.push(directory);
    const sessionManager = SessionManager.create(directory, directory);
    const rootId = sessionManager.appendMessage({ role: "user", content: "persisted root", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "persisted abandoned path" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const fixture = createFixture(sessionManager);
    captureLiveSession(sessionManager, sessionManager.buildSessionContext().messages as AgentMessage[]);

    const persistedReceipt = await travel(fixture, rootId, "persist", "persisted travel");
    await authorizeTravel(fixture, "persist", persistedReceipt);
    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    const expectedMessages = acmMessages(sessionManager);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Expected a persisted session file");

    await emit(fixture.handlers, "session_shutdown", {}, fixture.context);
    const resumedManager = SessionManager.open(sessionFile, directory, directory);
    expect(acmMessages(resumedManager)).toEqual(expectedMessages);
    const resumedFixture = createFixture(resumedManager);
    const resumedSession = captureLiveSession(resumedManager, [{ role: "user", content: "stale resumed state", timestamp: Date.now() }]);
    await emit(resumedFixture.handlers, "session_start", {}, resumedFixture.context);

    const restoreTarget = resumedManager.getBranch()[0]?.id;
    if (!restoreTarget) throw new Error("Expected a resumed branch root");
    const resumedReceipt = await travel(resumedFixture, restoreTarget, "resume-travel", "resumed travel");
    await authorizeTravel(resumedFixture, "resume-travel", resumedReceipt);
    await emit(resumedFixture.handlers, "agent_settled", {}, resumedFixture.context);
    expect(resumedSession.agent.state.messages).toEqual(acmMessages(resumedManager));
    expect(JSON.stringify(resumedSession.agent.state.messages)).not.toContain("stale resumed state");
  });
});
