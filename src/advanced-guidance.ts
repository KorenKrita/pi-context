import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function hasContextManagementSkill(pi: Pick<ExtensionAPI, "getCommands">): boolean {
  try {
    return pi.getCommands().some((command) => command.name === "skill:context-management");
  } catch {
    return false;
  }
}

export function withAvailableAdvancedGuidance(
  pi: Pick<ExtensionAPI, "getCommands">,
  base: string,
  pointer: string,
): string {
  return hasContextManagementSkill(pi) ? `${base} ${pointer}` : base;
}
