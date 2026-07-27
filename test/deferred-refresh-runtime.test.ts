import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionSyncOutcome,
  LiveAgentSessionAdapter,
} from "../src/live-agent-session-adapter.js";
import { buildGaugeSuffix } from "../src/context-gauge.js";
import { formatContextUsagePressure, type ContextUsagePressure } from "../src/context-pressure.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerAcmLifecycle } from "../src/runtime-lifecycle.js";
import { ANCHOR_SEARCH_WINDOW } from "../src/lib.js";
import { AcmSessionRuntime } from "../src/runtime.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

type TimelineResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    authoritativeContextPressure: ContextUsagePressure | null;
    persistentMutationApplied: boolean;
    providerDeliveryPhase: string;
  };
};

type TimelineExecute = (
  id: string,
  params: { view: "active" },
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: ExtensionContext,
) => Promise<TimelineResult>;

function captureTimelineExecute(runtime: AcmSessionRuntime): TimelineExecute {
  let execute: TimelineExecute | undefined;
  const pi = {
    registerTool(tool: { execute?: TimelineExecute }) {
      execute = tool.execute;
    },
    getCommands: () => [],
  } as unknown as ExtensionAPI;
  registerTimelineTool(pi, runtime);
  if (!execute) throw new Error("timeline execute handler was not registered");
  return execute;
}

function gaugeText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("gauge result did not contain content");
  }
  const part = result.content[0];
  if (
    !part
    || typeof part !== "object"
    || !("type" in part)
    || part.type !== "text"
    || !("text" in part)
    || typeof part.text !== "string"
  ) throw new Error("gauge result did not contain a text part");
  return part.text;
}

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

function finalizedTravelResult(toolCallId: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "acm_travel",
    content: [{ type: "text", text: isError ? "Travel failed" : "Travel complete" }],
    isError,
    details: isError
      ? { error: "rewritten_by_later_handler" }
      : {
          mutationStatus: "applied",
          handoffFormat: "structured-v1",
          resultingLeafId: "finalized-travel-leaf",
        },
    timestamp: 2,
  };
}

function createSession(id: string) {
  const entry = persistedUserEntry(id, `persisted ${id}`);
  return {
    getLeafId: () => id,
    getEntries: () => [entry],
    getBranch: () => [entry],
  };
}

type TimelineSession = {
  getLeafId(): string;
  getTree(): Array<{ entry: SessionEntry; children: [] }>;
  getEntries(): SessionEntry[];
  getBranch(): SessionEntry[];
};

