import { describe, expect, test } from "bun:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "../src/index";
import { calculateContextUsagePressure } from "../src/context-usage-nudge";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function createFixture(sessionManager: object = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let contextUsage = { tokens: 1_000, contextWindow: 100_000, percent: 1 };
  let pendingMessages = false;
  let signal: AbortSignal | undefined;

  const pi = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
      const appendCustomEntry = (sessionManager as { appendCustomEntry?: (type: string, value: unknown) => string })
        .appendCustomEntry;
      if (typeof appendCustomEntry === "function") appendCustomEntry.call(sessionManager, customType, data);
    },
  } as unknown as ExtensionAPI;

  registerAcmExtension(pi);

  const context = {
    sessionManager,
    getContextUsage: () => ({ ...contextUsage }),
    hasPendingMessages: () => pendingMessages,
    get signal() {
      return signal;
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;

  const emit = async (event: string, data: object = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler({ type: event, ...data }, context);
    }
    return result;
  };

  return {
    context,
    emit,
    sentMessages,
    appendedEntries,
    tools,
    setPendingMessages(value: boolean) {
      pendingMessages = value;
    },
    setSignal(value: AbortSignal | undefined) {
      signal = value;
    },
    setUsagePercent(value: number) {
      contextUsage = {
        ...contextUsage,
        tokens: (value / 100) * contextUsage.contextWindow,
        percent: value,
      };
    },
    setContextUsage(tokens: number, contextWindow: number, percent = (tokens / contextWindow) * 100) {
      contextUsage = { tokens, contextWindow, percent };
    },
  };
}

