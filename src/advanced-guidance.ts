import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Grassroots: advanced guidance is not routed through Skill reference files.
 * Recovery text lives directly in TOOL-CONTRACTS.md (generated into
 * RECOVERY_GUIDANCE) and is shown inline with the tool result. This module
 * only answers whether the context-management Skill is installed at all.
 */

export function hasContextManagementSkill(pi: Pick<ExtensionAPI, "getCommands">): boolean {
  try {
    return pi.getCommands().some((command) => command.name === "skill:context-management");
  } catch {
    return false;
  }
}

/**
 * Grassroots builds do not route to reference files, so this always returns
 * undefined. Callers fall back to the inline recovery text in `base`.
 */
export function getAvailableAdvancedGuidance(
  _pi: Pick<ExtensionAPI, "getCommands">,
  _pointer: string,
): string | undefined {
  return undefined;
}

/** Returns `base` unchanged — grassroots builds append no reference pointer. */
export function withAvailableAdvancedGuidance(
  _pi: Pick<ExtensionAPI, "getCommands">,
  base: string,
  _pointer: string,
): string {
  return base;
}
