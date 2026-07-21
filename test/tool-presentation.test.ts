import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerTravelTool } from "../src/travel-tool.js";

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel";
  renderShell?: "default" | "self";
  renderCall?: (args: unknown, theme: Theme, context: unknown) => Component;
  renderResult?: (result: unknown, options: unknown, theme: Theme, context: unknown) => Component;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as Theme;

function captureTool(register: (pi: ExtensionAPI) => void): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(tool: CapturedTool) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  register(pi);
  if (!captured) throw new Error("tool was not registered");
  return captured;
}

function renderContext(args: unknown, lastComponent?: Component) {
  return {
    args,
    state: {},
    lastComponent,
    invalidate() {},
    toolCallId: "test-call",
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
}

function render(component: Component, width = 240): string {
  return component.render(width).join("\n");
}

const checkpoint = captureTool(registerCheckpointTool);
const timeline = captureTool((pi) => registerTimelineTool(pi, {} as never));
const travel = captureTool((pi) => registerTravelTool(pi, {} as never));

describe("ACM tool prompt metadata", () => {
  test.each([checkpoint, timeline, travel])("$name opts into concise system-prompt metadata", (tool: CapturedTool) => {
    expect(tool.promptSnippet?.length).toBeGreaterThan(0);
    expect(tool.promptSnippet?.includes("\n")).toBe(false);
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    for (const guideline of tool.promptGuidelines ?? []) {
      expect(guideline).toContain(tool.name);
    }
  });

  test("acm_travel forces the containing tool batch to execute sequentially", () => {
    expect(travel.executionMode).toBe("sequential");
  });

  test.each([checkpoint, timeline, travel])("$name owns its TUI shell and both render slots", (tool: CapturedTool) => {
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall).toBeFunction();
    expect(tool.renderResult).toBeFunction();
  });

  test("renderCall tolerates incomplete streaming arguments", () => {
    expect(() => checkpoint.renderCall!({}, theme, renderContext({}))).not.toThrow();
    expect(render(checkpoint.renderCall!({}, theme, renderContext({})))).toContain("◆ ACM CHECKPOINT  …");
    expect(() => timeline.renderCall!({}, theme, renderContext({}))).not.toThrow();
    expect(() => travel.renderCall!({}, theme, renderContext({}))).not.toThrow();
    expect(render(travel.renderCall!({}, theme, renderContext({})))).toContain("◆ ACM TRAVEL  → …");
  });
});

