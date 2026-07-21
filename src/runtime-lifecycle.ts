import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendCheckpointLabel } from "./host-bridge.js";
import { normalizeExistingAcmPacketForSession, rebuildAcmContextPacket } from "./context-packet.js";
import { buildCanonicalHandoff, type HandoffWireInput } from "./handoff.js";
import { formatToolProtocolDefects } from "./tool-protocol.js";
import {
  buildContextUsageNudgeMessage,
  calculateContextUsagePressure,
  CONTEXT_USAGE_NUDGE_STATE_CUSTOM_TYPE,
  restoreContextUsageNudgeState,
} from "./context-usage-nudge.js";
import { buildLabelMaps, ContextRefreshRegistry } from "./lib.js";
import { GUIDANCE_CUES, RECOVERY_GUIDANCE, TREE_SUMMARY_INSTRUCTIONS } from "./generated-guidance.js";
import { findLastMeaningfulEntry } from "./entry-resolution.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { withAvailableAdvancedGuidance } from "./advanced-guidance.js";

interface TravelToolResultLike {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  isError: boolean;
  details?: unknown;
}

export function buildPostTravelContinuationSteer(event: TravelToolResultLike) {
  if (event.toolName !== "acm_travel" || event.isError) return null;
  const details = typeof event.details === "object" && event.details !== null
    ? event.details as Record<string, unknown>
    : undefined;
  if (details?.error !== undefined || details?.handoffFormat !== "structured-v1" || typeof details.resultingLeafId !== "string") {
    return null;
  }
  const handoff = buildCanonicalHandoff(event.input.handoff as HandoffWireInput);
  if (!handoff.ok) return null;
  const next = handoff.value.fields.next;
  const currentUserTurnOpen = details.currentUserTurnOpen === true;
  return {
    customType: "acm:post-travel-continuation",
    content: [
      "[ACM POST-TRAVEL CONTINUATION]",
      "Travel succeeded. This message is not a new objective; it makes the authoritative handoff's current instruction explicit after the transition.",
      `REQUIRED NEXT: ${next}`,
      ...(currentUserTurnOpen ? [
        "CURRENT USER TURN IS STILL OPEN: deliver the result requested by the user who triggered travel. Ignore any NEXT that merely waits for another request; recording an answer in State is not user-visible delivery.",
      ] : []),
      "Earlier pre-travel requests are historical. Execute REQUIRED NEXT once now; do not reread folded material, recreate an old save point, or replay an earlier task unless REQUIRED NEXT explicitly requires it.",
      "Evidence and Recover are optional receipts and recovery pointers, not prerequisites; do not open them unless REQUIRED NEXT names them.",
    ].join("\n"),
    display: false,
    details: {
      kind: "post-travel-continuation",
      version: 1,
      toolCallId: event.toolCallId,
      resultingLeafId: details.resultingLeafId,
      next,
      currentUserTurnOpen,
    },
  };
}

function mayQueuePostTravelContinuation(ctx: ExtensionContext): boolean {
  if (ctx.signal?.aborted) return false;
  try {
    return typeof ctx.hasPendingMessages !== "function" || !ctx.hasPendingMessages();
  } catch {
    // If queue ordering cannot be observed, preserve the later-user-wins
    // invariant by relying on the in-place Context Packet continuation only.
    return false;
  }
}

/**
 * The summarizer model cannot see session node IDs, so the abandoned branch tip
 * is handed to it as a concrete fact: a Recover pointer that acm_travel can
 * rehydrate directly.
 */
export function buildTreeSummaryInstructions(oldLeafId: string | null): string {
  if (!oldLeafId) return TREE_SUMMARY_INSTRUCTIONS;
  return `${TREE_SUMMARY_INSTRUCTIONS}\n\nThe abandoned branch tip is node ${oldLeafId}. Name it in the Recover slot unless the branch contains a more specific save point.`;
}

