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

function completedTravelResult(toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "acm_travel",
    content: [{ type: "text", text: "Travel complete" }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("deferred post-travel delivery on exact Pi host", () => {
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
      contextRefreshState: "pending_run_settle",
      contextDeliveryPhase: "pending_run_settle",
    });
    const inFlightMessages = [...staleMessages, completedTravelResult("normal-travel")];

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
    expect(await emit(fixture.handlers, "context", { messages: inFlightMessages }, fixture.context)).toBeUndefined();
    expect(liveSession.agent.state.messages).toBe(staleMessages);

    // A provider error can auto-retry; it must not be treated as the terminal
    // ownership handoff to a later user run.
    await emit(fixture.handlers, "agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "error" }],
    }, fixture.context);
    expect(await emit(fixture.handlers, "context", { messages: inFlightMessages }, fixture.context)).toBeUndefined();
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

    await fixture.travelTool.execute(
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

    await emit(fixture.handlers, "agent_settled", {}, fixture.context);
    expect(liveSession.agent.state.messages).toEqual(rebuild(branch.sessionManager));
  });
});