describe("ACM tool rendering", () => {
  test("checkpoint renders semantic placement and recoverability evidence", () => {
    const args = { name: "parser-fix-start", target: "root" };
    const call = checkpoint.renderCall!(args, theme, renderContext(args));
    expect(render(call)).toContain("◆ ACM CHECKPOINT  parser-fix-start  →  root");

    const result = checkpoint.renderResult!(
      {
        content: [{ type: "text", text: "Created checkpoint parser-fix-start" }],
        details: {
          status: "created",
          name: "parser-fix-start",
          entryId: "entry-123",
          role: "USER",
          contextUsage: { tokens: 120000, contextWindow: 400000, percent: 30 },
          cue: "Save point applied.",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      renderContext(args),
    );
    const output = render(result);
    expect(output).toContain("✓ CHECKPOINT CREATED  parser-fix-start");
    expect(output).toContain("USER · entry-123 · context 30.0% (120.0K/400.0K)");
    expect(output).toContain("→ Save point applied.");
  });

  test("timeline keeps the collapsed view compact and exposes full output when expanded", () => {
    const args = { view: "search", query: "parser", limit: 5 };
    const call = timeline.renderCall!(args, theme, renderContext(args));
    expect(render(call)).toContain("◆ ACM TIMELINE  search  ·  limit 5 · query “parser”");

    const raw = [
      "[Context Dashboard]",
      "• Context Usage: 30.0%",
      "---------------------------------------------------",
      "match one",
      "match two",
      "match three",
      "match four",
      "match five",
    ].join("\n");
    const details = {
      view: "search",
      searchDisplayedMatches: 5,
      searchTruncated: true,
      activeSummaryDepth: 1,
      contextUsage: { tokens: 120000, contextWindow: 400000, percent: 30 },
      contextDeliveryPhase: "active",
    };
    const collapsed = timeline.renderResult!(
      { content: [{ type: "text", text: raw }], details },
      { expanded: false, isPartial: false },
      theme,
      renderContext(args),
    );
    const collapsedOutput = render(collapsed);
    expect(collapsedOutput).toContain("✓ TIMELINE READY  SEARCH");
    expect(collapsedOutput).toContain("5 matches · truncated · summary depth 1");
    expect(collapsedOutput).toContain("match four");
    expect(collapsedOutput).not.toContain("match five");
    expect(collapsedOutput).toContain("expand for full output");

    const expanded = timeline.renderResult!(
      { content: [{ type: "text", text: raw }], details },
      { expanded: true, isPartial: false },
      theme,
      renderContext(args),
    );
    expect(render(expanded)).toContain("[Context Dashboard]");
    expect(render(expanded)).toContain("match five");
  });

  test("timeline renders legacy checkpoint details without inventing zero entry counts", () => {
    const args = { view: "checkpoints", limit: 5 };
    const result = timeline.renderResult!(
      {
        content: [{ type: "text", text: "[Context Dashboard]\n---------------------------------------------------\nlegacy checkpoint" }],
        details: {
          view: "checkpoints",
          checkpointsDisplayedAliases: 2,
          checkpointsMatchingAliases: 4,
          activeSummaryDepth: 0,
          contextDeliveryPhase: "active",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      renderContext(args),
    );

    const output = render(result);
    expect(output).toContain("2/4 aliases shown · summary depth 0");
    expect(output).not.toContain("0/0 entries");
  });

  test("travel renders the target, archive pointer, and structural deltas", () => {
    const args = {
      target: "parser-fix-start",
      backupCurrentHeadAs: "parser-fix-done",
      handoff: {
        goal: "x",
        state: "x",
        evidence: "x",
        external: "none",
        exclusions: "none",
        recover: "parser-fix-done",
        next: "x",
      },
    };
    const call = travel.renderCall!(args, theme, renderContext(args));
    const callOutput = render(call);
    expect(callOutput).toContain("◆ ACM TRAVEL  → parser-fix-start");
    expect(callOutput).toContain("backup parser-fix-done");
    expect(callOutput).toContain(`field content ${Object.values(args.handoff).reduce((sum, value) => sum + value.length, 0)} chars`);

    const result = travel.renderResult!(
      {
        content: [{ type: "text", text: "Travel complete." }],
        details: {
          target: "parser-fix-start",
          resultingLeafId: "summary-456",
          usageBeforeTokens: 120000,
          estimatedUsageAfterTokens: 70000,
          tokenDelta: -50000,
          structuralMessagesBefore: 42,
          structuralMessagesAfter: 18,
          structuralMessageDirection: "shrunk",
          activeSummaryDepthBefore: 2,
          activeSummaryDepthAfter: 1,
          backupCurrentHeadAs: "parser-fix-done",
          contextDeliveryPhase: "pending_run_settle",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      renderContext(args),
    );
    const output = render(result);
    expect(output).toContain("✓ TRAVEL COMPLETE  parser-fix-start → summary-456");
    expect(output).toContain("context 120000 → 70000 est. (-50000)");
    expect(output).toContain("messages 42 → 18 (shrunk)");
    expect(output).toContain("summary depth 2 → 1 · backup parser-fix-done");
    expect(output).toContain("delivery pending_run_settle · persisted refresh pending");
  });

  test("renderers surface actionable error states instead of success chrome", () => {
    const checkpointError = checkpoint.renderResult!(
      { content: [{ type: "text", text: "Error: duplicate name" }], details: { error: "duplicate_name" } },
      { expanded: false, isPartial: false },
      theme,
      renderContext({ name: "duplicate" }),
    );
    expect(render(checkpointError)).toContain("✕ CHECKPOINT NOT CREATED");

    const travelWarning = travel.renderResult!(
      { content: [{ type: "text", text: "Error: branch prevalidation failed" }], details: { error: "branch_prevalidation_failed" } },
      { expanded: false, isPartial: false },
      theme,
      renderContext({ target: "root", handoff: {} }),
    );
    expect(render(travelWarning)).toContain("⚠ TRAVEL NEEDS ATTENTION");
  });

  test("neutralizes terminal controls in dynamic call and result text", () => {
    const payload = "before\u001b[2Jafter\u009B31m\u0007\roverwrite";
    const unsafeControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

    const components = [
      checkpoint.renderCall!({ name: payload, target: payload }, theme, renderContext({ name: payload, target: payload })),
      timeline.renderCall!({ view: "search", query: payload }, theme, renderContext({ view: "search", query: payload })),
      travel.renderCall!({ target: payload, backupCurrentHeadAs: payload, handoff: { goal: payload } }, theme, renderContext({ target: payload })),
      checkpoint.renderResult!(
        { content: [{ type: "text", text: payload }], details: { error: "unsafe" } },
        { expanded: false, isPartial: false },
        theme,
        renderContext({}),
      ),
      timeline.renderResult!(
        { content: [{ type: "text", text: payload }], details: { view: "active" } },
        { expanded: true, isPartial: false },
        theme,
        renderContext({}),
      ),
      travel.renderResult!(
        { content: [{ type: "text", text: payload }], details: { error: "unsafe" } },
        { expanded: false, isPartial: false },
        theme,
        renderContext({}),
      ),
      checkpoint.renderResult!(
        {
          content: [{ type: "text", text: "ok" }],
          details: { status: "created", name: payload, entryId: payload, role: payload, cue: payload },
        },
        { expanded: false, isPartial: false },
        theme,
        renderContext({}),
      ),
      timeline.renderResult!(
        {
          content: [{ type: "text", text: "ok" }],
          details: {
            view: "checkpoints",
            checkpointsDisplayedAliases: 1,
            checkpointsMatchingAliases: 1,
            rootCandidateEntryId: payload,
            contextDeliveryPhase: payload,
          },
        },
        { expanded: false, isPartial: false },
        theme,
        renderContext({}),
      ),
      travel.renderResult!(
        {
          content: [{ type: "text", text: "ok" }],
          details: {
            target: payload,
            resultingLeafId: payload,
            structuralMessageDirection: payload,
            backupCurrentHeadAs: payload,
            contextDeliveryPhase: payload,
          },
        },
        { expanded: false, isPartial: false },
        theme,
        renderContext({}),
      ),
    ];

    const outputs = components.map((component) => render(component));
    for (const output of outputs) {
      expect(output).not.toMatch(unsafeControls);
      expect(output).toContain("before[2Jafter");
    }
    expect(outputs.some((output) => output.includes("overwrite"))).toBe(true);
  });
});
