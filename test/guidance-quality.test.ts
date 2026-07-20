import { describe, expect, test } from "bun:test";
import { ACM_CORE, GUIDANCE_CUES, TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
  test("grounds the doctrine in compression-as-intelligence and agent autonomy", () => {
    expect(ACM_CORE).toContain("Compression is intelligence");
    expect(ACM_CORE).toContain("**working set**, not a transcript");
    expect(ACM_CORE).toContain("as ordinary as reading a file");
    expect(ACM_CORE).toContain("only an explicit user request to hold travel");
    expect(ACM_CORE).toContain("**hot set**");
    expect(ACM_CORE).toContain("Honest uncertainty");
    expect(ACM_CORE).toContain("Removing it deletes nothing");
  });

  test("offers the full move set including forward travel", () => {
    for (const move of ["**Save**", "**Orient**", "**Fold**", "**Rebase**", "**Rehydrate**", "**Fork**"]) {
      expect(ACM_CORE).toContain(move);
    }
    expect(ACM_CORE).toContain("cold start");
    expect(ACM_CORE).toContain("anchor gravity");
    expect(ACM_CORE).toContain("Mid-investigation travel can be valuable");
    expect(ACM_CORE).toContain("Root is a candidate, never a default");
    expect(ACM_CORE).toContain("travel back carrying the extract");
    expect(ACM_CORE).toContain("as recoverable as a save");
  });

  test("frames cadence as repeatable judgment between sediment and thrash", () => {
    expect(ACM_CORE).toContain("Compress continuously");
    expect(ACM_CORE).toContain("Fold in batches");
    expect(ACM_CORE).toContain("**Sediment**");
    expect(ACM_CORE).toContain("**Thrash**");
    expect(ACM_CORE).toContain("around a third of the working budget");
    expect(ACM_CORE).toContain("preferred outcome, not move authorization");
    expect(ACM_CORE).toContain("signals to evaluate the working set");
    expect(ACM_CORE).toContain("Compression Candidate");
    expect(ACM_CORE).not.toContain("folding is the default, not an optional extra");
    expect(ACM_CORE).not.toContain("Skip only when you can name why");
    expect(ACM_CORE).toContain("different models legitimately choose different batch sizes");
  });

  test("keeps one structured cold-start handoff example carrying live cognition", () => {
    for (const slot of ["\"goal\":", "\"state\":", "\"evidence\":", "\"external\":", "\"exclusions\":", "\"recover\":", "\"next\":"]) {
      expect(ACM_CORE).toContain(slot);
    }
    expect(ACM_CORE).toContain("structured handoff with seven semantic fields");
    expect(ACM_CORE).toContain("Runtime owns the durable text format");
    expect(ACM_CORE).toContain("one concrete action a fresh agent could execute immediately");
    expect(ACM_CORE).toContain("Two hypotheses");
    expect(ACM_CORE).toContain("Hot:");
    expect(ACM_CORE.split("```json").length - 1).toBe(1);
  });

  test("each result cue points at the concrete next move", () => {
    expect(GUIDANCE_CUES.checkpoint).toContain("activation foothold");
    expect(GUIDANCE_CUES.checkpoint).toContain("timeline");
    expect(GUIDANCE_CUES.travel).toContain("Execute NEXT directly");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("the next fold would stack another");
  });

  test("never reintroduces mandatory workflow machinery", () => {
    expect(ACM_CORE).not.toContain("preflight");
    expect(ACM_CORE).not.toContain("Normal state transitions");
    expect(ACM_CORE).not.toContain("Required transition");
    expect(ACM_CORE).not.toContain("Fold gate");
    expect(ACM_CORE).not.toContain("-paused");
    expect(ACM_CORE).not.toContain("`<chain>-start`");
    expect(ACM_CORE).not.toContain("first action");
  });

  test("keeps receipt discipline and external-state honesty", () => {
    expect(ACM_CORE).toContain("only its matching result is fact");
    expect(ACM_CORE).toContain("applied, not applied, or indeterminate");
    expect(ACM_CORE).toContain("Travel rewrites conversation context only");
    expect(TOOL_DESCRIPTIONS.travel).toContain("alone in its assistant tool batch");
    expect(TOOL_DESCRIPTIONS.travel).toContain("The result is the only fact");
  });

  test("routes one advanced condition at a time and reroutes on state change", async () => {
    const skill = await skillFile("SKILL.md");
    expect(skill).toContain("CORE owns the normal path");
    expect(skill).toContain("Advanced Target Selection");
    expect(skill).toContain("Archive Recovery");
    expect(skill).toContain("Exceptional Recovery");
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
    expect(archive).toContain("Rehydration round trip");
    expect(archive).toContain("trust the returned handoff and resume the original action directly");
    expect(archive).toContain("return to the Skill router and replace this reference");
    expect(exceptional).toContain("Backup rollback failure");
    expect(exceptional).toContain("branch creation was not applied");
    expect(exceptional).toContain("Indeterminate branch mutation");
    expect(exceptional).toContain("mutation may have landed");
    expect(exceptional).toContain("Low-yield fold");
    expect(exceptional).toContain("travel is never required merely to record completion");
  });
});
