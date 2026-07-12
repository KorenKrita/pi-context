import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendCheckpointLabel, buildSessionMessages } from "./host-bridge.js";
import { buildLabelMaps, ContextRefreshRegistry } from "./lib.js";
import { RECOVERY_GUIDANCE } from "./generated-guidance.js";
import { findLastMeaningfulEntry } from "./entry-resolution.js";
import { fixOrphanedToolUse } from "./message-sanitizer.js";
import type { AcmSessionRuntime } from "./runtime.js";

export function registerAcmLifecycle(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const contextRefresh = runtime.contextRefresh;

  pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "acm_travel") return;
    runtime.applyLiveAgentSync(ctx.sessionManager, event.toolCallId);
  });

  pi.on("context", (event, ctx: ExtensionContext) => {
    const sessionManager = ctx.sessionManager;
    if (!contextRefresh.isPending(sessionManager)) {
      const original = event.messages as AgentMessage[];
      const fixed = fixOrphanedToolUse(original);
      const changed = fixed.length !== original.length || fixed.some((message, index) => message !== original[index]);
      return changed ? { messages: fixed as typeof event.messages } : undefined;
    }

    const reportFailure = (message: string) => {
      const willRetry = contextRefresh.recordFailedAttempt(sessionManager, message);
      const attempt = contextRefresh.getAttemptCount(sessionManager);
      ctx.ui.notify(
        willRetry
          ? `Context refresh after travel failed (${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS}): ${message}. Will retry on the next LLM turn.`
          : `Context refresh after travel failed after ${attempt} attempts: ${message}. ${RECOVERY_GUIDANCE.refreshExhausted}`,
        "warning",
      );
      return { messages: event.messages };
    };

    try {
      const messagesResult = buildSessionMessages(sessionManager);
      if (!messagesResult.ok) return reportFailure(messagesResult.message);
      let messages = messagesResult.value;
      if (messages.length === 0) {
        const fallbackLeafId = runtime.getRefreshTarget(sessionManager);
        const fallbackResult = fallbackLeafId
          ? buildSessionMessages(sessionManager, fallbackLeafId)
          : { ok: true as const, value: [] as AgentMessage[] };
        messages = fallbackResult.ok ? fallbackResult.value : [];
      }
      if (messages.length === 0) return reportFailure("rebuilt messages array is empty");

      const fixed = fixOrphanedToolUse(messages);
      contextRefresh.markRebuilt(sessionManager);
      return { messages: fixed as typeof event.messages };
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant" || !message.usage) return;
    const promptTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
    const contextWindow = ctx.getContextUsage()?.contextWindow;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      runtime.setUsage(ctx.sessionManager, {
        tokens: promptTokens,
        contextWindow,
        percent: (promptTokens / contextWindow) * 100,
      });
    }
  });

  pi.on("session_before_compact", (event, ctx: ExtensionContext) => {
    const sessionManager = ctx.sessionManager;
    const branch = sessionManager.getBranch();
    if (branch.length === 0) return;
    const labelMaps = buildLabelMaps(sessionManager.getEntries());
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const checkpointBase = `pre-compact-${timestamp}`;
    let checkpointName = checkpointBase;
    for (let ordinal = 2; labelMaps.labelToEntryId.has(checkpointName); ordinal++) {
      checkpointName = `${checkpointBase}-${ordinal}`;
    }
    const resolved = findLastMeaningfulEntry(branch, event.signal);
    if (!resolved.entryId) return;
    const append = appendCheckpointLabel(sessionManager, resolved.entryId, checkpointName);
    if (!append.ok) ctx.ui.notify(`Could not create pre-compaction checkpoint: ${append.message}`, "warning");
  });

  pi.on("session_compact", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
  pi.on("session_start", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
}
