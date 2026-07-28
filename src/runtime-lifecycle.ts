import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendCheckpointLabel } from "./host-bridge.js";
import { normalizeExistingAcmPacketForSession, rebuildAcmContextPacket } from "./context-packet.js";
import { analyzeToolProtocol, formatToolProtocolDefects } from "./tool-protocol.js";
import { calculateContextUsagePressure } from "./context-pressure.js";
import { ANCHOR_SEARCH_WINDOW, buildLabelMaps, ContextRefreshRegistry } from "./lib.js";
import { RECOVERY_GUIDANCE, TREE_SUMMARY_INSTRUCTIONS } from "./generated-guidance.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { buildGaugeSuffix, isAcmTool } from "./context-gauge.js";
import { estimateFoldGains, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import { appendLedgerRow, buildBoundaryRow, createLedgerState, markBoundaryCounted, shouldCountBoundary, type LedgerState } from "./boundary-ledger.js";

type ToolResultEventContent = { type: "text"; text: string } | { type: string };

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

export function buildTreeSummaryInstructions(oldLeafId: string | null): string {
  if (!oldLeafId) return TREE_SUMMARY_INSTRUCTIONS;
  return `${TREE_SUMMARY_INSTRUCTIONS}\n\n废弃分支末端是节点 ${oldLeafId}。除非分支包含更具体的存档，否则请在 Recover 槽中写出它。`;
}

export function registerAcmLifecycle(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const contextRefresh = runtime.contextRefresh;

  pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "acm_travel") return;
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    runtime.keepDeferredRefreshThroughToolExecution(ctx.sessionManager, event.toolCallId);
  });

  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  const currentGaugePressure = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    return runtime.authoritativeContextPressure(session, usage);
  };
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
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
  const ledgerStates = new WeakMap<object, LedgerState>();
  let ledgerSeq = 0;
  const ledgerFor = (session: object): LedgerState => {
    let state = ledgerStates.get(session);
    if (!state) {
      ledgerSeq += 1;
      state = createLedgerState(`${process.pid}-${Date.now().toString(36)}-${ledgerSeq}`);
      ledgerStates.set(session, state);
    }
    return state;
  };
  const recordBoundary = (
    ctx: ExtensionContext,
    pressure: { pressurePercent: number; usagePercent: number },
    folds: { turnPercent: number | null; taskPercent: number | null } | undefined,
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
      const state = ledgerFor(session);
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
      }));
    } catch {
      // 实现细节与生命周期安全约束。
    }
  };
  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    const session = ctx.sessionManager;
    if (isAcmTool(event.toolName) || event.isError) return;
    const pressure = currentGaugePressure(ctx);
    if (!pressure) return;
    if (!runtime.shouldShowGaugeNow(session, pressure.pressurePercent)) return;
    const folds = currentFoldEstimates(ctx, pressure);
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    recordBoundary(ctx, pressure, folds);
    const patch = appendSuffixPatch(event.content, buildGaugeSuffix(pressure, folds));
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    if (patch) runtime.confirmGaugeShown(session, pressure.pressurePercent);
    return patch;
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
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
          "agent settled 时无法检查已完成的 travel 回执。在回执可验证前，native 上下文替换保持 pending。",
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
        `settled travel 后的 native 上下文替换 ${outcome.status}: ${message}. ${recovery}`,
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
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    if (runtime.shouldKeepCurrentRunContext(sessionManager)) {
      const messages = event.messages as AgentMessage[];
      const analysis = analyzeToolProtocol(messages);
      // 实现细节与生命周期安全约束。
      // 实现细节与生命周期安全约束。
      // 实现细节与生命周期安全约束。
      // 实现细节与生命周期安全约束。
      if (analysis.status === "invalid") {
        ctx.ui.notify(
          `Unexpected invalid same-run tool protocol after acm_travel prevalidation: ${formatToolProtocolDefects(analysis.defects) || "未提供缺陷详情"}. 当前运行未改变；重试 travel 前请重新加载或修复会话。`,
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
        "刷新耗尽后缓存的 provider 游标不再匹配当前消息",
        "unsafe_fallback",
      );
      ctx.ui.notify(
        "刷新耗尽后，缓存的 provider 交付无法保留 cutover 后的最终尾部。回退到当前协议有效的 provider 消息；重新加载会话以重建持久化压缩上下文。",
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
        tailGuidance = "无法安全关联最新 provider 尾部；持久化恢复前使用当前协议有效的 provider 消息。";
      } else if (tailStatus === "invalid") {
        tailGuidance = "最新 provider 尾部的工具协议无效；持久化恢复前使用当前协议有效的 provider 消息。";
      }
      let failureNotice: string;
      if (willRetry && cached) {
        failureNotice = `travel 后的上下文刷新失败 (${attempt}): ${message}. 保留上一个有效的压缩 provider packet，并在下一次 LLM turn 重试。`;
      } else if (willRetry) {
        failureNotice = `travel 后的上下文刷新失败 (${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS}): ${message}. 保留当前同轮消息，并在下一次 LLM turn 重试。`;
      } else if (cached && safeCachedTail) {
        failureNotice = `travel 后的上下文刷新经 ${attempt} 次尝试后仍失败: ${message}. 上一个协议有效的压缩 packet 仍处于 cached_exhausted 状态；新的 travel/lifecycle cycle 前停止自动重建。重新加载会话以重试持久化重建。`;
      } else {
        failureNotice = `travel 后的上下文刷新经 ${attempt} 次尝试后仍失败: ${message}. ${RECOVERY_GUIDANCE.refreshExhausted}`;
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
        if (!fallbackResult) return reportFailure("重建的消息数组为空");
        if (!fallbackResult.ok) return reportFailure(fallbackResult.message);
        packet = fallbackResult.value;
        messages = packet.messages;
      }
      if (messages.length === 0) return reportFailure("重建的消息数组为空");
      if (packet.protocol.status === "invalid") {
        return reportFailure(
          `拒绝协议无效的持久化上下文 packet: ${formatToolProtocolDefects(packet.protocol.defects) || "未提供缺陷详情"}`,
        );
      }

      contextRefresh.markRebuilt(sessionManager);
      let leafId: string | null = null;
      try {
        leafId = sessionManager.getLeafId();
      } catch {
        // 实现细节与生命周期安全约束。
        // 实现细节与生命周期安全约束。
      }
      // 实现细节与生命周期安全约束。
      // 实现细节与生命周期安全约束。
      // 实现细节与生命周期安全约束。
      runtime.activateProviderPacket(sessionManager, messages, leafId, event.messages as AgentMessage[]);
      return { messages: messages as typeof event.messages };
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    if (!runtime.isProviderDeliveryActive(ctx.sessionManager)) return;
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
      runtime.markProviderUsageObserved(ctx.sessionManager);
    }
  });

  pi.on("model_select", (_event, ctx: ExtensionContext) => {
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
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
    let checkpointTargetId: string | undefined;
    let inspected = 0;
    for (let index = branch.length - 1; index >= 0 && inspected < ANCHOR_SEARCH_WINDOW; index--, inspected++) {
      if (event.signal?.aborted) return;
      const candidate = branch[index];
      if (!candidate) continue;
      const packet = rebuildAcmContextPacket(sessionManager, candidate.id);
      if (packet.ok && packet.value.protocol.status === "complete") {
        checkpointTargetId = candidate.id;
        break;
      }
    }
    if (!checkpointTargetId) {
      ctx.ui.notify(
        `未创建压缩前 checkpoint，因为最近 ${ANCHOR_SEARCH_WINDOW} 个条目的有界搜索窗口内不存在协议完整的锚点。`,
        "warning",
      );
      return;
    }
    const append = appendCheckpointLabel(sessionManager, checkpointTargetId, checkpointName);
    if (!append.ok) ctx.ui.notify(`无法创建压缩前 checkpoint： ${append.message}`, "warning");
  });

  pi.on("session_compact", (event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    if (event.willRetry) {
      const prune = runtime.liveAgentSessions.pruneNonContinuableTail(ctx.sessionManager);
      if (prune.status === "unavailable") {
        ctx.ui.notify(
          `ACM 无法验证溢出重试上下文尾部 (${prune.message}); 如果此次重试因 "Cannot continue from message role: assistant" 失败，请恢复会话。`,
          "warning",
        );
      }
    }
  });
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
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
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  // 实现细节与生命周期安全约束。
  pi.on("session_tree", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // 实现细节与生命周期安全约束。
    // 实现细节与生命周期安全约束。
    runtime.clear(ctx.sessionManager);
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => runtime.clear(ctx.sessionManager));
}
