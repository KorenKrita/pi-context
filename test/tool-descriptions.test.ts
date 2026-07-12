import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const checkpointTool = readFileSync(new URL("../src/checkpoint-tool.ts", import.meta.url), "utf8");
const timelineTool = readFileSync(new URL("../src/timeline-tool.ts", import.meta.url), "utf8");
const travelTool = readFileSync(new URL("../src/travel-tool.ts", import.meta.url), "utf8");
const generatedGuidance = readFileSync(new URL("../src/generated-guidance.ts", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

describe("ACM tool description contract", () => {
  test("keeps runtime descriptions owned by generated canonical guidance", () => {
    expect(checkpointTool).toContain("description: TOOL_DESCRIPTIONS.checkpoint");
    expect(timelineTool).toContain("description: TOOL_DESCRIPTIONS.timeline");
    expect(travelTool).toContain("description: TOOL_DESCRIPTIONS.travel");
    expect(generatedGuidance).toContain("Checkpoint does not branch or fold the active context.");
    expect(generatedGuidance).not.toContain("Zero cost: no branch, no handoff, no context change.");
  });

  test("keeps rebase semantics agent-owned and runtime evidence factual", () => {
    expect(travelTool).toContain("For a rebase, run cold start on candidate bases from earliest to latest");
    expect(travelTool).toContain("root is a candidate, not a default");
    expect(travelTool).toContain("activeSummaryDepthBefore");
    expect(timelineTool).toContain("structural candidate, not a checkpoint");
    expect(generatedGuidance).toContain("rebase accumulated summaries");
    expect(generatedGuidance).toContain("cold start");
    expect(generatedGuidance).not.toContain("acm_rebase");
  });

  test("keeps task-end travel conditional on meaningful structural saving", () => {
    expect(travelTool).toContain("when the preview shows meaningful structural saving");
    expect(travelTool).toContain("If the preview shows almost no saving, create a unique '-done' checkpoint and answer directly");
    expect(generatedGuidance).toContain("or create a unique `-done` checkpoint and answer directly");
    expect(travelTool).not.toContain("At task end, set backupCurrentHeadAs to '<task>-done', travel");
  });

  test("uses the strict single-view timeline contract", () => {
    expect(timelineTool).toContain('view: Type.Optional(Type.Literal("active"))');
    expect(timelineTool).toContain('view: Type.Literal("checkpoints")');
    expect(timelineTool).toContain('view: Type.Literal("search")');
    expect(timelineTool).toContain('view: Type.Literal("tree")');
    expect(travelTool).toContain("On large trees use acm_timeline with view checkpoints or search");
    expect(timelineTool).not.toContain("list_checkpoints");
    expect(timelineTool).not.toContain("full_tree");
  });

  test("keeps repository guidance aligned with modular runtime ownership", () => {
    expect(agents).toContain("`acm_timeline` 使用 strict `view` discriminator");
    expect(agents).toContain("不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict");
    expect(agents).toContain("`skills/context-management/CORE.md`：normal-path guidance 的 canonical source");
  });
});
