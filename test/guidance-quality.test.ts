import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES, TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();
const occurrences = (text: string, phrase: string) => text.toLowerCase().split(phrase.toLowerCase()).length - 1;

describe("ACM guidance quality", () => {
  test("uses leading words as a working-set doctrine instead of a tool choreography", () => {
    expect(ACM_CORE).toContain("The CORE is the **way** (道)");
    expect(ACM_CORE).toContain("the **technique** (术)");
    expect(ACM_CORE).toContain("a compass, not a fixed tool sequence");

    const minimumDensity: Record<string, number> = {
      "working set": 5,
      boundary: 10,
      "active uncertainty": 3,
      recoverability: 4,
      handoff: 8,
      "cold start": 3,
      "summary debt": 3,
      "anchor gravity": 1,
    };
    for (const [leadingWord, minimum] of Object.entries(minimumDensity)) {
      expect(occurrences(ACM_CORE, leadingWord), `${leadingWord} density`).toBeGreaterThanOrEqual(minimum);
    }

    expect(ACM_CORE).not.toContain("### Normal state transitions");
    expect(ACM_CORE).not.toContain("### ACM preflight");
    expect(ACM_CORE).not.toContain("checkpoint call is the first action");
    expect(ACM_CORE).not.toContain("Every handoff uses these seven slots");
    expect(ACM_CORE.length).toBeLessThan(6500);
  });

  test("preserves cross-scenario invariants without prescribing an exact call order", () => {
    for (const invariant of [
      "before the working set expands into a distinct goal",
      "active uncertainty remains",
      "when a boundary closes",
      "A checkpoint alone is not a reason to fold",
      "the handoff passes cold start",
      "when summary debt is real",
      "Summary depth and context pressure are evidence of possible debt, not permission to travel",
      "A final answer closes user-facing work only when no active uncertainty",
    ]) {
      expect(ACM_CORE).toContain(invariant);
    }

    expect(ACM_CORE).toContain("`acm_checkpoint` creates recoverability");
    expect(ACM_CORE).toContain("`acm_timeline` exposes branch topology");
    expect(ACM_CORE).toContain("`acm_travel` folds one named boundary");
    expect(TOOL_DESCRIPTIONS.travel).toContain("Run `acm_travel` alone in its assistant tool batch");
    expect(TOOL_DESCRIPTIONS.travel).toContain("active uncertainty is preserved");
    expect(GUIDANCE_CUES.checkpoint).toContain("working set is unchanged");
    expect(GUIDANCE_CUES.travel).toContain("new working set");
  });

  test("progressively discloses technique through one observable condition at a time", async () => {
    const skill = await skillFile("SKILL.md");
    const handoff = await skillFile("references/handoff-wire-format.md");
    const isolation = await skillFile("references/travel-isolation.md");

    expect(skill).toContain("CORE owns the way");
    expect(skill).toContain("This Skill owns the **technique**");
    expect(skill).toContain("Handoff Wire Format");
    expect(skill).toContain("Advanced Target Selection");
    expect(skill).toContain("Travel Isolation");
    expect(skill).toContain("Archive Recovery");
    expect(skill).toContain("Exceptional Recovery");
    expect(skill).toContain("Load one reference at a time");
    expect(skill).toContain("replace it with the next reference");

    for (const slot of ["Goal", "State", "Evidence", "External", "Exclusions", "Recover", "NEXT"]) {
      expect(handoff).toContain(`${slot}:`);
    }
    expect(handoff).toContain("runtime validates only this observable shape");
    expect(handoff).toContain("passes cold start only when all seven checks hold");
    expect(isolation).toContain("only tool call in that assistant message");
    expect(isolation).toContain("mixed_tool_batch");
  });

  test("keeps target and host recovery mechanics factual and checkable", async () => {
    const target = await skillFile("references/target-selection.md");
    const archive = await skillFile("references/archive-recovery.md");
    const exceptional = await skillFile("references/exceptional-recovery.md");

    expect(target).toContain("tree topology orders them");
    expect(target).toContain("must precede at least one active `branch_summary`");
    expect(target).toContain("projected summary depth must not grow");
    expect(target).toContain("every surviving item has one authoritative home");
    expect(archive).toContain("Pending is scheduled work, not success");
    expect(archive).toContain("return to the Skill router and replace this reference");
    expect(exceptional).toContain("Backup rollback failure");
    expect(exceptional).toContain("branch creation was not applied");
    expect(exceptional).toContain("Indeterminate branch mutation");
    expect(exceptional).toContain("mutation may have landed");
  });
});