function createTimelineSession(id: string): TimelineSession {
  const entry = persistedUserEntry(id, `persisted ${id}`);
  return {
    getLeafId: () => id,
    getTree: () => [{ entry, children: [] }],
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

function poisonedCompactionSession(entryCount = 402) {
  const root = persistedUserEntry("poisoned-compact-root", "safe baseline");
  const unclosedBatch = {
    id: "poisoned-compact-unclosed",
    type: "message",
    parentId: root.id,
    timestamp: "2026-07-21T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "poisoned-compact-read", name: "read", arguments: { path: "stuck.txt" } }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as SessionEntry;
  // The host strips bare dangling calls; this stale result keeps later
  // host-projected prefixes protocol-repaired rather than complete.
  const staleOrphanResult = {
    id: "poisoned-compact-orphan-result",
    type: "message",
    parentId: unclosedBatch.id,
    timestamp: "2026-07-21T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "poisoned-compact-missing",
      toolName: "read",
      content: [{ type: "text", text: "interrupted result" }],
      isError: true,
      timestamp: 2,
    },
  } as SessionEntry;
  const entries: SessionEntry[] = [root, unclosedBatch, staleOrphanResult];
  for (let index = 3; index < entryCount; index++) {
    const parent = entries.at(-1);
    if (!parent) throw new Error("poisoned compaction fixture lost its parent");
    entries.push({
      id: `poisoned-compact-${index}`,
      type: "message",
      parentId: parent.id,
      timestamp: "2026-07-21T00:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: `later message ${index}` }], timestamp: index },
    } as SessionEntry);
  }
  let appendCalls = 0;
  let candidatePrefixReads = 0;
  return {
    session: {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getEntries: () => entries,
      getBranch: (fromId?: string) => {
        if (fromId === undefined) return entries;
        candidatePrefixReads++;
        const candidateIndex = entries.findIndex((entry) => entry.id === fromId);
        return candidateIndex < 0 ? [] : entries.slice(0, candidateIndex + 1);
      },
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendLabelChange: () => {
        appendCalls++;
        return "must-not-append-poisoned-compaction-label";
      },
    },
    getAppendCalls: () => appendCalls,
    getCandidatePrefixReads: () => candidatePrefixReads,
  };
}

function createLifecycleFixture(
  runtime: AcmSessionRuntime,
  sessionManager: object,
  contextUsage?: { tokens: number; contextWindow: number; percent: number },
) {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let idle: boolean | "throw" = true;
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    sendMessage() {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  registerAcmLifecycle(pi, runtime);
  const context = {
    sessionManager,
    getContextUsage: () => contextUsage,
    hasPendingMessages: () => false,
    isIdle() {
      if (idle === "throw") throw new Error("idle state unavailable");
      return idle;
    },
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  return {
    context,
    appendedEntries,
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
  test("cuts the provider to the persisted packet after the matching tool result but before native settlement", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("provider-cutover-leaf");
    const fixture = createLifecycleFixture(runtime, session);
    const stale = [{ role: "user" as const, content: "204K raw investigation payload", timestamp: 1 }];

    runtime.deferPostTravelRefresh(session, "provider-cutover-call", "provider-cutover-leaf");
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");

    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "provider-cutover-call",
      isError: false,
      input: { handoff: { goal: "g", state: "s", evidence: "e", external: "x", exclusions: "n", recover: "r", next: "n" } },
      details: { handoffFormat: "structured-v1", resultingLeafId: "provider-cutover-leaf" },
    });

    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
    const provider = await fixture.emit("context", {
      messages: [...stale, finalizedTravelResult("provider-cutover-call")],
    }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(provider.messages)).toContain("persisted provider-cutover-leaf");
    expect(JSON.stringify(provider.messages)).not.toContain("204K raw investigation payload");
    expect(runtime.getContextDeliveryPhase(session)).toBe("provider_active_native_pending");
    expect(adapter.applied).toEqual([]);
  });

  test("does not authorize cutover from the interceptable tool_result when the finalized message is later rewritten to an error", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("final-error-leaf");
    const fixture = createLifecycleFixture(runtime, session);
    const stale = [{ role: "user" as const, content: "retain current provider messages", timestamp: 1 }];

    runtime.deferPostTravelRefresh(session, "final-error-call", "final-error-leaf");
    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "final-error-call",
      isError: false,
      input: {},
      details: { mutationStatus: "applied", handoffFormat: "structured-v1", resultingLeafId: "final-error-leaf" },
    });
    const result = await fixture.emit("context", {
      messages: [...stale, finalizedTravelResult("final-error-call", true)],
    }) as { messages?: AgentMessage[] } | undefined;

    expect(runtime.getContextDeliveryPhase(session)).toBe("receipt_rejected");
    expect(result?.messages ?? stale).toEqual(stale);
    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    await fixture.emit("agent_settled");
    const afterSettlement = await fixture.emit("context", {
      messages: [...stale, finalizedTravelResult("final-error-call", true)],
    }) as { messages?: AgentMessage[] } | undefined;

    expect(JSON.stringify(afterSettlement?.messages ?? stale)).toContain("retain current provider messages");
    expect(JSON.stringify(afterSettlement?.messages ?? stale)).not.toContain("persisted final-error-leaf");
    expect(adapter.applied).toEqual([]);
  });

  test("rejects a finalized non-error receipt that lost its trusted applied evidence", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("final-untrusted-leaf");
    const fixture = createLifecycleFixture(runtime, session);
    const stale = [{ role: "user" as const, content: "retain current context after untrusted receipt", timestamp: 1 }];

    runtime.deferPostTravelRefresh(session, "final-untrusted-call", "final-untrusted-leaf");
    const result = await fixture.emit("context", {
      messages: [...stale, {
        role: "toolResult",
        toolCallId: "final-untrusted-call",
        toolName: "acm_travel",
        content: [{ type: "text", text: "later extension stripped applied details" }],
        details: { rewrittenByLaterExtension: true },
        isError: false,
        timestamp: 2,
      }],
    }) as { messages?: AgentMessage[] };

    expect(result.messages).toEqual(stale);
    expect(runtime.getContextDeliveryPhase(session)).toBe("receipt_rejected");
    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
  });

  test("keeps the last compact provider packet during a later rebuild failure instead of re-expanding raw origin messages", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const entry = persistedUserEntry("cached-provider-leaf", "compact persisted packet");
    let failRead = false;
    let failedReadCount = 0;
    const session = {
      getLeafId: () => entry.id,
      getEntries: () => {
        if (failRead) {
          failedReadCount++;
          throw new Error("later persistence read failed");
        }
        return [entry];
      },
      getBranch: () => [entry],
    };
    const fixture = createLifecycleFixture(runtime, session, {
      tokens: 90_000,
      contextWindow: 100_000,
      percent: 90,
    });
    const stale = [{ role: "user" as const, content: "204K raw origin history", timestamp: 1 }];

    runtime.deferPostTravelRefresh(session, "cache-cutover", entry.id);
    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "cache-cutover",
      isError: false,
      input: { handoff: { goal: "g", state: "s", evidence: "e", external: "x", exclusions: "n", recover: "r", next: "n" } },
      details: { handoffFormat: "structured-v1", resultingLeafId: entry.id },
    });
    const finalizedSource = [...stale, finalizedTravelResult("cache-cutover")];
    const first = await fixture.emit("context", { messages: finalizedSource }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(first.messages)).toContain("compact persisted packet");

    const laterUser = { role: "user" as const, content: "later user must keep priority during cached fallback", timestamp: 2 };
    failRead = true;
    const cached = await fixture.emit("context", { messages: [...finalizedSource, laterUser] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(cached.messages)).toContain(laterUser.content);
    expect(JSON.stringify(cached.messages)).not.toContain("204K raw origin history");
    expect(runtime.getContextDeliveryPhase(session)).toBe("provider_active_native_pending");
    expect(runtime.getProviderDeliveryStatus(session)).toMatchObject({
      phase: "active",
      packetMessageCount: first.messages.length + 1,
      error: "Failed to read session state: later persistence read failed",
    });
    expect(runtime.contextRefresh.isPending(session)).toBe(true);

    // Cached delivery exhausts exactly three persistent reads. The fourth
    // context uses the protocol-valid cache without another read or warning.
    await fixture.emit("context", { messages: [...finalizedSource, laterUser] });
    await fixture.emit("context", { messages: [...finalizedSource, laterUser] });
    await fixture.emit("context", { messages: [...finalizedSource, laterUser] });
    expect(runtime.contextRefresh.getAttemptCount(session)).toBe(3);
    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    expect(failedReadCount).toBe(3);
    expect(runtime.getProviderDeliveryStatus(session).phase).toBe("cached_exhausted");
    const notificationsAfterExhaustion = fixture.notifications.length;

    failRead = false;
    const exhausted = await fixture.emit("context", { messages: [...finalizedSource, laterUser] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(exhausted.messages)).toContain(laterUser.content);
    expect(failedReadCount).toBe(3);
    expect(fixture.notifications).toHaveLength(notificationsAfterExhaustion);
    expect(runtime.getProviderDeliveryStatus(session).error).toContain("later persistence read failed");

    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(runtime.getUsage(session)).toEqual({
      tokens: 20_000,
      contextWindow: 100_000,
      percent: 20,
    });
    expect(fixture.appendedEntries).toEqual([]);
  });

  test("falls back to current protocol-valid messages on cached prefix drift so later user and tool work are not lost", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const entry = persistedUserEntry("prefix-drift-leaf", "compact persisted packet");
    let failRead = false;
    const session = {
      getLeafId: () => entry.id,
      getEntries: () => {
        if (failRead) throw new Error("prefix drift persistence failure");
        return [entry];
      },
      getBranch: () => [entry],
    };
    const fixture = createLifecycleFixture(runtime, session);
    const initialSource = [
      { role: "user" as const, content: "raw origin prefix", timestamp: 1 },
      finalizedTravelResult("prefix-drift-call"),
    ];

    runtime.deferPostTravelRefresh(session, "prefix-drift-call", entry.id);
    await fixture.emit("context", { messages: initialSource });
    failRead = true;
    const drifted = [
      { role: "user" as const, content: "different provider prefix", timestamp: 3 },
      { role: "user" as const, content: "later user survives drift", timestamp: 4 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "later-read", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 5,
      },
      {
        role: "toolResult" as const,
        toolCallId: "later-read",
        toolName: "read",
        content: [{ type: "text" as const, text: "later tool result survives drift" }],
        isError: false,
        timestamp: 6,
      },
    ];
    const fallback = await fixture.emit("context", { messages: drifted }) as { messages: AgentMessage[] };
    const serialized = JSON.stringify(fallback.messages);

    expect(serialized).toContain("later user survives drift");
    expect(serialized).toContain("later tool result survives drift");
    expect(serialized).not.toContain("compact persisted packet");
    expect(runtime.getProviderDeliveryStatus(session).phase).toBe("fallback");
  });

  test("drops a malformed drifted assistant but preserves later user and valid tool work during cached fallback", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const entry = persistedUserEntry("invalid-drift-leaf", "compact persisted packet");
    let failRead = false;
    const session = {
      getLeafId: () => entry.id,
      getEntries: () => {
        if (failRead) throw new Error("invalid drift persistence failure");
        return [entry];
      },
      getBranch: () => [entry],
    };
    const fixture = createLifecycleFixture(runtime, session);
    const initialSource = [
      { role: "user" as const, content: "raw origin prefix", timestamp: 1 },
      finalizedTravelResult("invalid-drift-call"),
    ];

    runtime.deferPostTravelRefresh(session, "invalid-drift-call", entry.id);
    await fixture.emit("context", { messages: initialSource });
    failRead = true;
    const drifted = [
      { role: "user" as const, content: "later user survives invalid drift", timestamp: 3 },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "", name: "broken", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 4,
      },
      {
        role: "toolResult" as const,
        toolCallId: "broken-result",
        toolName: "broken",
        content: [{ type: "text" as const, text: "orphan from malformed assistant" }],
        isError: false,
        timestamp: 5,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "later-read", name: "read", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 6,
      },
      {
        role: "toolResult" as const,
        toolCallId: "later-read",
        toolName: "read",
        content: [{ type: "text" as const, text: "valid later tool result" }],
        isError: false,
        timestamp: 7,
      },
    ];

    const fallback = await fixture.emit("context", { messages: drifted }) as { messages: AgentMessage[] };
    const serialized = JSON.stringify(fallback.messages);
    expect(serialized).toContain("later user survives invalid drift");
    expect(serialized).toContain("valid later tool result");
    expect(serialized).not.toContain("orphan from malformed assistant");
    expect(serialized).not.toContain("compact persisted packet");
    expect(runtime.getProviderDeliveryStatus(session).phase).toBe("fallback");
  });

  test("a repeated travel drops the prior packet and only its latest receipt can authorize provider cutover", () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = {};
    const packet = [{ role: "user", content: "first compact packet", timestamp: 1 }] as AgentMessage[];

    runtime.deferPostTravelRefresh(session, "first-travel", "first-leaf");
    expect(runtime.markProviderCutoverReady(session, "first-travel")).toBe(true);
    expect(runtime.activateProviderPacket(session, packet, "first-leaf")).toBe(true);
    runtime.deferPostTravelRefresh(session, "second-travel", "second-leaf");

    expect(runtime.getProviderDeliveryStatus(session)).toEqual({
      persistentMutationApplied: true,
      phase: "pending_tool_result",
      packetMessageCount: null,
      leafId: null,
      error: null,
      usageObserved: false,
    });
    expect(runtime.markProviderCutoverReady(session, "first-travel")).toBe(false);
    expect(runtime.markProviderCutoverReady(session, "second-travel")).toBe(true);
    expect(runtime.getProviderDeliveryStatus(session).phase).toBe("ready");
  });

  test("keeps both provider and native delivery pending when no finalized receipt arrives", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("persisted-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    expect(runtime.deferPostTravelRefresh(session, "travel-call", "traveled-leaf")).toEqual({ status: "pending" });
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
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
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
    expect(adapter.applied).toEqual([]);

    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");

    const firstLaterContext = await fixture.emit("context", { messages: [] });
    expect(firstLaterContext).toBeUndefined();
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
    expect(fixture.notifications).toEqual([]);
  });

  test("repairs a historical orphan and synthesizes the current result while the finalized receipt is absent", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("orphaned-pre-settlement-leaf");
    const fixture = createLifecycleFixture(runtime, session);
    const outgoing = [
      { role: "user" as const, content: "request before fold", timestamp: 1 },
      { role: "branchSummary" as const, summary: "persisted fold", fromId: "root", timestamp: 2 },
      {
        role: "toolResult" as const,
        toolCallId: "historical-read",
        toolName: "read",
        content: [{ type: "text" as const, text: "late persisted result" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "current-travel", name: "acm_travel", arguments: {} }],
        stopReason: "toolUse" as const,
        timestamp: 4,
      },
    ];

    runtime.deferPostTravelRefresh(session, "current-travel", "traveled-leaf");
    const result = await fixture.emit("context", { messages: outgoing }) as { messages: typeof outgoing };

    expect(result.messages).toEqual([
      outgoing[0],
      outgoing[1],
      outgoing[3],
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "current-travel",
        toolName: "acm_travel",
        isError: true,
      }),
    ]);
    expect(JSON.stringify(result.messages)).toContain("Interrupted by context travel");
    expect(outgoing).toHaveLength(4);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
    expect(adapter.applied).toEqual([]);
    expect(runtime.contextRefresh.isPending(session)).toBe(true);

    const resultWithoutCall = await fixture.emit("context", {
      messages: [outgoing[2]],
    }) as { messages: typeof outgoing };
    expect(resultWithoutCall.messages).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");

    const invalidSameRun = await fixture.emit("context", {
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", id: "duplicate-current", name: "read", arguments: {} },
          { type: "toolCall", id: "duplicate-current", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: 6,
      }],
    });
    expect(invalidSameRun).toEqual({
      messages: [expect.objectContaining({
        role: "custom",
        customType: "acm:protocol-recovery",
        display: false,
        details: { kind: "acm-protocol-recovery", reason: "no_protocol_valid_messages" },
      })],
    });
    expect(JSON.stringify(invalidSameRun)).not.toContain("duplicate-current");
    expect(fixture.notifications.at(-1)).toContain("Unexpected invalid same-run tool protocol");
    expect(fixture.notifications.at(-1)).toContain("duplicate_tool_call_id");
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
  });

  test("keeps the travel ticket pending until agent_settled can prove the session is idle", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("idle-guard-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "idle-guard-call", "traveled-leaf");
    runtime.markProviderCutoverReady(session, "idle-guard-call");
    fixture.setIdle(false);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("ready");

    fixture.setIdle("throw");
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("ready");

    fixture.setIdle(true);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual(["idle-guard-call"]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("ready");
  });

  test("does not apply native settlement when the finalized receipt cannot be read", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    let receiptReadable = false;
    const rejectedReceipt = {
      id: "settled-read-error-result",
      type: "message",
      parentId: null,
      timestamp: "2026-07-21T00:00:01.000Z",
      message: finalizedTravelResult("settled-read-error", true),
    } as SessionEntry;
    const session = {
      getLeafId: () => rejectedReceipt.id,
      getEntries: () => [rejectedReceipt],
      getBranch: () => {
        if (!receiptReadable) throw new Error("receipt branch temporarily unavailable");
        return [rejectedReceipt];
      },
    };
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "settled-read-error", rejectedReceipt.id);
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("pending_tool_result");
    expect(fixture.notifications.at(-1)).toContain("finalized travel receipt could not be inspected");

    receiptReadable = true;
    await fixture.emit("agent_settled");
    expect(adapter.applied).toEqual([]);
    expect(runtime.getContextDeliveryPhase(session)).toBe("receipt_rejected");
  });

  test("keeps a rejected receipt diagnostic without claiming provider delivery", () => {
    const runtime = new AcmSessionRuntime(createAdapter());
    const session = {};

    runtime.deferPostTravelRefresh(session, "rejected-receipt", "rejected-leaf");
    expect(runtime.rejectProviderCutover(session, "rejected-receipt")).toBe(true);

    expect(runtime.getProviderDeliveryStatus(session)).toMatchObject({
      persistentMutationApplied: false,
      phase: "receipt_rejected",
    });
  });

  test("keeps gauge and timeline authoritative pressure aligned", async () => {
    const hostUsage = { tokens: 70_000, contextWindow: 100_000, percent: 70 };
    const scenarios: Array<{
      name: string;
      prepare(runtime: AcmSessionRuntime, session: TimelineSession): void;
      pressurePercent: number;
      applied: boolean;
      phase: string;
      pressureAuthority: "provider actual" | "native context";
    }> = [
      {
        name: "no travel",
        prepare() {},
        pressurePercent: 70,
        applied: false,
        phase: "active",
        pressureAuthority: "native context",
      },
      {
        name: "provider active with observed usage",
        prepare(runtime, session) {
          runtime.deferPostTravelRefresh(session, "provider-observed", session.getLeafId());
          runtime.markProviderCutoverReady(session, "provider-observed");
          runtime.activateProviderPacket(
            session,
            [{ role: "user", content: "compact provider packet", timestamp: 1 }],
            session.getLeafId(),
          );
          runtime.setUsage(session, { tokens: 300_000, contextWindow: 1_000_000, percent: 30 });
          runtime.markProviderUsageObserved(session);
        },
        pressurePercent: 75,
        applied: true,
        phase: "active",
        pressureAuthority: "provider actual",
      },
      {
        name: "rejected receipt",
        prepare(runtime, session) {
          runtime.deferPostTravelRefresh(session, "provider-rejected", session.getLeafId());
          runtime.rejectProviderCutover(session, "provider-rejected");
        },
        pressurePercent: 70,
        applied: false,
        phase: "receipt_rejected",
        pressureAuthority: "native context",
      },
    ];

    for (const scenario of scenarios) {
      const runtime = new AcmSessionRuntime(createAdapter());
      const session = createTimelineSession(`pressure-${scenario.name.replaceAll(" ", "-")}`);
      scenario.prepare(runtime, session);
      const lifecycle = createLifecycleFixture(runtime, session, hostUsage);
      const timelineExecute = captureTimelineExecute(runtime);

      const gauge = await lifecycle.emit("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "read complete" }],
      });
      const timeline = await timelineExecute("pressure-timeline", { view: "active" }, undefined, undefined, lifecycle.context);
      const pressure = timeline.details.authoritativeContextPressure;

      expect(pressure).not.toBeNull();
      expect(pressure?.pressurePercent).toBe(scenario.pressurePercent);
      // The pressure needles must agree with the timeline's authoritative
      // reading. Fold needles are projections appended after them, so compare
      // the pressure prefix instead of the whole suffix.
      const expectedPressureNeedles = buildGaugeSuffix(pressure!).replace(/\]$/, "");
      expect(gaugeText(gauge)).toStartWith(`read complete${expectedPressureNeedles}`);
      expect(timeline.content[0]?.text).toContain(
        `• ACM Pressure:     ${formatContextUsagePressure(pressure!)} (${scenario.pressureAuthority})`,
      );
      expect(timeline.details).toMatchObject({
        persistentMutationApplied: scenario.applied,
        providerDeliveryPhase: scenario.phase,
      });
    }
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
    const fixture = createLifecycleFixture(runtime, session, {
      tokens: 1_000,
      contextWindow: 100_000,
      percent: 1,
    });

    runtime.deferPostTravelRefresh(session, "rebuild-retry-call", "traveled-leaf");
    runtime.markProviderCutoverReady(session, "rebuild-retry-call");
    await fixture.emit("agent_settled");
    expect(runtime.getContextDeliveryPhase(session)).toBe("ready");

    const failed = await fixture.emit("context", { messages: [{ role: "user", content: "retain live message" }] });
    expect(failed).toEqual({ messages: [{ role: "user", content: "retain live message" }] });
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("fallback");
    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 55_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(fixture.appendedEntries).toEqual([]);

    failRebuild = false;
    const rebuilt = await fixture.emit("context", { messages: [] }) as { messages: Array<{ role: string; content?: unknown }> };
    expect(JSON.stringify(rebuilt.messages)).toContain("persisted after retry");
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("provider_active_native_applied");
    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(fixture.appendedEntries).toEqual([]);
  });

  test("refuses an invalid persisted packet without consuming the settled delivery retry", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createProtocolInvalidSession("invalid-protocol-leaf");
    const fixture = createLifecycleFixture(runtime, session);

    runtime.deferPostTravelRefresh(session, "invalid-protocol-call", "traveled-leaf");
    runtime.markProviderCutoverReady(session, "invalid-protocol-call");
    await fixture.emit("agent_settled");
    const liveMessages = [{ role: "user", content: "retain live messages until the protocol is repaired" }];

    const result = await fixture.emit("context", { messages: liveMessages });

    expect(result).toEqual({ messages: liveMessages });
    expect(runtime.contextRefresh.isPending(session)).toBe(true);
    expect(runtime.getContextDeliveryPhase(session)).toBe("fallback");
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
    runtime.markProviderCutoverReady(session, "exhausted-call");
    await fixture.emit("agent_settled");
    for (let attempt = 0; attempt < 3; attempt++) {
      await fixture.emit("context", { messages: [] });
    }

    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    expect(runtime.getContextDeliveryPhase(session)).toBe("fallback");
  });

  test("anchors the pre-compaction checkpoint after a completed regular tool batch", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const user = persistedUserEntry("pre-compact-user", "read the file");
    const assistant = {
      id: "pre-compact-assistant",
      type: "message",
      parentId: user.id,
      timestamp: "2026-07-21T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.txt" } }],
        stopReason: "toolUse",
        timestamp: 1,
      },
    } as SessionEntry;
    const result = {
      id: "pre-compact-result",
      type: "message",
      parentId: assistant.id,
      timestamp: "2026-07-21T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "important completed evidence" }],
        timestamp: 2,
      },
    } as SessionEntry;
    const entries: SessionEntry[] = [user, assistant, result];
    let checkpointTarget: string | undefined;
    const session = {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getEntries: () => entries,
      getBranch: () => entries,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendLabelChange(targetId: string, label: string | undefined) {
        checkpointTarget = targetId;
        const entry = {
          id: "pre-compact-label",
          type: "label",
          parentId: result.id,
          timestamp: "2026-07-21T00:00:03.000Z",
          targetId,
          label,
        } as SessionEntry;
        entries.push(entry);
        return entry.id;
      },
    };
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(checkpointTarget).toBe(result.id);
  });

  test("skips and warns when bounded pre-compaction anchoring cannot find a complete prefix", async () => {
    const runtime = new AcmSessionRuntime(createAdapter());
    const { session, getAppendCalls, getCandidatePrefixReads } = poisonedCompactionSession();
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(getAppendCalls()).toBe(0);
    expect(getCandidatePrefixReads()).toBeLessThanOrEqual(ANCHOR_SEARCH_WINDOW);
    expect(getCandidatePrefixReads()).toBe(ANCHOR_SEARCH_WINDOW);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toContain("No pre-compaction checkpoint was created");
    expect(fixture.notifications[0]).toContain(`within the last ${ANCHOR_SEARCH_WINDOW} entries`);
  });

  test("invalidates provider usage and resets the gauge when the model changes", async () => {
    const adapter = createAdapter();
    const runtime = new AcmSessionRuntime(adapter);
    const session = createSession("model-select-leaf");
    const fixture = createLifecycleFixture(runtime, session, {
      tokens: 90_000,
      contextWindow: 100_000,
      percent: 90,
    });
    runtime.deferPostTravelRefresh(session, "model-select-travel", "model-select-leaf");
    runtime.markProviderCutoverReady(session, "model-select-travel");
    runtime.activateProviderPacket(
      session,
      [{ role: "user", content: "compact provider packet", timestamp: 1 }],
      "model-select-leaf",
    );
    runtime.setUsage(session, { tokens: 300_000, contextWindow: 1_000_000, percent: 30 });
    runtime.markProviderUsageObserved(session);
    expect(runtime.shouldShowGaugeNow(session, 75)).toBe(true);
    runtime.confirmGaugeShown(session, 75);

    await fixture.emit("model_select", {});

    expect(runtime.getUsage(session)).toBeUndefined();
    expect(runtime.getProviderDeliveryStatus(session).usageObserved).toBe(false);
    const patch = await fixture.emit("tool_result", {
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "done" }],
    }) as { content: Array<{ type: "text"; text: string }> };
    // Pressure needles must match the timeline's authoritative reading. Fold
    // needles may follow in the same suffix, so assert the pressure prefix
    // rather than the whole bracket.
    expect(patch.content[0]?.text).toContain("[ctx 90% window");
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
    expect(runtime.markProviderCutoverReady(session, "travel-two")).toBe(true);
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

    expect(runtime.getContextDeliveryPhase(first)).toBe("pending_tool_result");
    expect(runtime.getContextDeliveryPhase(second)).toBe("pending_tool_result");
    expect(runtime.getContextDeliveryPhase(failedOrIndeterminate)).toBe("active");
    expect(runtime.settleDeferredRefresh(failedOrIndeterminate)).toBeUndefined();

    runtime.markProviderCutoverReady(first, "first-call");
    runtime.settleDeferredRefresh(first);
    expect(adapter.applied).toEqual(["first-call"]);
    expect(runtime.getContextDeliveryPhase(first)).toBe("ready");
    expect(runtime.getContextDeliveryPhase(second)).toBe("pending_tool_result");
    expect(runtime.contextRefresh.isPending(failedOrIndeterminate)).toBe(true);

    runtime.clear(second);
    expect(runtime.getContextDeliveryPhase(second)).toBe("active");
    expect(adapter.clearCalls).toBeGreaterThan(0);
  });
});
