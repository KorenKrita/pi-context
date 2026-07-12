import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
  test("preserves the base workflow while bounding semantic rebase", () => {
    for (const baseBehavior of [
      "New chain starts",
      "Phase, attempt, or batch item starts",
      "Unbounded burst or risky step is next",
      "Findings are distilled",
      "Direction is rejected or superseded",
      "Final answer is next",
    ]) {
      expect(ACM_CORE).toContain(baseBehavior);
    }
    expect(ACM_CORE).toContain("Local fold example");
    expect(ACM_CORE).toContain("Finished-chain rebase example");
    expect(ACM_CORE).not.toContain("Failed-direction example");
    expect(ACM_CORE).toContain("Structural reset passes only when");
    expect(ACM_CORE).toContain("projected summary depth does not grow");
    expect(ACM_CORE).toContain("Cold start passes only when");
    expect(ACM_CORE.length).toBeLessThan(6000);
    expect(GUIDANCE_CUES.rebaseCheck).toContain("Active summarized history is present");
  });

  test("routes one advanced condition at a time and reroutes on state change", async () => {
    const skill = await skillFile("SKILL.md");
    expect(skill).toContain("CORE owns the normal path");
    expect(skill).toContain("ordinary checkpointing");
    expect(skill).toContain("clear phase folds");
    expect(skill).toContain("clear burst folds");
    expect(skill).toContain("task-end handling");
    expect(skill).toContain("Load one reference at a time");
    expect(skill).toContain("observable condition changes");
    expect(skill).toContain("replace the active reference");
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
