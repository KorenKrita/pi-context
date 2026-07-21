import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAvailableAdvancedGuidance,
  hasContextManagementSkill,
  withAvailableAdvancedGuidance,
} from "../src/advanced-guidance.js";
import { GUIDANCE_CUES, RECOVERY_GUIDANCE } from "../src/generated-guidance.js";

function piWithCommands(names: string[]): Pick<ExtensionAPI, "getCommands"> {
  return {
    getCommands: () => names.map((name) => ({ name })) as never,
  };
}

function piWithSkillPath(path: unknown): Pick<ExtensionAPI, "getCommands"> {
  return {
    getCommands: () => [{
      name: "skill:context-management",
      sourceInfo: { path },
    }] as never,
  };
}

describe("advanced guidance availability", () => {
  test("uses Pi command discovery as the only availability source", () => {
    expect(hasContextManagementSkill(piWithCommands([]))).toBe(false);
    expect(hasContextManagementSkill(piWithCommands(["skill:context-management"]))).toBe(true);
    expect(hasContextManagementSkill({ getCommands: () => { throw new Error("unavailable"); } })).toBe(false);
  });

  test("keeps base recovery guidance free of unavailable Skill pointers", () => {
    expect(RECOVERY_GUIDANCE.nameCollision).not.toContain("context-management");
    expect(RECOVERY_GUIDANCE.rollbackFailed).not.toContain("context-management");
    expect(RECOVERY_GUIDANCE.rollbackSkipped).not.toContain("context-management");
    expect(RECOVERY_GUIDANCE.refreshExhausted).not.toContain("context-management");

    const base = RECOVERY_GUIDANCE.rollbackFailed;
    expect(withAvailableAdvancedGuidance(piWithCommands([]), base, GUIDANCE_CUES.advancedExceptionalPointer)).toBe(base);
    expect(withAvailableAdvancedGuidance(
      piWithCommands(["skill:context-management"]),
      base,
      GUIDANCE_CUES.advancedExceptionalPointer,
    )).toContain("references/exceptional-recovery.md");
  });

  test("adds the exact uniquely advertised router path with a JSON-safe runtime bridge", () => {
    const path = "/tmp/Skill Router/context management/SKILL.md";
    const guidance = getAvailableAdvancedGuidance(
      piWithSkillPath(path),
      GUIDANCE_CUES.advancedTargetPointer,
    );

    expect(guidance).toContain(GUIDANCE_CUES.advancedTargetPointer);
    expect(guidance).toContain(`Router location: ${JSON.stringify(path)}`);
    expect(guidance).toContain("relative to its directory");
  });

  test("falls back to the static cue when the router path is missing, ambiguous, or unreadable", () => {
    const staticCue = GUIDANCE_CUES.advancedTargetPointer;

    expect(getAvailableAdvancedGuidance(piWithSkillPath(""), staticCue)).toBe(staticCue);
    expect(getAvailableAdvancedGuidance(piWithSkillPath("   "), staticCue)).toBe(staticCue);
    expect(getAvailableAdvancedGuidance(piWithSkillPath(undefined), staticCue)).toBe(staticCue);
    expect(getAvailableAdvancedGuidance({
      getCommands: () => [
        { name: "skill:context-management", sourceInfo: { path: "/one/SKILL.md" } },
        { name: "skill:context-management", sourceInfo: { path: "/two/SKILL.md" } },
      ] as never,
    }, staticCue)).toBe(staticCue);
    expect(getAvailableAdvancedGuidance({
      getCommands: () => [{
        name: "skill:context-management",
        get sourceInfo() { throw new Error("path unavailable"); },
      }] as never,
    }, staticCue)).toBe(staticCue);
  });

  test("does not expose a pointer when command discovery throws or the Skill is absent", () => {
    const staticCue = GUIDANCE_CUES.advancedTargetPointer;
    expect(getAvailableAdvancedGuidance({ getCommands: () => { throw new Error("unavailable"); } }, staticCue)).toBeUndefined();
    expect(getAvailableAdvancedGuidance(piWithCommands([]), staticCue)).toBeUndefined();
  });

  test("escapes control characters in dynamic paths instead of injecting them into guidance", () => {
    const path = "/tmp/router\nnext\u0000/SKILL.md";
    const guidance = getAvailableAdvancedGuidance(piWithSkillPath(path), GUIDANCE_CUES.advancedTargetPointer);

    expect(guidance).toContain(`Router location: ${JSON.stringify(path)}`);
    expect(guidance).not.toContain(path);
    expect(guidance).not.toContain("\u0000");
    expect(guidance).not.toContain("/tmp/router\nnext");
  });
});
