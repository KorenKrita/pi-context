import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES, TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
  test("preserves the normal boundary workflow while bounding semantic rebase", () => {
    for (const baseBehavior of [
      "Phase, attempt, or batch item starts",
      "Unbounded read/log/search/diff/subagent burst or risky step starts",
      "Findings are captured in `State`/`Evidence`",
      "Direction is rejected or superseded",
      "Managed goal is ready for its final answer",
    ]) {
      expect(ACM_CORE).toContain(baseBehavior);
    }
    expect(ACM_CORE).toContain("Structural reset");
    expect(ACM_CORE).toContain("projected summary depth does not grow");
    expect(ACM_CORE).toContain("Cold start");
    expect(TOOL_DESCRIPTIONS.travel).toContain("requested task-end fold");
    expect(TOOL_DESCRIPTIONS.travel).toContain("`acm_timeline` after findings are distilled");
    expect(GUIDANCE_CUES.travelTask).toContain("Do not checkpoint, reread, inspect timeline, or travel again");
    expect(ACM_CORE).toContain("explicit user-requested fold uses one task-end travel");
    expect(ACM_CORE.length).toBeLessThan(7500);
    expect(GUIDANCE_CUES.rebaseCheck).toContain("Active summarized history is present");
    expect(GUIDANCE_CUES.travelTask.startsWith("FINAL ANSWER")).toBe(true);
    expect(ACM_CORE).toContain("Call `acm_travel` as the only tool in its assistant message");
    expect(TOOL_DESCRIPTIONS.travel).toContain("`acm_travel` alone");
  });

  test("front-loads literal checkpoint-first classification and repeats the gate at the tail", () => {
    const checkpointIndex = ACM_CORE.indexOf("### CHECKPOINT-FIRST");
    const boundaryIndex = ACM_CORE.indexOf("### Boundary loop");
    const tailIndex = ACM_CORE.lastIndexOf("**CHECKPOINT-FIRST:**");

    expect(checkpointIndex).toBeGreaterThan(-1);
    expect(ACM_CORE).toContain("CHECKPOINT-FIRST: before ANY tool on a distinct goal");
    expect(ACM_CORE).toContain("PLANNING-ONLY is also Managed");
    expect(ACM_CORE).toContain("read, inspect, or run something and fold later");
    expect(ACM_CORE).toContain("it needs a tool, delegation, investigation, planning");
    expect(ACM_CORE).toContain("STOP before every other tool");
    expect(checkpointIndex).toBeLessThan(boundaryIndex);
    expect(ACM_CORE).toContain("complete it now with text only");
    expect(ACM_CORE).toContain("emit only `acm_checkpoint`");
    expect(ACM_CORE).toContain("wait for created/reused");
    expect(ACM_CORE).toContain("Follow recovery guidance on error");
    expect(tailIndex).toBeGreaterThan(ACM_CORE.indexOf("### Handoff contract"));
    expect(ACM_CORE.slice(tailIndex)).toContain("inspect/read now, fold later");
    expect(TOOL_DESCRIPTIONS.checkpoint.startsWith("FIRST TOOL")).toBe(true);
    expect(TOOL_DESCRIPTIONS.checkpoint).toContain("before `bash`, `read`, `write`");
    expect(TOOL_DESCRIPTIONS.checkpoint.length).toBeLessThan(800);
  });

  test("routes one managed advanced condition at a time and reroutes on state change", async () => {
    const skill = await skillFile("SKILL.md");
    expect(skill).toContain("Managed advanced ACM exception handling");
    expect(skill).toContain("CHECKPOINT-FIRST before reading this skill or a reference");
    expect(skill).toContain("Reading this Skill or one of its references is **Managed**");
    expect(skill).toContain("`acm_checkpoint` must already have completed before the first read");
    expect(skill).toContain("CORE owns the normal path");
    expect(skill).toContain("ordinary checkpointing");
    expect(skill).toContain("clear folds");
    expect(skill).toContain("task close");
    expect(skill).toContain("Load one reference");
    expect(skill).toContain("condition changes");
    expect(skill).toContain("replace the reference");
  });

  test("keeps target and recovery criteria factual and checkable", async () => {
    const target = await skillFile("references/target-selection.md");
    const archive = await skillFile("references/archive-recovery.md");
    const exceptional = await skillFile("references/exceptional-recovery.md");

    expect(target).toContain("tree topology orders them");
    expect(target).toContain("must precede at least one active `branch_summary`");
    expect(target).toContain("projected summary depth must not grow");
    expect(target).toContain("every surviving item has one authoritative home");
    expect(archive).toContain("Pending is scheduled work, not success");
    expect(archive).toContain("return to the Skill router and replace this reference");
    expect(archive).not.toContain("structural effect");
    expect(exceptional).toContain("Backup rollback failure");
    expect(exceptional).toContain("branch creation was not applied");
    expect(exceptional).toContain("Indeterminate branch mutation");
    expect(exceptional).toContain("mutation may have landed");
  });
});
