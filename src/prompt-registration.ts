import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACM_CORE, ACM_CORE_MARKER } from "./generated-guidance.js";

/** Pure canonical CORE producer used by standalone ACM and consumer orchestration. */
export function ensureAcmCoreSegment(systemPrompt: string): string {
  if (systemPrompt.includes(ACM_CORE_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${ACM_CORE_MARKER}\n${ACM_CORE}`;
}

export function registerAcmPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const systemPrompt = ensureAcmCoreSegment(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
}
