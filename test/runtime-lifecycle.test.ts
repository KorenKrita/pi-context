import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { rebuildAcmContextPacket } from "../src/context-packet.js";
import { registerAcmLifecycle } from "../src/runtime-lifecycle.js";
import { ANCHOR_SEARCH_WINDOW } from "../src/conventions.js";
import { AcmSessionRuntime } from "../src/runtime.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

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
  let checkpointTarget: string | undefined;
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
      appendLabelChange: (targetId: string, label: string | undefined) => {
        appendCalls++;
        checkpointTarget = targetId;
        const entry = {
          id: `poisoned-compact-label-${appendCalls}`,
          type: "label",
          parentId: entries.at(-1)?.id,
          timestamp: "2026-07-21T00:10:00.000Z",
          targetId,
          label,
        } as SessionEntry;
        entries.push(entry);
        return entry.id;
      },
    },
    getAppendCalls: () => appendCalls,
    getCheckpointTarget: () => checkpointTarget,
    getCandidatePrefixReads: () => candidatePrefixReads,
    resetCandidatePrefixReads: () => { candidatePrefixReads = 0; },
  };
}

function invalidCompactionSession(entryCount = ANCHOR_SEARCH_WINDOW + 2) {
  const root = persistedUserEntry("invalid-compact-root", "safe baseline");
  const invalidAssistant = {
    id: "invalid-compact-assistant",
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
  const entries: SessionEntry[] = [root, invalidAssistant];
  for (let index = 2; index < entryCount; index++) {
    const parent = entries.at(-1);
    if (!parent) throw new Error("invalid compaction fixture lost its parent");
    entries.push({
      id: `invalid-compact-${index}`,
      type: "message",
      parentId: parent.id,
      timestamp: "2026-07-21T00:00:02.000Z",
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
        return "must-not-append-invalid-compaction-label";
      },
    },
    newestCandidateId: entries.at(-1)?.id ?? "",
    getAppendCalls: () => appendCalls,
    getCandidatePrefixReads: () => candidatePrefixReads,
    resetCandidatePrefixReads: () => { candidatePrefixReads = 0; },
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

describe("runtime lifecycle", () => {
  test("anchors the pre-compaction checkpoint after a completed regular tool batch", async () => {
    const runtime = new AcmSessionRuntime();
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

  test("anchors the pre-compaction checkpoint to the newest repaired prefix when the bounded window has no complete prefix", async () => {
    const runtime = new AcmSessionRuntime();
    const {
      session,
      getAppendCalls,
      getCheckpointTarget,
      getCandidatePrefixReads,
      resetCandidatePrefixReads,
    } = poisonedCompactionSession();
    const newestCandidateId = session.getLeafId();
    if (!newestCandidateId) throw new Error("poisoned compaction fixture has no leaf");
    const newestPacket = rebuildAcmContextPacket(session, newestCandidateId);
    expect(newestPacket.ok).toBe(true);
    if (!newestPacket.ok) throw new Error(newestPacket.message);
    expect(newestPacket.value.protocol.status).toBe("repaired");
    resetCandidatePrefixReads();
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(getAppendCalls()).toBe(1);
    expect(getCheckpointTarget()).toBe(newestCandidateId);
    expect(getCandidatePrefixReads()).toBe(ANCHOR_SEARCH_WINDOW);
    expect(fixture.notifications).toEqual([]);
  });

  test("prefers an older complete pre-compaction prefix over a newer repaired prefix", async () => {
    const runtime = new AcmSessionRuntime();
    const { session, getCheckpointTarget, resetCandidatePrefixReads } = poisonedCompactionSession(ANCHOR_SEARCH_WINDOW);
    const newestCandidateId = session.getLeafId();
    if (!newestCandidateId) throw new Error("poisoned compaction fixture has no leaf");
    const newestPacket = rebuildAcmContextPacket(session, newestCandidateId);
    expect(newestPacket.ok).toBe(true);
    if (!newestPacket.ok) throw new Error(newestPacket.message);
    expect(newestPacket.value.protocol.status).toBe("repaired");
    const rootPacket = rebuildAcmContextPacket(session, "poisoned-compact-root");
    expect(rootPacket.ok).toBe(true);
    if (!rootPacket.ok) throw new Error(rootPacket.message);
    expect(rootPacket.value.protocol.status).toBe("complete");
    resetCandidatePrefixReads();
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(getCheckpointTarget()).toBe("poisoned-compact-root");
    expect(fixture.notifications).toEqual([]);
  });

  test("skips a build-failed candidate and anchors to the next rebuildable repaired prefix", async () => {
    const runtime = new AcmSessionRuntime();
    const { session, getAppendCalls, getCheckpointTarget, resetCandidatePrefixReads } = poisonedCompactionSession();
    const failedCandidateId = session.getLeafId();
    if (!failedCandidateId) throw new Error("poisoned compaction fixture has no leaf");
    const fallbackCandidateId = session.getEntries().at(-2)?.id;
    if (!fallbackCandidateId) throw new Error("poisoned compaction fixture has no fallback candidate");
    const failedPacket = rebuildAcmContextPacket(session, failedCandidateId);
    expect(failedPacket.ok).toBe(true);
    if (!failedPacket.ok) throw new Error(failedPacket.message);
    expect(failedPacket.value.protocol.status).toBe("repaired");
    const originalGetBranch = session.getBranch.bind(session);
    let failedReads = 0;
    session.getBranch = (fromId?: string) => {
      if (fromId === failedCandidateId) {
        failedReads++;
        throw new Error("simulated host read failure");
      }
      return originalGetBranch(fromId);
    };
    resetCandidatePrefixReads();
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(failedReads).toBeGreaterThanOrEqual(1);
    expect(getAppendCalls()).toBe(1);
    expect(getCheckpointTarget()).toBe(fallbackCandidateId);
    expect(fixture.notifications).toEqual([]);
  });

  test("skips empty repaired packets and warns when the pre-compaction window rebuilds nothing", async () => {
    const runtime = new AcmSessionRuntime();
    // Orphan-only spine: every bounded-window prefix repairs to zero
    // messages (the repair removes the only message each prefix has), so no
    // candidate is a lawful anchor even though every rebuild is ok+repaired.
    const entries: SessionEntry[] = [];
    for (let index = 0; index < ANCHOR_SEARCH_WINDOW + 2; index++) {
      const parent = entries.at(-1);
      entries.push({
        type: "message",
        id: `orphan-compact-${index}`,
        parentId: parent?.id ?? "root",
        timestamp: "2026-07-21T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: `missing-call-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `stale ${index}` }],
          isError: true,
          timestamp: index,
        },
      } as SessionEntry);
    }
    let appendCalls = 0;
    let candidatePrefixReads = 0;
    const session = {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getEntries: () => entries,
      getBranch: (fromId?: string) => {
        if (fromId === undefined) return entries;
        candidatePrefixReads++;
        const stopIndex = entries.findIndex((entry) => entry.id === fromId);
        return stopIndex < 0 ? [] : entries.slice(0, stopIndex + 1);
      },
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendLabelChange: () => {
        appendCalls++;
        return "must-not-append-orphan-compact-label";
      },
    };
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(appendCalls).toBe(0);
    expect(candidatePrefixReads).toBe(ANCHOR_SEARCH_WINDOW);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toContain("No pre-compaction checkpoint was created");
    expect(fixture.notifications[0]).toContain("can rebuild a lawful context packet");
  });


  test("warns when the bounded pre-compaction window has no rebuildable prefix", async () => {
    const runtime = new AcmSessionRuntime();
    const {
      session,
      newestCandidateId,
      getAppendCalls,
      getCandidatePrefixReads,
      resetCandidatePrefixReads,
    } = invalidCompactionSession();
    const newestPacket = rebuildAcmContextPacket(session, newestCandidateId);
    expect(newestPacket.ok).toBe(true);
    if (!newestPacket.ok) throw new Error(newestPacket.message);
    expect(newestPacket.value.protocol.status).toBe("invalid");
    resetCandidatePrefixReads();
    const fixture = createLifecycleFixture(runtime, session);

    await fixture.emit("session_before_compact", {});

    expect(getAppendCalls()).toBe(0);
    expect(getCandidatePrefixReads()).toBeLessThanOrEqual(ANCHOR_SEARCH_WINDOW);
    expect(getCandidatePrefixReads()).toBe(ANCHOR_SEARCH_WINDOW);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toContain("No pre-compaction checkpoint was created");
    expect(fixture.notifications[0]).toContain("can rebuild a lawful context packet");
    expect(fixture.notifications[0]).toContain(`${ANCHOR_SEARCH_WINDOW}`);
  });

  test("resets the gauge cycle when the model changes", async () => {
    const runtime = new AcmSessionRuntime();
    const session = createSession("model-select-leaf");
    const fixture = createLifecycleFixture(runtime, session, {
      tokens: 90_000,
      contextWindow: 100_000,
      percent: 90,
    });
    expect(runtime.shouldShowGaugeNow(session, 90)).toBe(true);
    runtime.confirmGaugeShown(session, 90);
    expect(runtime.shouldShowGaugeNow(session, 90)).toBe(false);

    await fixture.emit("model_select", {});

    const patch = await fixture.emit("tool_result", {
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "done" }],
    }) as { content: Array<{ type: "text"; text: string }> };
    expect(patch.content[0]?.text).toContain("[ctx 90% window · 90K/100K");
  });

  test("fold needles reach the tool result end to end", async () => {
    // The needles are only useful if they arrive on ordinary tool results.
    // Source-level inventory cannot prove the wiring; this asserts delivery
    // through the real tool_result path with a two-turn spine, which is also
    // the shape that exposes turn-reference selection.
    const runtime = new AcmSessionRuntime();
    const mk = (id: string, parentId: string | null, role: string, text: string, ts: number) => ({
      id,
      type: "message",
      parentId,
      timestamp: `2026-07-21T00:00:0${ts}.000Z`,
      message: role === "toolResult"
        ? { role, toolCallId: `c-${id}`, toolName: "read", content: [{ type: "text", text }], timestamp: ts }
        : { role, content: text, timestamp: ts },
    }) as unknown as SessionEntry;
    // Turn 1 delivered; turn 2 just arrived. The reference a fold at this
    // boundary needs is turn 1's start, not turn 2's own opening line.
    const entries: SessionEntry[] = [
      mk("u1", null, "user", "first request", 0),
      mk("a1", "u1", "assistant", "x".repeat(4000), 1),
      mk("r1", "a1", "toolResult", "y".repeat(4000), 2),
      mk("u2", "r1", "user", "second, unrelated request", 3),
    ];
    const session = {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getEntries: () => entries,
      getBranch: (id?: string) => (id ? entries.slice(0, entries.findIndex((e) => e.id === id) + 1) : entries),
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
    };
    const fixture = createLifecycleFixture(runtime, session, {
      tokens: 90_000,
      contextWindow: 1_000_000,
      percent: 9,
    });

    const patch = await fixture.emit("tool_result", {
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "done" }],
    }) as { content: Array<{ type: "text"; text: string }> } | undefined;

    const text = patch?.content[0]?.text ?? "";
    expect(text).toContain("[ctx ");
    // At least one gain needle must be delivered, with a floored integer.
    expect(text).toMatch(/fold@(turn|task)→\d+%/);
  });

  test("fold aggregates cache by key, bound targets, and drop on clear", () => {
    const runtime = new AcmSessionRuntime();
    const session = {};
    let rebuilds = 0;
    const aggregate = { tokenCount: 10, messageCount: 2 };
    const build = () => {
      rebuilds += 1;
      return aggregate;
    };

    // Cold current: one rebuild, then warm hits rebuild nothing.
    expect(runtime.foldAggregate(session, { kind: "current", leafId: "leaf-1", entriesLength: 5, lastEntryId: "e5" }, build)).toEqual(aggregate);
    expect(runtime.foldAggregate(session, { kind: "current", leafId: "leaf-1", entriesLength: 5, lastEntryId: "e5" }, build)).toEqual(aggregate);
    expect(rebuilds).toBe(1);

    // Any append (length, last id) or branch move (leaf) changes the key.
    runtime.foldAggregate(session, { kind: "current", leafId: "leaf-1", entriesLength: 6, lastEntryId: "e6" }, build);
    expect(rebuilds).toBe(2);
    runtime.foldAggregate(session, { kind: "current", leafId: "leaf-9", entriesLength: 6, lastEntryId: "e6" }, build);
    expect(rebuilds).toBe(3);

    // A failed rebuild is not negatively cached: the next render retries.
    let failNext = true;
    const flaky = () => (failNext ? undefined : { tokenCount: 1, messageCount: 1 });
    expect(runtime.foldAggregate(session, { kind: "target", entryId: "t1" }, flaky)).toBeUndefined();
    failNext = false;
    expect(runtime.foldAggregate(session, { kind: "target", entryId: "t1" }, flaky)).toEqual({ tokenCount: 1, messageCount: 1 });

    // Target cache is a real LRU bounded at 8: refreshing the oldest entry
    // must protect it, evicting the least-recently-used one instead.
    const targetIds = ["t-a", "t-b", "t-c", "t-d", "t-e", "t-f", "t-g", "t-h"];
    for (const entryId of targetIds) {
      runtime.foldAggregate(session, { kind: "target", entryId }, build);
    }
    expect(rebuilds).toBe(11); // 3 current rebuilds + 8 targets (the flaky closure never counted)
    runtime.foldAggregate(session, { kind: "target", entryId: "t-a" }, build); // hit refreshes recency
    expect(rebuilds).toBe(11);
    runtime.foldAggregate(session, { kind: "target", entryId: "t-i" }, build); // evicts t-b, not t-a
    expect(rebuilds).toBe(12);
    runtime.foldAggregate(session, { kind: "target", entryId: "t-a" }, build); // survived: was recently used
    expect(rebuilds).toBe(12);
    runtime.foldAggregate(session, { kind: "target", entryId: "t-b" }, build); // evicted: least recently used
    expect(rebuilds).toBe(13);
    const before = rebuilds;

    // clear() drops the whole per-session cache but keeps the ledger join.
    const ledgerBefore = runtime.ledgerState(session);
    runtime.clear(session);
    expect(runtime.ledgerState(session)).toBe(ledgerBefore);
    runtime.foldAggregate(session, { kind: "current", leafId: "leaf-9", entriesLength: 6, lastEntryId: "e6" }, build);
    expect(rebuilds).toBe(before + 1);
  });

  test("fold projections cache compact entries, cover the checkpoints budget, and drop on clear", () => {
    const runtime = new AcmSessionRuntime();
    const session = {};
    let rebuilds = 0;
    const projection = { aggregate: { tokenCount: 7, messageCount: 3 }, projectedSummaryDepth: 2 };
    const build = () => {
      rebuilds += 1;
      return projection;
    };

    // Cold current rebuilds once; warm hits rebuild nothing; key changes miss.
    expect(runtime.foldProjection(session, { kind: "current", leafId: "leaf-1", entriesLength: 5, lastEntryId: "e5" }, build)).toEqual(projection);
    expect(runtime.foldProjection(session, { kind: "current", leafId: "leaf-1", entriesLength: 5, lastEntryId: "e5" }, build)).toEqual(projection);
    expect(rebuilds).toBe(1);
    runtime.foldProjection(session, { kind: "current", leafId: "leaf-1", entriesLength: 6, lastEntryId: "e6" }, build);
    expect(rebuilds).toBe(2);

    // A failed rebuild is not negatively cached.
    let failNext = true;
    const flaky = () => (failNext ? undefined : projection);
    expect(runtime.foldProjection(session, { kind: "target", entryId: "t1" }, flaky)).toBeUndefined();
    failNext = false;
    expect(runtime.foldProjection(session, { kind: "target", entryId: "t1" }, flaky)).toEqual(projection);

    // The target capacity covers the checkpoints view's full result-entry
    // budget (400) with headroom: no thrash across two full sweeps.
    const budget = 400;
    for (let index = 0; index < budget; index++) {
      runtime.foldProjection(session, { kind: "target", entryId: `t-${index}` }, build);
    }
    const afterSweep = rebuilds;
    for (let index = 0; index < budget; index++) {
      runtime.foldProjection(session, { kind: "target", entryId: `t-${index}` }, build);
    }
    expect(rebuilds).toBe(afterSweep); // every second-sweep entry hit

    // clear() drops the projection cache alongside the aggregates.
    runtime.clear(session);
    runtime.foldProjection(session, { kind: "target", entryId: "t-0" }, build);
    expect(rebuilds).toBe(afterSweep + 1);
  });

  test("fold projections evict least-recently-used beyond the limit and stay per-session", () => {
    const runtime = new AcmSessionRuntime();
    const sessionA = {};
    const sessionB = {};
    let rebuilds = 0;
    const build = () => {
      rebuilds += 1;
      return { aggregate: { tokenCount: 1, messageCount: 1 }, projectedSummaryDepth: 1 };
    };

    // Fill exactly to the 512-entry limit with "a" refreshed (recent) and
    // "b" stale, then insert one more: eviction must remove "b" (least
    // recently used), never "a". An unbounded or FIFO map fails one arm.
    runtime.foldProjection(sessionA, { kind: "target", entryId: "a" }, build);
    runtime.foldProjection(sessionA, { kind: "target", entryId: "b" }, build);
    runtime.foldProjection(sessionA, { kind: "target", entryId: "a" }, build); // refresh recency
    for (let index = 0; index < 510; index++) {
      runtime.foldProjection(sessionA, { kind: "target", entryId: `bulk-${index}` }, build);
    }
    runtime.foldProjection(sessionA, { kind: "target", entryId: "overflow" }, build); // evicts b
    const rebuildsAtLimit = rebuilds;
    runtime.foldProjection(sessionA, { kind: "target", entryId: "a" }, build); // survived: was recent
    expect(rebuilds).toBe(rebuildsAtLimit);
    runtime.foldProjection(sessionA, { kind: "target", entryId: "b" }, build); // evicted: was stale
    expect(rebuilds).toBe(rebuildsAtLimit + 1);

    // Per-session isolation: session B has its own cache and its own miss.
    runtime.foldProjection(sessionB, { kind: "target", entryId: "shared-id" }, build);
    expect(rebuilds).toBe(rebuildsAtLimit + 2);
    // ...and clearing one session leaves the other intact.
    runtime.clear(sessionB);
    runtime.foldProjection(sessionB, { kind: "target", entryId: "shared-id" }, build);
    expect(rebuilds).toBe(rebuildsAtLimit + 3);
    runtime.foldProjection(sessionA, { kind: "target", entryId: "a" }, build);
    expect(rebuilds).toBe(rebuildsAtLimit + 3); // A untouched by B's clear
  });


  test("label maps cache by entry key and drop on clear", () => {
    const runtime = new AcmSessionRuntime();
    const session = {};
    let replays = 0;
    const replay = () => {
      replays += 1;
      return { entryToLabel: new Map(), labelToEntry: new Map() } as never;
    };
    const entriesOf = (ids: readonly string[]) =>
      ids.map((id) => ({ type: "label", id, targetId: "t", label: `l-${id}` })) as never as readonly never[];

    // Cold replay, warm hit on the same key, miss on any append.
    runtime.labelMapsFor(session, entriesOf(["e1", "e2"]), replay);
    runtime.labelMapsFor(session, entriesOf(["e1", "e2"]), replay);
    expect(replays).toBe(1);
    runtime.labelMapsFor(session, entriesOf(["e1", "e2", "e3"]), replay);
    expect(replays).toBe(2);

    // clear() drops the cache; the ledger join state survives as before.
    runtime.clear(session);
    runtime.labelMapsFor(session, entriesOf(["e1", "e2", "e3"]), replay);
    expect(replays).toBe(3);
  });
});
