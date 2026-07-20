import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const checkpointTool = readFileSync(new URL("../src/checkpoint-tool.ts", import.meta.url), "utf8");
const timelineTool = readFileSync(new URL("../src/timeline-tool.ts", import.meta.url), "utf8");
const travelTool = readFileSync(new URL("../src/travel-tool.ts", import.meta.url), "utf8");
const generatedGuidance = readFileSync(new URL("../src/generated-guidance.ts", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

describe("ACM tool description contract", () => {
  test("keeps runtime descriptions and prompt metadata owned by generated canonical guidance", () => {
    expect(checkpointTool).toContain("description: TOOL_DESCRIPTIONS.checkpoint");
    expect(timelineTool).toContain("description: TOOL_DESCRIPTIONS.timeline");
    expect(travelTool).toContain("description: TOOL_DESCRIPTIONS.travel");
    expect(checkpointTool).toContain("promptSnippet: PROMPT_SNIPPETS.checkpoint");
    expect(timelineTool).toContain("promptSnippet: PROMPT_SNIPPETS.timeline");
    expect(travelTool).toContain("promptSnippet: PROMPT_SNIPPETS.travel");
    expect(checkpointTool).toContain("promptGuidelines: PROMPT_GUIDELINES.checkpoint.split(\"\\n\")");
    expect(timelineTool).toContain("promptGuidelines: PROMPT_GUIDELINES.timeline.split(\"\\n\")");
    expect(travelTool).toContain("promptGuidelines: PROMPT_GUIDELINES.travel.split(\"\\n\")");
    expect(generatedGuidance).toContain("Save point: attach a semantic label to a session node");
    expect(generatedGuidance).toContain("Omitting `target` labels the nearest meaningful USER/AI turn");
  });

  test("keeps checkpoint names and backup labels free of workflow-state semantics", () => {
    expect(checkpointTool).not.toContain("endsWith(\"-done\")");
    expect(travelTool).not.toContain("endsWith(\"-done\")");
    expect(checkpointTool).toContain("Suffixes are naming convention only");
    expect(travelTool).toContain("never a workflow state");
    expect(checkpointTool).toContain("unique and case-sensitive across the session tree");
  });

  test("keeps rebase semantics agent-owned and runtime evidence factual", () => {
    expect(travelTool).toContain("projected summary depth does not grow");
    expect(travelTool).toContain("passes cold start");
    expect(travelTool).toContain("root is a candidate, not a default");
    expect(travelTool).toContain("activeSummaryDepthBefore");
    expect(timelineTool).toContain("structural candidate, not a checkpoint");
    expect(generatedGuidance).toContain("rebase stacked summaries onto an earlier base");
    expect(generatedGuidance).toContain("cold start");
    expect(generatedGuidance).not.toContain("acm_rebase");
  });

  test("presents rehydration as a first-class travel direction", () => {
    expect(generatedGuidance).toContain("rehydrate an archived branch");
    expect(generatedGuidance).toContain("rehydrate the archive if one exact detail is missing");
  });

  test("uses the strict single-object timeline contract", () => {
    expect(timelineTool).toContain("const schema = Type.Object({");
    expect(timelineTool).toContain("view: Type.Optional(Type.Union([");
    expect(timelineTool).toContain('Type.Literal("active")');
    expect(timelineTool).toContain('Type.Literal("checkpoints")');
    expect(timelineTool).toContain('Type.Literal("search")');
    expect(timelineTool).toContain('Type.Literal("tree")');
    expect(timelineTool).toContain("if (params.view === \"search\" && !params.query)");
    expect(timelineTool).not.toContain("const schema = Type.Union([");
    expect(travelTool).toContain("use acm_timeline with view checkpoints or search");
    expect(timelineTool).not.toContain("list_checkpoints");
    expect(timelineTool).not.toContain("full_tree");
  });

  test("keeps repository guidance aligned with modular runtime ownership", () => {
    expect(agents).toContain("`acm_timeline` 使用 strict `view` discriminator");
    expect(agents).toContain("不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict");
    expect(agents).toContain("`docs/acm-judgment-contract.md`：ACM 判断语义与度的 canonical source");
    expect(agents).toContain("`skills/context-management/CORE.md`：Judgment Contract 面向模型的 always-on projection");
    expect(agents).toContain("`skills/context-management/TOOL-CONTRACTS.md`：术（tool mechanics text）的 canonical source");
  });
});
