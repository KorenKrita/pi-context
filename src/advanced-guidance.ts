import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ContextManagementSkillAvailability {
  available: boolean;
  routerPath?: string;
}

function inspectContextManagementSkill(
  pi: Pick<ExtensionAPI, "getCommands">,
): ContextManagementSkillAvailability {
  let matches: ReturnType<ExtensionAPI["getCommands"]>;
  try {
    matches = pi.getCommands().filter((command) => command.name === "skill:context-management");
  } catch {
    return { available: false };
  }

  if (matches.length === 0) return { available: false };
  if (matches.length !== 1) return { available: true };

  try {
    const path = matches[0]?.sourceInfo.path;
    return typeof path === "string" && path.trim().length > 0
      ? { available: true, routerPath: path }
      : { available: true };
  } catch {
    return { available: true };
  }
}

export function hasContextManagementSkill(pi: Pick<ExtensionAPI, "getCommands">): boolean {
  return inspectContextManagementSkill(pi).available;
}

/**
 * Returns an advanced router cue only for a currently available Skill. When Pi
 * exposes one unambiguous source path, repeat it as a JSON string so the model
 * can open the router without guessing a cwd-relative location.
 */
export function getAvailableAdvancedGuidance(
  pi: Pick<ExtensionAPI, "getCommands">,
  pointer: string,
): string | undefined {
  const skill = inspectContextManagementSkill(pi);
  if (!skill.available) return undefined;
  if (!skill.routerPath) return pointer;
  return `${pointer} Router location: ${JSON.stringify(skill.routerPath)}. Load that router first; the referenced file is relative to its directory.`;
}

export function withAvailableAdvancedGuidance(
  pi: Pick<ExtensionAPI, "getCommands">,
  base: string,
  pointer: string,
): string {
  const advancedGuidance = getAvailableAdvancedGuidance(pi, pointer);
  return advancedGuidance ? `${base} ${advancedGuidance}` : base;
}
