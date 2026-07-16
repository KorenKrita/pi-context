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
    expect(generatedGuidance).toContain("Unlabeled return state plus imminent working-set expansion");
    expect(generatedGuidance).toContain("Inspect working-set topology and summary-debt evidence");
    expect(generatedGuidance).toContain("Replace one raw history segment with a recoverable handoff");
    expect(generatedGuidance).toContain("their wording is a human recovery cue, not a runtime state classifier");
    expect(generatedGuidance).toContain("Omitting `target` labels the nearest meaningful USER/AI turn");
  });

  test("keeps semantic judgment agent-owned and runtime evidence factual", () => {
    expect(travelTool).toContain("last clean anchor before the named boundary");
    expect(travelTool).toContain("replaces obsolete active handoffs without growing projected summary depth");
    expect(travelTool).toContain("whose handoff passes cold start");
    expect(travelTool).toContain("Root is a candidate, not a default");
    expect(travelTool).toContain("activeSummaryDepthBefore");
    expect(timelineTool).toContain("structural candidate, not a checkpoint");
    expect(generatedGuidance).toContain("summary debt");
    expect(generatedGuidance).toContain("cold start");
    expect(generatedGuidance).not.toContain("acm_rebase");
  });

  test("uses state-neutral checkpoint and travel cues instead of suffix classifiers", () => {
    expect(checkpointTool).toContain("const cue = GUIDANCE_CUES.checkpoint");
    expect(travelTool).toContain("const nextCue = GUIDANCE_CUES.travel");
    expect(checkpointTool).not.toContain("endsWith(\"-done\")");
    expect(travelTool).not.toContain("endsWith(\"-done\")");
    expect(travelTool).not.toContain("GUIDANCE_CUES.travelTask");
    expect(travelTool).not.toContain("GUIDANCE_CUES.travelPhase");
    expect(checkpointTool).not.toContain("GUIDANCE_CUES.checkpointDone");
    expect(checkpointTool).not.toContain("GUIDANCE_CUES.checkpointStart");
    expect(travelTool).toContain("its spelling does not classify the travel");
  });

  test("keeps travel isolation in the technique layer and runtime guard", () => {
    expect(generatedGuidance).not.toContain("Call `acm_travel` alone in its assistant tool batch");
    expect(generatedGuidance).toContain("Run `acm_travel` alone in its assistant tool batch");
    expect(travelTool).toContain("acm_travel must run alone in its assistant tool batch");
    expect(travelTool).toContain("executionMode: \"sequential\"");
    expect(travelTool).toContain("mixed_tool_batch");
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
    expect(travelTool).toContain("Use acm_timeline checkpoints/search for comparison");
    expect(timelineTool).not.toContain("list_checkpoints");
    expect(timelineTool).not.toContain("full_tree");
  });

  test("keeps repository guidance aligned with way/technique ownership", () => {
    expect(agents).toContain("`acm_timeline` 使用 strict `view` discriminator");
    expect(agents).toContain("不要恢复旧的 `estimatedEffect` / `structuralEffect` 阈值 verdict");
    expect(agents).toContain("`skills/context-management/CORE.md`：working-set doctrine 的 canonical source");
    expect(agents).toContain("`CONTEXT.md`：ACM ubiquitous language");
  });
});
