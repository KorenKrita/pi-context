import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "./checkpoint-tool.js";
import { registerAcmLifecycle } from "./runtime-lifecycle.js";
import { registerAcmPrompt } from "./prompt-registration.js";
import { AcmSessionRuntime } from "./runtime.js";
import { registerTimelineTool } from "./timeline-tool.js";
import { registerTravelTool } from "./travel-tool.js";

export { fixOrphanedToolUse } from "./tool-protocol.js";
export { ensureAcmCoreSegment } from "./prompt-registration.js";

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export default function registerAcmExtension(pi: ExtensionAPI): void {
  const runtime = new AcmSessionRuntime();
  registerAcmPrompt(pi);
  registerCheckpointTool(pi);
  registerTimelineTool(pi, runtime);
  registerTravelTool(pi, runtime);
  registerAcmLifecycle(pi, runtime);
}