export function registerAcmLifecycle(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const contextRefresh = runtime.contextRefresh;

  pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "acm_travel") return;
    // Pi emits this before the run is fully settled. Retain the latest ticket
    // and live message sequence; agent_settled owns the actual replacement.
    runtime.keepDeferredRefreshThroughToolExecution(ctx.sessionManager, event.toolCallId);
  });

  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const continuation = buildPostTravelContinuationSteer(event);
    if (continuation && mayQueuePostTravelContinuation(ctx)) {
      pi.sendMessage(continuation, { deliverAs: "steer" });
    }
    const nudge = runtime.takePendingContextUsageNudge(ctx.sessionManager);
    if (!nudge) return;
    pi.sendMessage(buildContextUsageNudgeMessage(nudge), { deliverAs: "steer" });
  });

  pi.on("agent_end", (event, ctx: ExtensionContext) => {
    const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason !== "stop") return;
    const nudge = runtime.takePendingContextUsageNudge(ctx.sessionManager);
    if (!nudge) return;
    pi.sendMessage(buildContextUsageNudgeMessage(nudge), { deliverAs: "followUp" });
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    // A settled notification can race a queued continuation or retry. Do not
    // replace live messages until the host confirms this SessionManager is
    // genuinely idle; retain the ticket for the next idle settled boundary.
    try {
      if (ctx.isIdle?.() === false) return;
    } catch {
      return;
    }
    const outcome = runtime.settleDeferredRefresh(ctx.sessionManager);
    if (!outcome) return;
    const recovery = getLiveAgentSyncRecoveryGuidance(outcome);
    if (recovery) {
      const message = "message" in outcome ? outcome.message : "no adapter diagnostic";
      ctx.ui.notify(
        `Native context replacement after settled travel ${outcome.status}: ${message}. ${recovery}`,
        "warning",
      );
    }
  });

  pi.on("context", (event, ctx: ExtensionContext) => {
    const sessionManager = ctx.sessionManager;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const pressure = calculateContextUsagePressure(usage?.tokens, usage?.contextWindow, usage?.percent);
    if (pressure) runtime.observeContextUsage(sessionManager, pressure);
    // A same-run context event may occur after acm_travel while the model is
    // deciding its next action. Preserve that run's host message sequence;
    // agent_settled unlocks the first later context event for the persisted rebuild.
    if (runtime.shouldKeepCurrentRunContext(sessionManager)) return undefined;
    if (!contextRefresh.isPending(sessionManager)) {
      const original = event.messages as AgentMessage[];
      const fixed = normalizeExistingAcmPacketForSession(original, sessionManager).messages;
      const changed = fixed.length !== original.length || fixed.some((message, index) => message !== original[index]);
      return changed ? { messages: fixed as typeof event.messages } : undefined;
    }

    const reportFailure = (message: string) => {
      const willRetry = contextRefresh.recordFailedAttempt(sessionManager, message);
      const attempt = contextRefresh.getAttemptCount(sessionManager);
      ctx.ui.notify(
        willRetry
          ? `Context refresh after travel failed (${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS}): ${message}. Will retry on the next LLM turn.`
          : `Context refresh after travel failed after ${attempt} attempts: ${message}. ${withAvailableAdvancedGuidance(pi, RECOVERY_GUIDANCE.refreshExhausted, GUIDANCE_CUES.advancedExceptionalPointer)}`,
        "warning",
      );
      return { messages: event.messages };
    };

    try {
      const packetResult = rebuildAcmContextPacket(sessionManager);
      if (!packetResult.ok) return reportFailure(packetResult.message);
      let packet = packetResult.value;
      let messages = packet.messages;
      if (messages.length === 0) {
        const fallbackLeafId = runtime.getRefreshTarget(sessionManager);
        const fallbackResult = fallbackLeafId
          ? rebuildAcmContextPacket(sessionManager, fallbackLeafId)
          : undefined;
        if (!fallbackResult) return reportFailure("rebuilt messages array is empty");
        if (!fallbackResult.ok) return reportFailure(fallbackResult.message);
        packet = fallbackResult.value;
        messages = packet.messages;
      }
      if (messages.length === 0) return reportFailure("rebuilt messages array is empty");
      if (packet.protocol.status === "invalid") {
        return reportFailure(
          `Refused persisted context packet with invalid tool protocol: ${formatToolProtocolDefects(packet.protocol.defects) || "no defect details were supplied"}`,
        );
      }

      contextRefresh.markRebuilt(sessionManager);
      // Do not release the delivery gate merely because an attempt began. A
      // failed or exhausted rebuild must stay visible as non-active context
      // delivery until a complete persisted packet has actually been rebuilt.
      runtime.consumeDeferredRefreshForNextContext(sessionManager);
      return { messages: messages as typeof event.messages };
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant" || !message.usage) return;
    const promptTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
    const contextWindow = ctx.getContextUsage()?.contextWindow;
    const pressure = calculateContextUsagePressure(promptTokens, contextWindow);
    if (pressure) {
      runtime.setUsage(ctx.sessionManager, {
        tokens: pressure.tokens,
        contextWindow: pressure.contextWindow,
        percent: pressure.usagePercent,
      });
      const baseline = runtime.observeContextUsage(ctx.sessionManager, pressure, true);
      if (baseline) {
        try {
          pi.appendEntry(CONTEXT_USAGE_NUDGE_STATE_CUSTOM_TYPE, baseline);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `Could not persist the post-transition context reminder baseline: ${message}. Reload may re-establish the baseline.`,
            "warning",
          );
        }
      }
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

  pi.on("session_compact", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
    runtime.resetContextUsageNudgeCycle(ctx.sessionManager);
  });
  // When the user summarizes an abandoned branch during manual /tree navigation
  // without custom instructions, shape the native summary as a cold-start handoff
  // so every branch_summary on the tree speaks the same seven-slot vocabulary.
  pi.on("session_before_tree", (event) => {
    const preparation = event.preparation;
    if (!preparation.userWantsSummary) return;
    if (preparation.customInstructions?.trim()) return;
    if (preparation.entriesToSummarize.length === 0) return;
    return {
      customInstructions: buildTreeSummaryInstructions(preparation.oldLeafId),
      replaceInstructions: true,
    };
  });
  // Manual /tree navigation bypasses acm_travel: the host already rebuilds live
  // messages itself, so stale refresh targets, sync tickets, and usage baselines
  // must not survive onto the newly selected branch.
  pi.on("session_tree", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
    runtime.resetContextUsageNudgeCycle(ctx.sessionManager);
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const sessionManager = ctx.sessionManager;
    runtime.clear(sessionManager);
    const getBranch = (sessionManager as { getBranch?: () => readonly unknown[] }).getBranch;
    const branch = typeof getBranch === "function" ? getBranch.call(sessionManager) : [];
    runtime.restoreContextUsageNudgeState(
      sessionManager,
      restoreContextUsageNudgeState(branch),
    );
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
}
