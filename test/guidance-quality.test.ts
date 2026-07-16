import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES, TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
  test("unifies judgment layers on the working-set invariant", () => {
    for (const situation of [
      "Phase, attempt, or batch item starts",
      "Unbounded burst or risky step is next",
      "Findings are distilled",
      "Direction is rejected or superseded",
      "Final answer is next",
    ]) {
      expect(ACM_CORE).toContain(situation);
    }
    expect(ACM_CORE).toContain("Process detail accumulates naturally");
    expect(ACM_CORE).toContain("keep live what NEXT needs");
    expect(ACM_CORE).toContain("### Working-set invariant");
    expect(ACM_CORE).toContain("### How judgment layers fit together");
    expect(ACM_CORE).toContain("**Decision smells** prompt a pause");
    expect(ACM_CORE).toContain("**Recognizable moments** map a situation");
    expect(ACM_CORE).toContain("**Failure shapes** describe what went wrong");
    expect(ACM_CORE).toContain("### Decision smells");
    expect(ACM_CORE).toContain("### Recognizable moments");
    expect(ACM_CORE).toContain("lightest transition that does");
    expect(ACM_CORE).not.toContain("| Event | Required transition |");
    expect(ACM_CORE).not.toContain("| Situation | Judgment |");
    expect(ACM_CORE).toContain("### Fold criteria");
    expect(ACM_CORE).toContain("### Rebase criteria");
    expect(ACM_CORE).toContain("### Failure shapes");
    expect(ACM_CORE).toContain("Before `acm_travel`, answer in one line");
    expect(ACM_CORE).toContain("Cold start remains hard");
    expect(ACM_CORE).toContain("not answers by proximity or anchor gravity");
    expect(ACM_CORE).toContain("Why: findings are distilled");
    expect(ACM_CORE).not.toContain("**NEXT stalls**");
    expect(ACM_CORE).toContain("Ambiguous base selection, interleaved fronts, or raw-node fallback");
    expect(ACM_CORE).toContain("load the context-management skill");
    expect(ACM_CORE).toContain("managed-chain workflow");
    expect(ACM_CORE).toContain("without rereading archived summaries");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("cold-start test passes");
    expect(TOOL_DESCRIPTIONS.travel).toContain("Mixed tool batches are rejected");
  });

  test("front-loads recoverability preflight as a cost judgment", () => {
    const invariantIndex = ACM_CORE.indexOf("### Working-set invariant");
    const layersIndex = ACM_CORE.indexOf("### How judgment layers fit together");
    const preflightIndex = ACM_CORE.indexOf("### ACM preflight");
    const vocabularyIndex = ACM_CORE.indexOf("### Vocabulary");

    expect(invariantIndex).toBeGreaterThan(-1);
    expect(invariantIndex).toBeLessThan(layersIndex);
    expect(layersIndex).toBeLessThan(vocabularyIndex);
    expect(preflightIndex).toBeGreaterThan(vocabularyIndex);
    expect(ACM_CORE).toContain("against this invariant");
    expect(ACM_CORE).toContain("Recoverability has a cost curve");
    expect(ACM_CORE).toContain("opening a **managed chain**");
    expect(ACM_CORE).not.toContain("the checkpoint call is the first action");
    expect(TOOL_DESCRIPTIONS.checkpoint).toContain("before managed work makes rewind expensive");
  });

  test("routes one advanced condition at a time and reroutes on state change", async () => {
    const skill = await skillFile("SKILL.md");
    expect(skill).toContain("working-set invariant");
    expect(skill).toContain("decision smells");
    expect(skill).toContain("judgment layers");
    expect(skill).toContain("Load one reference at a time");
  });

  test("re-anchors tool cues with observables and positive targets", () => {
    expect(GUIDANCE_CUES.checkpointStart).toContain("Recoverability confirmed");
    expect(GUIDANCE_CUES.travelTask).toContain("handoff working set");
    expect(GUIDANCE_CUES.travelTask).not.toContain("do not reintroduce");
    expect(GUIDANCE_CUES.checkpointDone).toContain("working-set invariant");
  });
});
