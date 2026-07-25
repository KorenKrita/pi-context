import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "../src/index";
import { READ_BURST_THRESHOLD } from "../src/acm-trigger-detector";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function createFixture(sessionManager: object = { getBranch: () => [], getEntries: () => [] }) {
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  let contextUsage = { tokens: 1_000, contextWindow: 100_000, percent: 1 };

  const pi = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool() {},
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;

  registerAcmExtension(pi);

  const context = {
    sessionManager,
    getContextUsage: () => ({ ...contextUsage }),
    hasPendingMessages: () => false,
    ui: { notify() {} },
  } as unknown as ExtensionContext;

  const emit = async (event: string, data: object = {}) => {
    // Chain like the host: merge partial results across handlers so a
    // systemPrompt patch from prompt registration does not mask a message.
    let result: Record<string, unknown> | undefined;
    for (const handler of handlers.get(event) ?? []) {
      const partial = await handler({ type: event, ...data }, context);
      if (partial !== undefined && typeof partial === "object") {
        result = { ...result, ...(partial as Record<string, unknown>) };
      }
    }
    return result;
  };

  return {
    emit,
    sentMessages,
    setUsagePercent(value: number) {
      contextUsage = { ...contextUsage, tokens: (value / 100) * contextUsage.contextWindow, percent: value };
    },
  };
}

const textResult = (text = "file contents") => [{ type: "text" as const, text }];

async function drainReads(fixture: ReturnType<typeof createFixture>, count: number) {
  const patches: unknown[] = [];
  for (let call = 0; call < count; call++) {
    patches.push(await fixture.emit("tool_result", {
      toolName: "read",
      toolCallId: `read-${call}`,
      input: {},
      content: textResult(),
      isError: false,
    }));
  }
  return patches;
}

describe("trigger lifecycle wiring", () => {
  test("burst cue lands as an in-place suffix on the threshold read result", async () => {
    const fixture = createFixture();
    const patches = await drainReads(fixture, READ_BURST_THRESHOLD + 2);
    const patchedIndexes = patches
      .map((patch, index) => (patch === undefined ? -1 : index))
      .filter((index) => index >= 0);
    expect(patchedIndexes).toEqual([READ_BURST_THRESHOLD - 1]);
    const patch = patches[READ_BURST_THRESHOLD - 1] as { content: { type: string; text: string }[] };
    expect(patch.content[0]!.text).toContain("file contents");
    expect(patch.content[0]!.text).toContain(`[ACM · ${READ_BURST_THRESHOLD} consecutive reads`);
    expect(patch.content[0]!.text).toContain("no save point on this spine");
  });

  test("gauge suffix appears above 30% with a full delta and moves its baseline", async () => {
    const fixture = createFixture();
    fixture.setUsagePercent(25);
    let patch = await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b1", input: {}, content: textResult(), isError: false });
    expect(patch).toBeUndefined();

    fixture.setUsagePercent(41);
    // First mark the 30% tier reminder consumed so the suffix path is reachable.
    await fixture.emit("context", { messages: [] });
    patch = await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b2", input: {}, content: textResult(), isError: false });
    // The pending 30% tier reminder wins arbitration on this result.
    expect(patch).toBeUndefined();
    expect(fixture.sentMessages.at(-1)?.message.customType).toBe("acm:context-usage-reminder");

    patch = await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b3", input: {}, content: textResult(), isError: false });
    const text = (patch as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain("[ctx: 41.0%");
    expect(text).toContain("50% tier in 9pp");

    // Within the delta band: silent.
    fixture.setUsagePercent(45);
    patch = await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b4", input: {}, content: textResult(), isError: false });
    expect(patch).toBeUndefined();
  });

  test("acm tool results and error results are never decorated", async () => {
    const fixture = createFixture();
    fixture.setUsagePercent(48);
    await fixture.emit("context", { messages: [] });
    // Consume the tier reminder.
    await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b0", input: {}, content: textResult(), isError: false });
    const acmPatch = await fixture.emit("tool_result", { toolName: "acm_checkpoint", toolCallId: "c1", input: {}, content: textResult(), isError: false });
    expect(acmPatch).toBeUndefined();
    const errorPatch = await fixture.emit("tool_result", { toolName: "bash", toolCallId: "b5", input: {}, content: textResult(), isError: true });
    expect(errorPatch).toBeUndefined();
  });

  test("new-request cue fires once per cycle, hidden, and rearms only via a save point", async () => {
    const fixture = createFixture();
    // Substantial un-checkpointed work.
    for (let call = 0; call < 9; call++) {
      await fixture.emit("tool_result", { toolName: "bash", toolCallId: `w${call}`, input: {}, content: textResult(), isError: false });
    }
    const first = await fixture.emit("before_agent_start", { prompt: "next thing", systemPrompt: "" }) as { message?: any };
    expect(first?.message).toMatchObject({
      customType: "acm:trigger-cue",
      display: false,
      details: { moment: "new_request" },
    });
    expect(first!.message.content).toContain("not a user request");

    // Same accumulation again: disarmed for the cycle.
    for (let call = 0; call < 9; call++) {
      await fixture.emit("tool_result", { toolName: "bash", toolCallId: `x${call}`, input: {}, content: textResult(), isError: false });
    }
    expect(((await fixture.emit("before_agent_start", { prompt: "another", systemPrompt: "" })) as { message?: unknown })?.message).toBeUndefined();

    // A save point rearms; unprotected work in a later run cues again.
    await fixture.emit("tool_result", { toolName: "acm_checkpoint", toolCallId: "cp", input: {}, content: textResult(), isError: false });
    await fixture.emit("before_agent_start", { prompt: "reset run", systemPrompt: "" });
    for (let call = 0; call < 9; call++) {
      await fixture.emit("tool_result", { toolName: "bash", toolCallId: `y${call}`, input: {}, content: textResult(), isError: false });
    }
    const rearmed = await fixture.emit("before_agent_start", { prompt: "again", systemPrompt: "" }) as { message?: any };
    expect(rearmed?.message?.details).toMatchObject({ moment: "new_request" });
  });

  test("phase-end cue uses the hidden followUp channel and defers to a pending tier reminder", async () => {
    const fixture = createFixture();
    for (let call = 0; call < 9; call++) {
      await fixture.emit("tool_result", { toolName: "bash", toolCallId: `t${call}`, input: {}, content: textResult(), isError: false });
    }
    await fixture.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [] }],
    });
    const cue = fixture.sentMessages.at(-1);
    expect(cue?.message).toMatchObject({
      customType: "acm:trigger-cue",
      display: false,
      details: { moment: "phase_end" },
    });
    expect(cue?.options).toMatchObject({ deliverAs: "followUp" });
  });

  test("small runs stay silent at boundaries", async () => {
    const fixture = createFixture();
    for (let call = 0; call < 3; call++) {
      await fixture.emit("tool_result", { toolName: "bash", toolCallId: `s${call}`, input: {}, content: textResult(), isError: false });
    }
    expect(((await fixture.emit("before_agent_start", { prompt: "hi", systemPrompt: "" })) as { message?: unknown })?.message).toBeUndefined();
    await fixture.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    expect(fixture.sentMessages).toHaveLength(0);
  });
});
