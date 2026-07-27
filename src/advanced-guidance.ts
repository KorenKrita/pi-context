import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function hasContextManagementSkill(pi: Pick<ExtensionAPI, "getCommands">): boolean {
  try {
    return pi.getCommands().filter((command) => command.name === "skill:context-management").length > 0;
  } catch {
    return false;
  }
}

export function getAvailableAdvancedGuidance(
  pi: Pick<ExtensionAPI, "getCommands">,
  pointer: string,
): string | undefined {
  if (!hasContextManagementSkill(pi)) return undefined;
  return pointer;
}

export function withAvailableAdvancedGuidance(
  pi: Pick<ExtensionAPI, "getCommands">,
  base: string,
  pointer: string,
): string {
  const advancedGuidance = getAvailableAdvancedGuidance(pi, pointer);
  return advancedGuidance ? `${base} ${advancedGuidance}` : base;
}