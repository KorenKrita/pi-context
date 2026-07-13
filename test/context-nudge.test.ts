import { describe, expect, test } from "bun:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "../src/index";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function createFixture(sessionManager: object = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  let usagePercent = 1;

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
  } as unknown as ExtensionAPI;

  registerAcmExtension(pi);

  const context = {
    sessionManager,
    getContextUsage: () => ({
      tokens: usagePercent * 1_000,
      contextWindow: 100_000,
      percent: usagePercent,
    }),
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
    tools,
    setUsagePercent(value: number) {
      usagePercent = value;
    },
  };
}

describe("ACM context usage reminders", () => {
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
    expect(fixture.sentMessages[0]?.message.content).toContain("Travel is optional");

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
    expect(fixture.sentMessages[0]?.message.content).toContain("actively look for the next safe opportunity");
    expect(fixture.sentMessages[0]?.message.content).toContain("Travel is recommended");
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
