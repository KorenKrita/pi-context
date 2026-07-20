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
  goal: "exercise repeated live synchronization",
  state,
  evidence: "capability host fixture",
  external: "none",
  exclusions: "none",
  recover: "repeat-sync-done",
  next: "continue from the resulting branch",
});

function acmMessages(sessionManager: SessionManager): AgentMessage[] {
  const result = rebuildAcmContextPacket(sessionManager);
  if (!result.ok) throw new Error(result.message);
  return result.value.messages;
}

afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
    getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
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

describe("repeated travel, restoration, and resume", () => {
  test("supersedes stale pending work and converges repeated travel to the latest leaf", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "first abandoned path", timestamp: Date.now() });
    const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
    const { context, handlers, timelineTool, travelTool } = createFixture(sessionManager);
    const liveSession = captureLiveSession(sessionManager, staleMessages);

    await travelTool.execute("travel-1", { target: rootId, handoff: handoff("first travel") }, undefined, undefined, context);
    const firstLeaf = sessionManager.getLeafId();
    await travelTool.execute("travel-2", { target: rootId, handoff: handoff("second travel") }, undefined, undefined, context);
    const latestLeaf = sessionManager.getLeafId();
    expect(latestLeaf).not.toBe(firstLeaf);

    await emit(handlers, "tool_execution_end", { toolCallId: "travel-1", toolName: "acm_travel" }, context);
    expect(liveSession.agent.state.messages).toBe(staleMessages);
    await emit(handlers, "tool_execution_end", { toolCallId: "travel-2", toolName: "acm_travel" }, context);

    expect(liveSession.agent.state.messages).toEqual(acmMessages(sessionManager));
    const serialized = JSON.stringify(liveSession.agent.state.messages);
    expect(serialized).toContain("second travel");
    expect(serialized).not.toContain("first travel");
    expect(serialized).not.toContain("first abandoned path");
    const timeline = await timelineTool.execute("timeline", { view: "active" }, undefined, undefined, context);
    expect(timeline.details).toMatchObject({
      liveAgentSessionSyncState: "applied",
      liveAgentSessionSync: { leafId: latestLeaf },
    });
  });

  test("restores an off-path checkpoint and synchronizes the expanded branch", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const archivedId = sessionManager.appendMessage({ role: "user", content: "archived detail", timestamp: Date.now() });
    sessionManager.appendLabelChange(archivedId, "archived-path");
    const { context, handlers, travelTool } = createFixture(sessionManager);
    const liveSession = captureLiveSession(
      sessionManager,
      sessionManager.buildSessionContext().messages as AgentMessage[],
    );

    await travelTool.execute("shrink", { target: rootId, handoff: handoff("shrunk") }, undefined, undefined, context);
    await emit(handlers, "tool_execution_end", { toolCallId: "shrink", toolName: "acm_travel" }, context);
    expect(JSON.stringify(liveSession.agent.state.messages)).not.toContain("archived detail");

    await travelTool.execute("restore", { target: "archived-path", handoff: handoff("restored") }, undefined, undefined, context);
    await emit(handlers, "tool_execution_end", { toolCallId: "restore", toolName: "acm_travel" }, context);

    expect(liveSession.agent.state.messages).toEqual(acmMessages(sessionManager));
    expect(JSON.stringify(liveSession.agent.state.messages)).toContain("archived detail");
    expect(sessionManager.getEntry(archivedId)).toBeDefined();
  });

  test("session start, compaction, and shutdown clear only their pending synchronization", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };

    for (const eventName of ["session_start", "session_compact", "session_shutdown"] as const) {
      const sessionManager = SessionManager.inMemory();
      const rootId = sessionManager.appendMessage({ role: "user", content: `${eventName} root`, timestamp: Date.now() });
      sessionManager.appendMessage({ role: "user", content: `${eventName} abandoned`, timestamp: Date.now() });
      const staleMessages = sessionManager.buildSessionContext().messages as AgentMessage[];
      const fixture = createFixture(sessionManager);
      const liveSession = captureLiveSession(sessionManager, staleMessages);

      await fixture.travelTool.execute(
        `${eventName}-travel`,
        { target: rootId, handoff: handoff(`${eventName} pending`) },
        undefined,
        undefined,
        fixture.context,
      );
      const pending = await fixture.timelineTool.execute(
        `${eventName}-pending`,
        { view: "active" },
        undefined,
        undefined,
        fixture.context,
      );
      expect(pending.details).toMatchObject({ liveAgentSessionSyncState: "pending" });

      await emit(fixture.handlers, eventName, {}, fixture.context);
      await emit(
        fixture.handlers,
        "tool_execution_end",
        { toolCallId: `${eventName}-travel`, toolName: "acm_travel" },
        fixture.context,
      );

      expect(liveSession.agent.state.messages).toBe(staleMessages);
      const cleared = await fixture.timelineTool.execute(
        `${eventName}-cleared`,
        { view: "active" },
        undefined,
        undefined,
        fixture.context,
      );
      expect(cleared.details).toMatchObject({
        liveAgentSessionSyncState: "skipped",
        liveAgentSessionSync: { status: "skipped", reason: "not_pending" },
      });
    }
  });

  test("persists the active leaf, resumes with a new session identity, and clears lifecycle state", async () => {
    AgentSession.prototype.getContextUsage = function () {
      return { tokens: 1000, contextWindow: 100_000, percent: 1 };
    };
    const directory = mkdtempSync(join(tmpdir(), "pi-context-live-sync-"));
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
    const { context, handlers, timelineTool, travelTool } = createFixture(sessionManager);
    captureLiveSession(sessionManager, sessionManager.buildSessionContext().messages as AgentMessage[]);

    await travelTool.execute("persist", { target: rootId, handoff: handoff("persisted travel") }, undefined, undefined, context);
    await emit(handlers, "tool_execution_end", { toolCallId: "persist", toolName: "acm_travel" }, context);
    const expectedMessages = acmMessages(sessionManager);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Expected a persisted session file");

    await emit(handlers, "session_shutdown", {}, context);
    const cleared = await timelineTool.execute("cleared", { view: "active" }, undefined, undefined, context);
    expect(cleared.details).toMatchObject({ liveAgentSessionSyncState: "skipped" });

    const resumedManager = SessionManager.open(sessionFile, directory, directory);
    expect(acmMessages(resumedManager)).toEqual(expectedMessages);
    const resumedFixture = createFixture(resumedManager);
    const resumedSession = captureLiveSession(resumedManager, [{ role: "user", content: "stale resumed state", timestamp: Date.now() }]);
    await emit(resumedFixture.handlers, "session_start", {}, resumedFixture.context);

    const restoreTarget = resumedManager.getBranch()[0]?.id;
    if (!restoreTarget) throw new Error("Expected a resumed branch root");
    await resumedFixture.travelTool.execute(
      "resume-travel",
      { target: restoreTarget, handoff: handoff("resumed travel") },
      undefined,
      undefined,
      resumedFixture.context,
    );
    await emit(
      resumedFixture.handlers,
      "tool_execution_end",
      { toolCallId: "resume-travel", toolName: "acm_travel" },
      resumedFixture.context,
    );
    expect(resumedSession.agent.state.messages).toEqual(acmMessages(resumedManager));
    expect(JSON.stringify(resumedSession.agent.state.messages)).not.toContain("stale resumed state");
  });
});
