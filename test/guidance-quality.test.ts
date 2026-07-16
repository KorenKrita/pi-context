import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES, TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
  test("unifies judgment on the working-set invariant with fold and rebase criteria", () => {
    for (const situation of [
      "Phase, attempt, or batch item starts",
      "Unbounded burst or risky step is next",
      "Findings are distilled",
      "Direction is rejected or superseded",
      "Final answer is next",
    ]) {
      expect(ACM_CORE).toContain(situation);
    }
    expect(ACM_CORE).toContain("### Working-set invariant");
    expect(ACM_CORE).toContain("### Decision smells");
    expect(ACM_CORE).toContain("### Judgment triggers");
    expect(ACM_CORE).toContain("| Situation | Judgment |");
    expect(ACM_CORE).not.toContain("| Event | Required transition |");
    expect(ACM_CORE).toContain("### Fold criteria");
    expect(ACM_CORE).toContain("### Rebase criteria");
    expect(ACM_CORE).toContain("### Failure shapes");
    expect(ACM_CORE).toContain("Local fold example");
    expect(ACM_CORE).toContain("Finished-chain rebase example");
    expect(ACM_CORE).toContain("Why: findings are distilled");
    expect(ACM_CORE).toContain("Why: prior chain is stable");
    expect(ACM_CORE).not.toContain("Failed-direction example");
    expect(ACM_CORE).toContain("Structural reset passes only when");
    expect(ACM_CORE).toContain("projected summary depth does not grow");
    expect(ACM_CORE).toContain("Cold start passes only when");
    expect(ACM_CORE.length).toBeLessThan(9000);
    expect(GUIDANCE_CUES.rebaseCheck).toContain("Active summarized history is present");
    expect(ACM_CORE).toContain("Before `acm_travel`, answer in one line");
    expect(ACM_CORE).toContain("Mixed tool batches are rejected before mutation");
    expect(TOOL_DESCRIPTIONS.travel).toContain("Mixed tool batches are rejected before mutation");
    expect(TOOL_DESCRIPTIONS.travel).not.toContain("must run alone");
    expect(ACM_CORE).toContain("load the context-management skill");
  });

  test("front-loads invariant and recoverability preflight as cost judgment", () => {
    const invariantIndex = ACM_CORE.indexOf("### Working-set invariant");
    const preflightIndex = ACM_CORE.indexOf("### ACM preflight");
    const vocabularyIndex = ACM_CORE.indexOf("### Vocabulary");

    expect(invariantIndex).toBeGreaterThan(-1);
    expect(invariantIndex).toBeLessThan(vocabularyIndex);
    expect(preflightIndex).toBeGreaterThan(vocabularyIndex);
    expect(ACM_CORE).toContain("Tools enforce structure; you judge when a transition earns its place");
    expect(ACM_CORE).toContain("Recoverability has a cost curve");
    expect(ACM_CORE).toContain("A distinct user goal therefore begins with an **ACM preflight** on the branch that will carry it");
    expect(ACM_CORE).toContain("After any needed `New request arrives over finished work` transition");
    expect(ACM_CORE).toContain("call `acm_checkpoint` with a semantic `<chain>-start` name before managed work");
    expect(ACM_CORE).not.toContain("the checkpoint call is the first action");
    expect(ACM_CORE).toContain("investigation, planning, delegation, any non-ACM tool call");
    expect(ACM_CORE).toContain("the checkpoint was created or reused");
    expect(ACM_CORE).toContain("follow the recovery guidance in its result before proceeding");
    expect(ACM_CORE).toContain("**lightweight reply**");
    expect(ACM_CORE).toContain("live detail the next action will reason over");
    expect(ACM_CORE).toContain("Name the boundary before choosing a target");
    expect(ACM_CORE).toContain("without archived summaries");
    expect(ACM_CORE).toContain("checkpoint its `-start` boundary before acting");
    expect(ACM_CORE).toContain("checkpoint before output or side effects arrive");
    expect(ACM_CORE).not.toContain("| New chain starts |");
    expect(TOOL_DESCRIPTIONS.checkpoint.startsWith("Preflight a distinct user goal")).toBe(true);
    expect(TOOL_DESCRIPTIONS.checkpoint).toContain("before managed work makes rewind expensive");
    expect(TOOL_DESCRIPTIONS.checkpoint.length).toBeLessThan(800);
  });

  test("routes one advanced condition at a time and reroutes on state change", async () => {
    const skill = await skillFile("SKILL.md");
    expect(skill).toContain("CORE owns the normal path");
    expect(skill).toContain("working-set invariant");
    expect(skill).toContain("decision smells");
    expect(skill).toContain("judgment triggers");
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

  test("re-anchors tool cues with observables and positive targets", () => {
    expect(GUIDANCE_CUES.checkpointStart).toContain("Recoverability confirmed");
    expect(GUIDANCE_CUES.checkpointDone).toContain("working-set invariant");
    expect(GUIDANCE_CUES.travelTask).toContain("handoff working set");
    expect(GUIDANCE_CUES.travelTask).not.toContain("do not reintroduce");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("cold-start test passes");
    expect(GUIDANCE_CUES.travelPhase).toContain("Anchor the next phase");
  });
});
