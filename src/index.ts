import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "./checkpoint-tool.js";
import { registerAcmLifecycle } from "./runtime-lifecycle.js";
import { registerAcmPrompt } from "./prompt-registration.js";
import { AcmSessionRuntime } from "./runtime.js";
import { registerTimelineTool } from "./timeline-tool.js";
import { registerTravelTool } from "./travel-tool.js";

export { fixOrphanedToolUse } from "./message-sanitizer.js";
export { ensureAcmCoreSegment } from "./prompt-registration.js";

export interface AcmExtensionOptions {
  promptInjection?: boolean;
}

/** ACM composition root. Domain behavior lives in behavior-owned modules. */
export default function registerAcmExtension(
  pi: ExtensionAPI,
  options: AcmExtensionOptions = {},
): void {
  const runtime = new AcmSessionRuntime();
  if (options.promptInjection !== false) registerAcmPrompt(pi);
  registerCheckpointTool(pi);
  registerTimelineTool(pi, runtime);
  registerTravelTool(pi, runtime);
  registerAcmLifecycle(pi, runtime);
}