describe("ACM context usage reminders", () => {
  test("steers a successful travel directly into the handoff NEXT", async () => {
    const fixture = createFixture();
    const handoff = {
      goal: "continue the latency investigation",
      state: "pool max=50 and retry commit=9f31c2a are hot",
      evidence: "findings.md",
      external: "none",
      exclusions: "database indexes are healthy",
      recover: "payments-latency-raw",
      next: "write next-action.md from the carried hot facts",
    };

    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "travel-success",
      input: { target: "payments-latency-findings", handoff },
      content: [],
      isError: false,
      details: {
        handoffFormat: "structured-v1",
        resultingLeafId: "summary-1",
        currentUserTurnOpen: true,
      },
    });

    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]).toMatchObject({
      message: {
        customType: "acm:post-travel-continuation",
        display: false,
        details: {
          kind: "post-travel-continuation",
          toolCallId: "travel-success",
          resultingLeafId: "summary-1",
          next: handoff.next,
          currentUserTurnOpen: true,
        },
      },
      options: { deliverAs: "steer" },
    });
    expect(fixture.sentMessages[0]?.message.content).toContain(`REQUIRED NEXT: ${handoff.next}`);
    expect(fixture.sentMessages[0]?.message.content).toContain("Earlier pre-travel requests are historical");
    expect(fixture.sentMessages[0]?.message.content).toContain("Evidence and Recover are optional receipts");
    expect(fixture.sentMessages[0]?.message.content).toContain("CURRENT USER TURN IS STILL OPEN");
  });

  test("does not steer failed or domain-rejected travel results", async () => {
    const fixture = createFixture();
    const input = {
      target: "root",
      handoff: {
        goal: "continue",
        state: "known",
        evidence: "none",
        external: "none",
        exclusions: "none",
        recover: "none",
        next: "act",
      },
    };

    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "transport-error",
      input,
      content: [],
      isError: true,
      details: {},
    });
    await fixture.emit("tool_result", {
      toolName: "acm_travel",
      toolCallId: "domain-error",
      input,
      content: [],
      isError: false,
      details: { error: "mixed_tool_batch" },
    });

    expect(fixture.sentMessages).toHaveLength(0);
  });

  test("does not append an old NEXT behind a pending user message or aborted run", async () => {
    const fixture = createFixture();
    const event = {
      toolName: "acm_travel",
      input: {
        target: "root",
        handoff: {
          goal: "continue",
          state: "known",
          evidence: "none",
          external: "none",
          exclusions: "none",
          recover: "none",
          next: "write the old next action",
        },
      },
      content: [],
      isError: false,
      details: { handoffFormat: "structured-v1", resultingLeafId: "summary-1" },
    };

    fixture.setPendingMessages(true);
    await fixture.emit("tool_result", { ...event, toolCallId: "pending-user" });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setPendingMessages(false);
    const controller = new AbortController();
    controller.abort();
    fixture.setSignal(controller.signal);
    await fixture.emit("tool_result", { ...event, toolCallId: "aborted" });
    expect(fixture.sentMessages).toHaveLength(0);
  });

  test("caps only windows above the 400K boundary", () => {
    expect(calculateContextUsagePressure(120_000, 400_000)).toMatchObject({
      workingBudgetTokens: 400_000,
      pressurePercent: 30,
      policy: "actual-window",
    });
    expect(calculateContextUsagePressure(120_000, 400_001)).toMatchObject({
      workingBudgetTokens: 400_000,
      pressurePercent: 30,
      policy: "400k-cap",
    });
  });
  test("sends only the highest newly reached tier as a hidden steering message", async () => {
    const fixture = createFixture();

    fixture.setUsagePercent(30);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });

    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]).toMatchObject({
      message: {
        customType: "acm:context-usage-reminder",
        display: false,
        details: { kind: "context-usage-reminder", level: 30 },
      },
      options: { deliverAs: "steer" },
    });
    expect(fixture.sentMessages[0]?.message.content).toContain("[ACM Context Reminder · 30% tier]");
    expect(fixture.sentMessages[0]?.message.content).toContain("comfortable cruise range");
    expect(fixture.sentMessages[0]?.message.content).toContain("Run ACM Judgment");
    expect(fixture.sentMessages[0]?.message.content).toContain("acm_checkpoint");
    expect(fixture.sentMessages[0]?.message.content).toContain("acm_timeline");
    expect(fixture.sentMessages[0]?.message.content).not.toContain("fold that raw process into a cold-start handoff now");

    fixture.setUsagePercent(35);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    fixture.setUsagePercent(71);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });

    expect(fixture.sentMessages).toHaveLength(2);
    expect(fixture.sentMessages[1]?.message.details).toMatchObject({ level: 70 });
    expect(fixture.sentMessages[1]?.message.content).toContain("[ACM Context Reminder · 70% tier · Final reminder]");
    expect(fixture.sentMessages[1]?.message.content).toContain("attention is scarce");
    expect(fixture.sentMessages[1]?.message.content).toContain("native compaction");
    expect(fixture.sentMessages[1]?.message.content).toContain("positive net effect");
    expect(fixture.sentMessages[1]?.message.content).not.toContain("acm_travel at the next safe moment");
    expect(fixture.sentMessages.some(({ message }) => message.details?.level === 50)).toBe(false);
  });

  test("uses a 400K working-budget cap for larger model windows", async () => {
    const fixture = createFixture();

    fixture.setContextUsage(119_999, 1_000_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setContextUsage(120_000, 1_000_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({
      level: 30,
      tokens: 120_000,
      contextWindow: 1_000_000,
      usagePercent: 12,
      workingBudgetTokens: 400_000,
      pressurePercent: 30,
      policy: "400k-cap",
    });
    expect(fixture.sentMessages[0]?.message.content).toContain("30.0% (120K / 400K working budget)");
    expect(fixture.sentMessages[0]?.message.content).toContain("Hard context usage is 12.0% (120K / 1M model window)");

    fixture.setContextUsage(200_000, 1_000_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });
    fixture.setContextUsage(280_000, 1_000_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-4", content: [], isError: false });

    expect(fixture.sentMessages.map(({ message }) => message.details.level)).toEqual([30, 50, 70]);
  });

  test("uses the actual model window at or below 400K", async () => {
    const fixture = createFixture();

    fixture.setContextUsage(104_999, 350_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setContextUsage(105_000, 350_000);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({
      level: 30,
      usagePercent: 30,
      workingBudgetTokens: 350_000,
      pressurePercent: 30,
      policy: "actual-window",
    });
  });

  test("shows hard-window usage and ACM pressure separately in the timeline HUD", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const fixture = createFixture(sessionManager);
    fixture.setContextUsage(280_000, 1_000_000);

    const timeline = fixture.tools.get("acm_timeline");
    const result = await timeline.execute(
      "timeline-1",
      { view: "active" },
      undefined,
      undefined,
      fixture.context,
    );
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Context Usage:    28.0% (280.0K/1.0M) (official hard window)");
    expect(text).toContain("ACM Pressure:     70.0% (280K / 400K working budget; 400K cap)");
    expect(result.details.contextPressure).toMatchObject({
      pressurePercent: 70,
      workingBudgetTokens: 400_000,
      policy: "400k-cap",
    });
    expect(result.details.contextPressure.usagePercent).toBeCloseTo(28);
  });

  test("ordinary usage drops do not rearm tiers, while compaction starts a baseline-only cycle", async () => {
    const fixture = createFixture();

    fixture.setUsagePercent(30);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });

    fixture.setUsagePercent(20);
    await fixture.emit("context", { messages: [] });
    fixture.setUsagePercent(31);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    await fixture.emit("session_compact", { reason: "threshold" });
    fixture.setUsagePercent(55);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);
    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 55_000, cacheRead: 0, cacheWrite: 0 },
      },
    });

    fixture.setUsagePercent(71);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-4", content: [], isError: false });

    expect(fixture.sentMessages).toHaveLength(2);
    expect(fixture.sentMessages[1]?.message.details).toMatchObject({ level: 70 });
  });

  test("uses a hidden follow-up when a pending reminder reaches a normally stopped agent", async () => {
    const fixture = createFixture();

    fixture.setUsagePercent(50);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [] }],
    });

    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]).toMatchObject({
      message: {
        customType: "acm:context-usage-reminder",
        display: false,
        details: { level: 50 },
      },
      options: { deliverAs: "followUp" },
    });
    expect(fixture.sentMessages[0]?.message.content).toContain("Compression Candidate");
    expect(fixture.sentMessages[0]?.message.content).toContain("best expected task effect");
    expect(fixture.sentMessages[0]?.message.content).toContain("acm_timeline");
  });

  test("manual tree navigation clears pending reminders and starts a baseline-only cycle", async () => {
    const fixture = createFixture();

    fixture.setUsagePercent(50);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("session_tree", { newLeafId: "node-1", oldLeafId: "node-9" });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setUsagePercent(65);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    fixture.setUsagePercent(31);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({ level: 30 });
  });

  test("a successful travel starts a new baseline-only reminder cycle", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "work to archive", timestamp: Date.now() });
    const fixture = createFixture(sessionManager);

    fixture.setUsagePercent(30);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    const travelTool = fixture.tools.get("acm_travel");
    expect(travelTool).toBeDefined();
    const travelResult = await travelTool.execute(
      "travel-1",
      {
        target: rootId,
        handoff: {
          goal: "verify reminder reset after travel",
          state: "travel completed",
          evidence: "lifecycle test",
          external: "none",
          exclusions: "none",
          recover: "root",
          next: "continue testing context reminders",
        },
      },
      undefined,
      undefined,
      fixture.context,
    );
    expect(travelResult.details?.error).toBeUndefined();

    fixture.setUsagePercent(75);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    // The travel's landing estimate (~30%) seeds the cycle baseline: the first
    // real sample (28K) still establishes and persists the baseline, but the
    // seeded tier — not the sample's tier — becomes highestReachedLevel, so
    // 31% does not re-remind and the next reminder waits for the 50% tier.
    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 28_000, cacheRead: 0, cacheWrite: 0 },
      },
    });

    fixture.setUsagePercent(31);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    fixture.setUsagePercent(55);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-4", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(2);
    expect(fixture.sentMessages[1]?.message.details).toMatchObject({ level: 50 });
  });

  test("a travel-seeded baseline keeps tiers above the landing point armed despite same-turn regrowth", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "work to archive", timestamp: Date.now() });
    const fixture = createFixture(sessionManager);

    fixture.setUsagePercent(45);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);

    const travelTool = fixture.tools.get("acm_travel");
    expect(travelTool).toBeDefined();
    const travelResult = await travelTool.execute(
      "travel-1",
      {
        target: rootId,
        handoff: {
          goal: "verify seeded baseline after travel",
          state: "travel completed",
          evidence: "lifecycle test",
          external: "none",
          exclusions: "none",
          recover: "root",
          next: "continue testing context reminders",
        },
      },
      undefined,
      undefined,
      fixture.context,
    );
    expect(travelResult.details?.error).toBeUndefined();

    // Same-turn regrowth: the first real post-transition sample already sits at
    // 52%, but the landing estimate (~45%) seeded tier 30 — the baseline must
    // record 30, not the sampled 50.
    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 52_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(fixture.appendedEntries).toContainEqual({
      customType: "acm:context-usage-state",
      data: expect.objectContaining({ kind: "context-usage-baseline", highestReachedLevel: 30 }),
    });

    // The 50% tier was never reminded in this cycle, so crossing it fires.
    fixture.setUsagePercent(55);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(2);
    expect(fixture.sentMessages[1]?.message.details).toMatchObject({ level: 50 });
  });

  test("a native tree-navigation summary is a cycle boundary on restore", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
    sessionManager.appendCustomMessageEntry(
      "acm:context-usage-reminder",
      "stale 50% reminder from the abandoned branch",
      false,
      { kind: "context-usage-reminder", level: 50, usagePercent: 55 },
    );
    // Native /tree navigation with summarize: branch summary without ACM details.
    sessionManager.branchWithSummary(rootId, "Goal: retry from root", { readFiles: [], modifiedFiles: [] });
    const fixture = createFixture(sessionManager);

    await fixture.emit("session_start", { reason: "reload" });
    fixture.setUsagePercent(55);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    fixture.setUsagePercent(31);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({ level: 30 });
  });

  test("persists an established post-transition baseline across reload", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendCompaction("compacted work", rootId, 80_000);
    const beforeReload = createFixture(sessionManager);

    await beforeReload.emit("session_start", { reason: "reload" });
    await beforeReload.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(beforeReload.appendedEntries).toContainEqual({
      customType: "acm:context-usage-state",
      data: {
        kind: "context-usage-baseline",
        highestReachedLevel: 0,
        tokens: 20_000,
        contextWindow: 100_000,
        usagePercent: 20,
        workingBudgetTokens: 100_000,
        pressurePercent: 20,
        policy: "actual-window",
      },
    });

    const afterReload = createFixture(sessionManager);
    await afterReload.emit("session_start", { reason: "reload" });
    afterReload.setUsagePercent(35);
    await afterReload.emit("context", { messages: [] });
    await afterReload.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });

    expect(afterReload.sentMessages).toHaveLength(1);
    expect(afterReload.sentMessages[0]?.message.details).toMatchObject({ level: 30 });
  });

  test("restores the tier reached by a persisted post-transition baseline", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendCompaction("compacted work", rootId, 80_000);
    sessionManager.appendCustomEntry("acm:context-usage-state", {
      kind: "context-usage-baseline",
      highestReachedLevel: 50,
      usagePercent: 55,
    });
    const fixture = createFixture(sessionManager);

    await fixture.emit("session_start", { reason: "reload" });
    fixture.setUsagePercent(60);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setUsagePercent(71);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({ level: 70 });
  });

  test("restores the highest delivered tier when a session resumes", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "existing work", timestamp: Date.now() });
    sessionManager.appendCustomMessageEntry(
      "acm:context-usage-reminder",
      "persisted 30% reminder",
      false,
      { kind: "context-usage-reminder", level: 30, usagePercent: 30 },
    );
    const fixture = createFixture(sessionManager);

    await fixture.emit("session_start", { reason: "resume" });
    fixture.setUsagePercent(35);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-1", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(0);

    fixture.setUsagePercent(50);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-2", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(1);
    expect(fixture.sentMessages[0]?.message.details).toMatchObject({ level: 50 });
  });
});
