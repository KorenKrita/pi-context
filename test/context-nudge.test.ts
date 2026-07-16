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
    expect(fixture.sentMessages[0]?.message.content).toContain("next natural semantic boundary");
    expect(fixture.sentMessages[0]?.message.content).toContain("decision smells");
    expect(fixture.sentMessages[0]?.message.content).toContain("fold criteria");
    expect(fixture.sentMessages[0]?.message.content).toContain("working-set invariant");

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
    expect(fixture.sentMessages[1]?.message.content).toContain("earliest safe semantic boundary");
    expect(fixture.sentMessages[1]?.message.content).toContain("native compaction is acceptable");
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
    expect(fixture.sentMessages[0]?.message.content).toContain("Raise the priority of a rebase check");
    expect(fixture.sentMessages[0]?.message.content).toContain("Travel earns its place only when");
    expect(fixture.sentMessages[0]?.message.content).toContain("recognizable moment");
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
        summary: [
          "Goal: verify reminder reset after travel",
          "State: travel completed",
          "Evidence: lifecycle test",
          "External: none",
          "Exclusions: none",
          "Recover: root",
          "NEXT: continue testing context reminders",
        ].join("\n"),
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

    await fixture.emit("turn_end", {
      message: {
        role: "assistant",
        usage: { input: 28_000, cacheRead: 0, cacheWrite: 0 },
      },
    });

    fixture.setUsagePercent(31);
    await fixture.emit("context", { messages: [] });
    await fixture.emit("tool_result", { toolName: "read", toolCallId: "read-3", content: [], isError: false });
    expect(fixture.sentMessages).toHaveLength(2);
    expect(fixture.sentMessages[1]?.message.details).toMatchObject({ level: 30 });
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
