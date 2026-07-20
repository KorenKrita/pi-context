import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasContextManagementSkill, withAvailableAdvancedGuidance } from "../src/advanced-guidance.js";
import { GUIDANCE_CUES, RECOVERY_GUIDANCE } from "../src/generated-guidance.js";

function piWithCommands(names: string[]): Pick<ExtensionAPI, "getCommands"> {
  return {
    getCommands: () => names.map((name) => ({ name })) as never,
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
});
