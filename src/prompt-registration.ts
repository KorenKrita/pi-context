import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACM_CORE, ACM_CORE_MARKER } from "./generated-guidance.js";

/** Pure canonical CORE producer shared by prompt registration and idempotence tests. */
export function ensureAcmCoreSegment(systemPrompt: string): string {
  if (systemPrompt.includes(ACM_CORE_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${ACM_CORE_MARKER}\n${ACM_CORE}`;
}

/** Structured prompt section key; Pi renders sections as XML-wrapped blocks. */
export const ACM_CORE_SECTION = "acm_core";

export function registerAcmPrompt(pi: ExtensionAPI): void {
  // Add CORE as a structured section instead of returning `systemPrompt`: a returned prompt
  // forces a whole-prompt replacement (Pi >= 0.86), which drops section changes made by
  // extensions loaded later and prevents Pi from recording the change as a transcript delta.
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(ACM_CORE_MARKER)) return undefined;
    // An earlier handler forced the whole prompt: sections are not rendered, so append CORE to
    // the forced text (the only way it reaches the provider).
    const forced = event.systemPromptOptions.forceSystemPrompt;
    if (forced !== undefined) return { systemPrompt: ensureAcmCoreSegment(forced) };
    event.systemPromptOptions.sections = {
      ...event.systemPromptOptions.sections,
      [ACM_CORE_SECTION]: `${ACM_CORE_MARKER}\n${ACM_CORE}`,
    };
    return undefined;
  });
}
