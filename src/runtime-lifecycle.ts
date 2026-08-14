import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendCheckpointLabel } from "./host-bridge.js";
import {
  createAcmPacketSnapshot,
  normalizeExistingAcmPacketForSession,
  rebuildAcmContextPacket,
} from "./context-packet.js";
import { scanProtocolAnchor } from "./anchor-scan.js";
import { analyzeToolProtocol, formatToolProtocolDefects } from "./tool-protocol.js";
import { calculateContextUsagePressure } from "./context-pressure.js";
import { buildLabelMaps } from "./label-journal.js";
import { ANCHOR_SEARCH_WINDOW } from "./conventions.js";
import { ContextRefreshRegistry } from "./context-refresh-registry.js";
import { RECOVERY_GUIDANCE, TREE_SUMMARY_INSTRUCTIONS } from "./generated-guidance.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { buildGaugeSuffix, isAcmTool, type GaugeStructure } from "./context-gauge.js";
import { estimateFoldGains, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import { buildLabelMaps as buildGaugeLabelMaps } from "./label-journal.js";
import { appendLedgerRow, buildBoundaryRow, markBoundaryCounted, modelDiscriminator, shouldCountBoundary } from "./boundary-ledger.js";

type ToolResultEventContent = { type: "text"; text: string } | { type: string };

/**
 * Append a delimited ACM suffix to the last text part of a finalized tool
 * result. Returns a tool_result patch, or undefined when the content shape
 * offers no text part to extend (never invent one — the result is a receipt).
 */
function appendSuffixPatch<T extends ToolResultEventContent>(
  content: readonly T[],
  suffix: string,
): { content: T[] } | undefined {
  for (let index = content.length - 1; index >= 0; index--) {
    const part = content[index]!;
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      const patched = [...content];
      patched[index] = { ...part, text: (part as { text: string }).text + suffix };
      return { content: patched };
    }
  }
  return undefined;
}

function isAppliedTravelReceipt(message: AgentMessage, toolCallId: string): boolean {
  if (
    message.role !== "toolResult"
    || message.toolCallId !== toolCallId
    || message.toolName !== "acm_travel"
    || message.isError
  ) return false;
  const details = typeof message.details === "object" && message.details !== null
    ? message.details as Record<string, unknown>
    : undefined;
  return details?.mutationStatus === "applied"
    && details.handoffFormat === "structured-v1"
    && typeof details.resultingLeafId === "string";
}

type FinalTravelReceipt =
  | { status: "success"; message: AgentMessage; index: number }
  | { status: "rejected" }
  | { status: "untrusted" }
  | { status: "unavailable" }
  | { status: "absent" };

function findFinalTravelReceipt(
  messages: readonly AgentMessage[],
  toolCallId: string,
): FinalTravelReceipt {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "toolResult" && message.toolCallId === toolCallId) {
      if (isAppliedTravelReceipt(message, toolCallId)) return { status: "success", message, index };
      return message.isError ? { status: "rejected" } : { status: "untrusted" };
    }
  }
  return { status: "absent" };
}

function findPersistedFinalTravelReceipt(
  sessionManager: ExtensionContext["sessionManager"],
  toolCallId: string,
): FinalTravelReceipt {
  try {
    const entries = sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      if (entry.message.toolCallId !== toolCallId) continue;
      if (isAppliedTravelReceipt(entry.message, toolCallId)) {
        return { status: "success", message: entry.message, index };
      }
      return entry.message.isError ? { status: "rejected" } : { status: "untrusted" };
    }
  } catch {
    return { status: "unavailable" };
  }
  return { status: "absent" };
}

function protocolRecoveryMessage(): AgentMessage {
  return {
    role: "custom",
    customType: "acm:protocol-recovery",
    content: "[ACM CONTEXT RECOVERY] No protocol-valid provider messages remained after defensive repair. Stop tool execution and reload or repair the session before continuing.",
    display: false,
    details: { kind: "acm-protocol-recovery", reason: "no_protocol_valid_messages" },
    timestamp: Date.now(),
  };
}

