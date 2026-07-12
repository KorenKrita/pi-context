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

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const originalGetContextUsage = AgentSession.prototype.getContextUsage;

const handoff = (scope: string) => [
  `Goal: synchronize ${scope}`,
  `State: ${scope} travel completed`,
  "Evidence: capability host isolation fixture",
  "External: none",
  "Exclusions: unrelated sessions",
  `Recover: ${scope}-done`,
  `NEXT: continue ${scope}`,
].join("\n");

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
});

function createFixture(sessionManager: SessionManager) {
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
  registerAcmExtension(api);
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
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
  for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
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

function createBranch(scope: string) {
  const sessionManager = SessionManager.inMemory();
  const rootId = sessionManager.appendMessage({ role: "user", content: `${scope} root`, timestamp: Date.now() });
  sessionManager.appendMessage({ role: "user", content: `${scope} abandoned`, timestamp: Date.now() });
  return { sessionManager, rootId };
}

describe("live AgentSession synchronization isolation", () => {
  test("isolates two concurrent sessions and clearing one cannot consume the other pending travel", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const parent = createBranch("parent");
    const subagent = createBranch("subagent");
    const parentFixture = createFixture(parent.sessionManager);
    const wrappedGetContextUsage = AgentSession.prototype.getContextUsage;
    const subagentFixture = createFixture(subagent.sessionManager);
    expect(AgentSession.prototype.getContextUsage).toBe(wrappedGetContextUsage);

    const parentStale = parent.sessionManager.buildSessionContext().messages as AgentMessage[];
    const subagentStale = subagent.sessionManager.buildSessionContext().messages as AgentMessage[];
    const parentSession = captureLiveSession(parent.sessionManager, parentStale);
    const subagentSession = captureLiveSession(subagent.sessionManager, subagentStale);

    await parentFixture.travelTool.execute(
      "parent-travel",
      { target: parent.rootId, summary: handoff("parent") },
      undefined,
      undefined,
      parentFixture.context,
    );
    await subagentFixture.travelTool.execute(
      "subagent-travel",
      { target: subagent.rootId, summary: handoff("subagent") },
      undefined,
      undefined,
      subagentFixture.context,
    );

    await emit(parentFixture.handlers, "session_shutdown", {}, parentFixture.context);
    await emit(
      subagentFixture.handlers,
      "tool_execution_end",
      { toolCallId: "subagent-travel", toolName: "acm_travel" },
      subagentFixture.context,
    );

    expect(parentSession.agent.state.messages).toBe(parentStale);
    expect(subagentSession.agent.state.messages).toEqual(subagent.sessionManager.buildSessionContext().messages);
    expect(JSON.stringify(subagentSession.agent.state.messages)).not.toContain("parent");
    expect(JSON.stringify(parentSession.agent.state.messages)).not.toContain("subagent");

    await emit(
      parentFixture.handlers,
      "tool_execution_end",
      { toolCallId: "parent-travel", toolName: "acm_travel" },
      parentFixture.context,
    );
    expect(parentSession.agent.state.messages).toBe(parentStale);
  });

  test("only the latest matching tool completion applies across duplicate runtimes for one manager", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const branch = createBranch("duplicate-runtime");
    const firstFixture = createFixture(branch.sessionManager);
    const secondFixture = createFixture(branch.sessionManager);
    const staleMessages = branch.sessionManager.buildSessionContext().messages as AgentMessage[];
    const liveSession = captureLiveSession(branch.sessionManager, staleMessages);

    await firstFixture.travelTool.execute(
      "first-runtime",
      { target: branch.rootId, summary: handoff("first-runtime") },
      undefined,
      undefined,
      firstFixture.context,
    );
    await secondFixture.travelTool.execute(
      "second-runtime",
      { target: branch.rootId, summary: handoff("second-runtime") },
      undefined,
      undefined,
      secondFixture.context,
    );

    await emit(
      firstFixture.handlers,
      "tool_execution_end",
      { toolCallId: "first-runtime", toolName: "acm_travel" },
      firstFixture.context,
    );
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    await emit(
      secondFixture.handlers,
      "tool_execution_end",
      { toolCallId: "second-runtime", toolName: "acm_travel" },
      secondFixture.context,
    );
    expect(liveSession.agent.state.messages).toEqual(branch.sessionManager.buildSessionContext().messages);
    expect(JSON.stringify(liveSession.agent.state.messages)).toContain("second-runtime travel completed");
  });

  test("matches sessions by SessionManager identity despite identical metadata and applies only the addressed travel", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const first = createBranch("same-metadata-first");
    const second = createBranch("same-metadata-second");
    const firstFixture = createFixture(first.sessionManager);
    const secondFixture = createFixture(second.sessionManager);
    const firstStale = first.sessionManager.buildSessionContext().messages as AgentMessage[];
    const secondStale = second.sessionManager.buildSessionContext().messages as AgentMessage[];
    const firstSession = captureLiveSession(first.sessionManager, firstStale);
    const secondSession = captureLiveSession(second.sessionManager, secondStale);

    await firstFixture.travelTool.execute(
      "first-only",
      { target: first.rootId, summary: handoff("first-only") },
      undefined,
      undefined,
      firstFixture.context,
    );
    await emit(
      firstFixture.handlers,
      "tool_execution_end",
      { toolCallId: "first-only", toolName: "acm_travel" },
      firstFixture.context,
    );

    expect(firstSession.agent.state.messages).toEqual(first.sessionManager.buildSessionContext().messages);
    expect(firstSession.agent.state.messages).not.toBe(firstStale);
    expect(secondSession.agent.state.messages).toBe(secondStale);
  });
});