function buildSafeCurrentProviderFallback(messages: readonly AgentMessage[]): AgentMessage[] {
  const initial = analyzeToolProtocol(messages);
  if (initial.status !== "invalid" && initial.messages.length > 0) return initial.messages;
  const rejectedAssistants = new Set(initial.defects.map((defect) => defect.assistantIndex));
  const withoutMalformedAssistants = messages.filter((_message, index) => !rejectedAssistants.has(index));
  const repaired = analyzeToolProtocol(withoutMalformedAssistants);
  return repaired.status !== "invalid" && repaired.messages.length > 0
    ? repaired.messages
    : [protocolRecoveryMessage()];
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

  // Gauge pressure: actual provider usage once a travel owns provider
  // delivery, native usage otherwise. Native usage is also the fallback while
  // a provider epoch has not yet observed a turn_end (a single long run never
  // updates cached provider usage, and a gauge that goes blind mid-run
  // defeats its purpose).
  const currentGaugePressure = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    return runtime.authoritativeContextPressure(session, usage);
  };
  // Fold needles for the gauge: project what a fold at each structural
  // reference point would leave. Reference points never require a label, so a
  // session that has not checkpointed still gets both numbers. Estimation is
  // bounded to the two references the gauge renders, and a failed rebuild
  // simply omits that needle.
  const currentFoldEstimates = (ctx: ExtensionContext, pressure: { workingBudgetTokens: number; tokens: number; contextWindow: number }) => {
    const session = ctx.sessionManager;
    try {
      const branch = session.getBranch() as unknown as readonly FoldEstimateEntry[];
      if (!Array.isArray(branch) || branch.length === 0) return undefined;
      const labelMaps = buildLabelMaps(session.getEntries());
      const references = selectFoldReferences(branch, labelMaps);
      if (!references.turn && !references.task) return undefined;
      const currentPacket = rebuildAcmContextPacket(session);
      if (!currentPacket.ok) return undefined;
      const cache = new Map<string, AgentMessage[] | undefined>();
      return estimateFoldGains({
        usage: { tokens: pressure.tokens, contextWindow: pressure.contextWindow, percent: 0 },
        workingBudgetTokens: pressure.workingBudgetTokens,
        currentMessages: currentPacket.value.messages,
        messagesAt: (entryId) => {
          if (!cache.has(entryId)) {
            const result = rebuildAcmContextPacket(session, entryId);
            cache.set(entryId, result.ok ? result.value.messages : undefined);
          }
          return cache.get(entryId);
        },
      }, references);
    } catch {
      return undefined;
    }
  };
  // Ledger counters live on the runtime so fold rows written from the travel
  // receipt share this session discriminator and stay joinable.
  const recordBoundary = (
    ctx: ExtensionContext,
    pressure: { pressurePercent: number; usagePercent: number },
    folds: { turnPercent: number | null; taskPercent: number | null } | undefined,
    savePoints: number | null,
  ): void => {
    try {
      const session = ctx.sessionManager as unknown as object;
      const branch = (ctx.sessionManager as { getBranch?: () => readonly { id: string; type?: string; message?: { role?: string } }[] }).getBranch?.();
      if (!Array.isArray(branch) || branch.length === 0) return;
      let boundaryId: string | null = null;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (entry.type === "message" && entry.message?.role === "user") {
          boundaryId = entry.id;
          break;
        }
      }
      const state = runtime.ledgerState(session);
      if (!shouldCountBoundary(state, boundaryId)) return;
      const ordinal = markBoundaryCounted(state, boundaryId!);
      appendLedgerRow("boundary", buildBoundaryRow({
        state,
        boundary: ordinal,
        budgetPercent: pressure.pressurePercent,
        windowPercent: pressure.usagePercent,
        foldTurnPercent: folds?.turnPercent,
        foldTaskPercent: folds?.taskPercent,
        entries: branch.length,
        savePoints,
        model: modelDiscriminator((ctx as { model?: { provider?: unknown; id?: unknown } }).model),
      }));
    } catch {
      // A diagnostic writer must never reach the tool result.
    }
  };
  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    // tool_result handlers are chained and later extensions may still replace
    // content/details/isError. Final travel authorization is therefore read
    // only from the finalized toolResult message on the next context event.
    //
    // The constant gauge is the only decoration: numbers, no wording.
    // ACM tool results carry mutation receipts with their own usage line and
    // are never decorated; error results stay clean receipts too.
    const session = ctx.sessionManager;
    if (isAcmTool(event.toolName) || event.isError) return;
    const pressure = currentGaugePressure(ctx);
    if (!pressure) return;
    // The boundary id is a gate input, so it is resolved first — but it only
    // needs a short backward scan for the last user entry. The save-point
    // count replays the whole label journal, so it waits until the odometer
    // has actually decided to render; most readings are silenced and must
    // not pay O(entries) for a suffix that never appears.
    let boundaryId: string | null = null;
    try {
      const branch = session.getBranch();
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user") {
          boundaryId = entry.id;
          break;
        }
      }
    } catch {
      boundaryId = null;
    }
    if (!runtime.shouldShowGaugeNow(session, pressure.pressurePercent, boundaryId)) return;
    let savePoints: number | null = null;
    try {
      const branch = session.getBranch();
      const labelMaps = buildGaugeLabelMaps(session.getEntries());
      let count = 0;
      for (const entry of branch) {
        if (labelMaps.entryToLabel.get(entry.id) !== undefined) count++;
      }
      savePoints = count;
    } catch {
      savePoints = null;
    }
    const structure: GaugeStructure = {
      boundary: runtime.isNewGaugeBoundary(session, boundaryId),
      savePoints,
    };
    const folds = currentFoldEstimates(ctx, pressure);
    // Passive boundary ledger: one row per distinct user-request boundary, so
    // "boundaries crossed N, folds M" accumulates without any injection. Never
    // allowed to affect this result — every failure is swallowed inside.
    recordBoundary(ctx, pressure, folds, savePoints);
    const patch = appendSuffixPatch(event.content, buildGaugeSuffix(pressure, folds, structure));
    // Move the odometer only on actual delivery; an undeliverable result (no
    // text part) leaves the tick armed for the next tool completion.
    if (patch) runtime.confirmGaugeShown(session, pressure.pressurePercent, boundaryId);
    return patch;
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
    const pendingTravelToolCallId = runtime.getPendingTravelToolCallId(ctx.sessionManager);
    if (pendingTravelToolCallId) {
      const receipt = findPersistedFinalTravelReceipt(ctx.sessionManager, pendingTravelToolCallId);
      if (receipt.status === "success") {
        runtime.markProviderCutoverReady(ctx.sessionManager, pendingTravelToolCallId);
      } else if (receipt.status === "rejected" || receipt.status === "untrusted") {
        runtime.rejectProviderCutover(ctx.sessionManager, pendingTravelToolCallId);
        return;
      } else if (receipt.status === "unavailable") {
        ctx.ui.notify(
          "The finalized travel receipt could not be inspected at agent settlement. Native context replacement remains pending until the receipt can be verified.",
          "warning",
        );
        return;
      }
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
    const pendingTravelToolCallId = runtime.getPendingTravelToolCallId(sessionManager);
    if (pendingTravelToolCallId) {
      const finalEventReceipt = findFinalTravelReceipt(event.messages as AgentMessage[], pendingTravelToolCallId);
      const finalizedReceipt = finalEventReceipt.status === "absent"
        ? findPersistedFinalTravelReceipt(sessionManager, pendingTravelToolCallId)
        : finalEventReceipt;
      if (finalizedReceipt.status === "success") {
        runtime.markProviderCutoverReady(sessionManager, pendingTravelToolCallId);
      } else if (finalizedReceipt.status === "rejected" || finalizedReceipt.status === "untrusted") {
        runtime.rejectProviderCutover(sessionManager, pendingTravelToolCallId);
      }
    }
    // A same-run context event may occur after acm_travel while the model is
    // deciding its next action. Preserve that valid tool batch only until its
    // matching persisted receipt arrives; the receipt then unlocks immediate
    // provider delivery from the latest persisted Context Packet. Native
    // AgentSession messages still wait for agent_settled.
    //
    // branchWithSummary can leave a historical tool result behind when the
    // host appends it after the branch mutation. Do not rebuild persisted
    // context or replace native messages early, but repair that orphan in an
    // outgoing clone so the provider still receives a valid current tool pair.
    if (runtime.shouldKeepCurrentRunContext(sessionManager)) {
      const messages = event.messages as AgentMessage[];
      const analysis = analyzeToolProtocol(messages);
      // A real acm_travel cannot enter same-run delivery with invalid call
      // identity because travel prevalidation rejects that current packet.
      // Keep an explicit diagnostic for directly constructed runtimes or host
      // drift instead of silently passing an invalid provider packet through.
      if (analysis.status === "invalid") {
        ctx.ui.notify(
          `Unexpected invalid same-run tool protocol after acm_travel prevalidation: ${formatToolProtocolDefects(analysis.defects) || "no defect details were supplied"}. The current run was left unchanged; reload or repair the session before retrying travel.`,
          "warning",
        );
        return { messages: buildSafeCurrentProviderFallback(messages) as typeof event.messages };
      }
      const sanitized = analysis.messages;
      const changed = sanitized.length !== messages.length
        || sanitized.some((message, index) => message !== messages[index]);
      return changed ? { messages: sanitized as typeof event.messages } : undefined;
    }
    const providerStatus = runtime.getProviderDeliveryStatus(sessionManager);
    if (providerStatus.phase === "cached_exhausted") {
      const merged = runtime.mergeCachedProviderPacket(sessionManager, event.messages as AgentMessage[]);
      if (merged) {
        const protocol = analyzeToolProtocol(merged);
        if (protocol.status !== "invalid" && protocol.messages.length > 0) {
          runtime.cacheProviderFallbackPacket(sessionManager, protocol.messages, event.messages as AgentMessage[]);
          return { messages: protocol.messages as typeof event.messages };
        }
      }
      const safeCurrent = buildSafeCurrentProviderFallback(event.messages as AgentMessage[]);
      runtime.recordProviderDeliveryFailure(
        sessionManager,
        "Cached provider cursor no longer matches current messages after refresh exhaustion",
        "unsafe_fallback",
      );
      ctx.ui.notify(
        "Cached provider delivery could not preserve the finalized post-cutover tail after refresh exhaustion. Falling back to the current protocol-valid provider messages; reload to rebuild persistent compact context.",
        "warning",
      );
      return { messages: safeCurrent as typeof event.messages };
    }
    if (!contextRefresh.isPending(sessionManager) && !runtime.shouldRebuildProviderContext(sessionManager)) {
      const original = event.messages as AgentMessage[];
      const fixed = normalizeExistingAcmPacketForSession(original, sessionManager).messages;
      const changed = fixed.length !== original.length || fixed.some((message, index) => message !== original[index]);
      return changed ? { messages: fixed as typeof event.messages } : undefined;
    }

    const reportFailure = (message: string) => {
      const cached = runtime.getCachedProviderPacket(sessionManager);
      let cachedFallback = cached;
      let tailStatus: "merged" | "unmatched" | "invalid" | undefined;
      if (cached) {
        const merged = runtime.mergeCachedProviderPacket(sessionManager, event.messages as AgentMessage[]);
        if (merged) {
          const protocol = analyzeToolProtocol(merged);
          if (protocol.status !== "invalid") {
            cachedFallback = protocol.messages;
            runtime.cacheProviderFallbackPacket(sessionManager, protocol.messages, event.messages as AgentMessage[]);
            tailStatus = "merged";
          } else {
            tailStatus = "invalid";
          }
        } else {
          tailStatus = "unmatched";
        }
      }
      const willRetry = contextRefresh.recordFailedAttempt(sessionManager, message);
      const attempt = contextRefresh.getAttemptCount(sessionManager);
      const safeCurrent = buildSafeCurrentProviderFallback(event.messages as AgentMessage[]);
      const safeCachedTail = cached !== undefined && tailStatus === "merged";
      let disposition: "retry" | "unsafe_fallback" | "cached_exhausted";
      if (!safeCachedTail) disposition = "unsafe_fallback";
      else disposition = willRetry ? "retry" : "cached_exhausted";
      runtime.recordProviderDeliveryFailure(
        sessionManager,
        message,
        disposition,
      );
      let tailGuidance = "";
      if (tailStatus === "unmatched") {
        tailGuidance = "The latest provider tail could not be correlated safely; current protocol-valid provider messages are used until persistence recovers.";
      } else if (tailStatus === "invalid") {
        tailGuidance = "The latest provider tail is protocol-invalid; current protocol-valid provider messages are used until persistence recovers.";
      }
      let failureNotice: string;
      if (willRetry && cached) {
        failureNotice = `Context refresh after travel failed (${attempt}): ${message}. Keeping the last valid compact provider packet and retrying on the next LLM turn.`;
      } else if (willRetry) {
        failureNotice = `Context refresh after travel failed (${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS}): ${message}. Keeping current same-run messages and retrying on the next LLM turn.`;
      } else if (cached && safeCachedTail) {
        failureNotice = `Context refresh after travel failed after ${attempt} attempts: ${message}. The last protocol-valid compact packet remains active in cached_exhausted state; automatic rebuild is stopped until a new travel/lifecycle cycle. Reload to retry persistent reconstruction.`;
      } else {
        failureNotice = `Context refresh after travel failed after ${attempt} attempts: ${message}. ${RECOVERY_GUIDANCE.refreshExhausted}`;
      }
      ctx.ui.notify(failureNotice, "warning");
      if (tailGuidance) ctx.ui.notify(tailGuidance.trim(), "warning");
      return {
        messages: (safeCachedTail ? cachedFallback : safeCurrent) as typeof event.messages,
      };
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
      let leafId: string | null = null;
      try {
        leafId = sessionManager.getLeafId();
      } catch {
        // The rebuilt packet is already valid. Leaf identity is diagnostics,
        // not a reason to discard provider delivery.
      }
      // Keep a compact protocol-valid packet for all later provider retries.
      // This state is separate from native replacement and may become active
      // while the originating AgentSession still owns its old live array.
      runtime.activateProviderPacket(sessionManager, messages, leafId, event.messages as AgentMessage[]);
      return { messages: messages as typeof event.messages };
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("turn_start", (_event, ctx: ExtensionContext) => {
    runtime.resetTravelTurnCount(ctx.sessionManager);
  });

  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    // Usage becomes authoritative at provider cutover, not native settlement.
    // The origin run is stale until a compact persisted packet is actually
    // delivered; a fallback with no valid provider packet remains stale.
    if (!runtime.isProviderDeliveryActive(ctx.sessionManager)) return;
    const message = event.message;
    if (message.role !== "assistant" || !message.usage) return;
    const promptTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
    // Error/aborted turns report all-zero usage. Zero prompt tokens is not a
    // reading — caching it would flip the gauge to 0% until the next real
    // turn, while the fold needles (estimated from message text) stay
    // truthful, rendering a self-contradictory line.
    if (promptTokens <= 0) return;
    const contextWindow = ctx.getContextUsage()?.contextWindow;
    const pressure = calculateContextUsagePressure(promptTokens, contextWindow);
    if (pressure) {
      runtime.setUsage(ctx.sessionManager, {
        tokens: pressure.tokens,
        contextWindow: pressure.contextWindow,
        percent: pressure.usagePercent,
      });
      runtime.markProviderUsageObserved(ctx.sessionManager);
    }
  });

  pi.on("model_select", (_event, ctx: ExtensionContext) => {
    // Cached prompt usage belongs to the previous model's context window.
    // Until the new model completes a turn, the gauge falls back to the host's
    // current context usage and the provider HUD remains explicitly pending.
    runtime.resetUsageForModelChange(ctx.sessionManager);
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
    const scan = scanProtocolAnchor({
      branch,
      startIndex: branch.length - 1,
      window: ANCHOR_SEARCH_WINDOW,
      signal: event.signal,
      rebuild: createAcmPacketSnapshot(sessionManager).rebuild,
    });
    if (scan.aborted) return;
    const checkpointTargetId = scan.entryId ?? undefined;
    if (!checkpointTargetId) {
      ctx.ui.notify(
        `No pre-compaction checkpoint was created because no entry within the last ${ANCHOR_SEARCH_WINDOW} entries of the bounded search window can rebuild a lawful context packet.`,
        "warning",
      );
      return;
    }
    const append = appendCheckpointLabel(sessionManager, checkpointTargetId, checkpointName);
    if (!append.ok) ctx.ui.notify(`Could not create pre-compaction checkpoint: ${append.message}`, "warning");
  });

  pi.on("session_compact", (event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
    // Host bug mitigation: on overflow recovery (willRetry) the host re-reads
    // agent.state.messages after this event but only strips a trailing assistant
    // whose stopReason is "error". A "length"-stopped trailing assistant (zero-
    // output overflow, the very case the host classified as overflow) survives and
    // agentLoopContinue crashes with "Cannot continue from message role:
    // assistant". Prune every trailing assistant so the retry tail is continuable;
    // session history is untouched.
    if (event.willRetry) {
      const prune = runtime.liveAgentSessions.pruneNonContinuableTail(ctx.sessionManager);
      if (prune.status === "unavailable") {
        ctx.ui.notify(
          `ACM could not verify the overflow-retry context tail (${prune.message}); if this retry fails with "Cannot continue from message role: assistant", resume the session to recover.`,
          "warning",
        );
      }
    }
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
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // A fresh session starts a fresh odometer: the first reading after resume
    // always shows once. No persisted gauge state exists by design.
    runtime.clear(ctx.sessionManager);
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
}
