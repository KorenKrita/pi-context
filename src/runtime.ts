import type { UsageLike } from "./lib.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextRefreshRegistry } from "./lib.js";
import {
  createLiveAgentSessionAdapter,
  type AgentSessionSyncOutcome,
  type LiveAgentSessionAdapter,
} from "./live-agent-session-adapter.js";
import {
  createGaugeState,
  isGaugeDisabled,
  markGaugeShown,
  shouldShowGauge,
  type GaugeState,
} from "./context-gauge.js";
import { calculateContextUsagePressure, type ContextUsagePressure } from "./context-pressure.js";

interface DeferredTravelRefreshState {
  readonly providerPhase: ProviderDeliveryPhase;
  readonly toolCallId: string;
  readonly receiptStatus: "pending" | "accepted" | "rejected";
  readonly liveAgentSessionSync: AgentSessionSyncOutcome;
  readonly nativeSettled: boolean;
  readonly providerUsageObserved: boolean;
  readonly providerPacket?: CachedProviderPacket;
  readonly providerError?: string;
}

interface CachedProviderPacket {
  readonly messages: AgentMessage[];
  readonly leafId: string | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  readonly sourceMessages: AgentMessage[];
}

interface ContextUsageInput {
  readonly tokens: number | null | undefined;
  readonly contextWindow: number | null | undefined;
  readonly percent: number | null | undefined;
}

function stableMessageMatch(left: AgentMessage, right: AgentMessage): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function suffixAfterKnownPrefix(
  prefix: readonly AgentMessage[],
  messages: readonly AgentMessage[],
): AgentMessage[] | undefined {
  if (messages.length < prefix.length) return undefined;
  for (let index = 0; index < prefix.length; index++) {
    if (!stableMessageMatch(prefix[index]!, messages[index]!)) return undefined;
  }
  return messages.slice(prefix.length);
}

/**
 * 中文说明。
 * 中文说明。
 * 中文说明。
 * 中文说明。
 */
/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export type ProviderDeliveryPhase =
  | "active"
  | "pending_tool_result"
  | "ready"
  | "fallback"
  | "cached_exhausted"
  | "receipt_rejected";

/**
 * 中文说明。
 * 中文说明。
 * 中文说明。
 */
export type ContextDeliveryPhase =
  | "active"
  | "pending_tool_result"
  | "ready"
  | "fallback"
  | "cached_exhausted"
  | "receipt_rejected"
  | "provider_active_native_pending"
  | "provider_active_native_applied"
  | "provider_active_native_unavailable"
  | "provider_active_native_failed"
  | "provider_active_native_skipped";

export interface ProviderDeliveryStatus {
  readonly persistentMutationApplied: boolean;
  readonly phase: ProviderDeliveryPhase;
  readonly packetMessageCount: number | null;
  readonly leafId: string | null;
  readonly error: string | null;
  readonly usageObserved: boolean;
}

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export class AcmSessionRuntime {
  readonly contextRefresh = new ContextRefreshRegistry();
  readonly liveAgentSessions: LiveAgentSessionAdapter;
  private readonly cachedUsage = new WeakMap<object, UsageLike>();
  private readonly refreshTargets = new WeakMap<object, string>();
  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  private readonly deferredTravelRefresh = new WeakMap<object, DeferredTravelRefreshState>();
  /**
   * 中文说明。
   * 中文说明。
   */
  private readonly gaugeStates = new WeakMap<object, GaugeState>();

  constructor(liveAgentSessions: LiveAgentSessionAdapter = createLiveAgentSessionAdapter()) {
    this.liveAgentSessions = liveAgentSessions;
  }

  scheduleRefresh(session: object, preferredLeafId?: string): void {
    this.contextRefresh.markPending(session);
    if (preferredLeafId) this.refreshTargets.set(session, preferredLeafId);
    else this.refreshTargets.delete(session);
  }

  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  deferPostTravelRefresh(
    session: object,
    toolCallId: string,
    preferredLeafId?: string,
  ): AgentSessionSyncOutcome {
    this.scheduleRefresh(session, preferredLeafId);
    // 中文说明。
    // 中文说明。
    this.cachedUsage.delete(session);
    // 中文说明。
    // 中文说明。
    // 中文说明。
    const liveAgentSessionSync = this.liveAgentSessions.schedule(session, toolCallId);
    this.deferredTravelRefresh.set(session, {
      providerPhase: "pending_tool_result",
      toolCallId,
      receiptStatus: "pending",
      liveAgentSessionSync,
      nativeSettled: false,
      providerUsageObserved: false,
    });
    return liveAgentSessionSync;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  shouldKeepCurrentRunContext(session: object): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.receiptStatus === "pending"
      && deferred.providerPhase === "pending_tool_result"
      && !deferred.nativeSettled;
  }

  getContextDeliveryPhase(session: object): ContextDeliveryPhase {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.providerPhase !== "active" || !deferred.providerPacket) {
      return deferred?.providerPhase ?? "active";
    }
    const syncStatus = deferred.liveAgentSessionSync.status;
    switch (syncStatus) {
      case "pending": return "provider_active_native_pending";
      case "applied": return "provider_active_native_applied";
      case "unavailable": return "provider_active_native_unavailable";
      case "failed": return "provider_active_native_failed";
      case "skipped": return "provider_active_native_skipped";
      default: {
        const unreachable: never = syncStatus;
        throw new Error(`Unhandled AgentSession sync status: ${String(unreachable)}`);
      }
    }
  }

  getProviderDeliveryStatus(session: object): ProviderDeliveryStatus {
    const deferred = this.deferredTravelRefresh.get(session);
    const packet = deferred?.providerPacket;
    return {
      persistentMutationApplied: deferred !== undefined && deferred.providerPhase !== "receipt_rejected",
      phase: deferred?.providerPhase ?? "active",
      packetMessageCount: packet?.messages.length ?? null,
      leafId: packet?.leafId ?? null,
      error: deferred?.providerError ?? null,
      usageObserved: deferred?.providerUsageObserved ?? false,
    };
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  markProviderCutoverReady(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId) return false;
    if (deferred.providerPhase === "pending_tool_result" || deferred.providerPhase === "fallback") {
      const { providerError: _providerError, ...withoutError } = deferred;
      this.deferredTravelRefresh.set(session, {
        ...withoutError,
        providerPhase: "ready",
        receiptStatus: "accepted",
      });
      return true;
    }
    return false;
  }

  getPendingTravelToolCallId(session: object): string | undefined {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.receiptStatus === "pending"
      && (deferred.providerPhase === "pending_tool_result" || deferred.providerPhase === "fallback")
      ? deferred.toolCallId
      : undefined;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  rejectProviderCutover(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId || deferred.receiptStatus !== "pending") return false;
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.liveAgentSessions.clear(session);
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase: "receipt_rejected",
      receiptStatus: "rejected",
      nativeSettled: true,
      liveAgentSessionSync: {
        status: "skipped",
        reason: "not_pending",
        message: "由于最终 travel receipt 被拒绝，native replacement 已取消",
      },
      providerError: "最终 travel receipt 被拒绝",
    });
    return true;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  activateProviderPacket(
    session: object,
    messages: readonly AgentMessage[],
    leafId: string | null,
    sourceMessages: readonly AgentMessage[] = messages,
  ): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.receiptStatus !== "accepted" || deferred.providerPhase === "pending_tool_result") {
      return false;
    }
    const { providerError: _providerError, ...withoutError } = deferred;
    this.deferredTravelRefresh.set(session, {
      ...withoutError,
      providerPhase: "active",
      providerPacket: { messages: [...messages], leafId, sourceMessages: [...sourceMessages] },
    });
    return true;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  recordProviderDeliveryFailure(
    session: object,
    message: string,
    disposition: "retry" | "unsafe_fallback" | "cached_exhausted" = "retry",
  ): void {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred) return;
    let providerPhase: ProviderDeliveryPhase;
    if (disposition === "cached_exhausted") providerPhase = "cached_exhausted";
    else if (disposition === "unsafe_fallback") providerPhase = "fallback";
    else providerPhase = deferred.providerPacket ? "active" : "fallback";
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase,
      providerError: message,
    });
  }

  getCachedProviderPacket(session: object): readonly AgentMessage[] | undefined {
    return this.deferredTravelRefresh.get(session)?.providerPacket?.messages;
  }

  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  mergeCachedProviderPacket(
    session: object,
    incomingMessages: readonly AgentMessage[],
  ): AgentMessage[] | undefined {
    const packet = this.deferredTravelRefresh.get(session)?.providerPacket;
    if (!packet) return undefined;
    const tail = suffixAfterKnownPrefix(packet.sourceMessages, incomingMessages)
      ?? suffixAfterKnownPrefix(packet.messages, incomingMessages);
    return tail === undefined ? undefined : [...packet.messages, ...tail];
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  cacheProviderFallbackPacket(
    session: object,
    messages: readonly AgentMessage[],
    sourceMessages: readonly AgentMessage[],
  ): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    const existing = deferred?.providerPacket;
    if (!deferred || !existing) return false;
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPacket: {
        messages: [...messages],
        leafId: existing.leafId,
        sourceMessages: [...sourceMessages],
      },
    });
    return true;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  shouldRebuildProviderContext(session: object): boolean {
    // 中文说明。
    // 中文说明。
    // 中文说明。
    // 中文说明。
    return this.deferredTravelRefresh.get(session)?.providerPhase === "active";
  }


  isProviderDeliveryActive(session: object): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    // 中文说明。
    // 中文说明。
    // 中文说明。
    return deferred === undefined
      || deferred.providerPhase === "receipt_rejected"
      || (
        (deferred.providerPhase === "active" || deferred.providerPhase === "cached_exhausted")
        && deferred.providerPacket !== undefined
      );
  }

  markProviderUsageObserved(session: object): void {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || !this.isProviderDeliveryActive(session)) return;
    this.deferredTravelRefresh.set(session, { ...deferred, providerUsageObserved: true });
  }

  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  keepDeferredRefreshThroughToolExecution(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.toolCallId === toolCallId;
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  settleDeferredRefresh(session: object): AgentSessionSyncOutcome | undefined {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.nativeSettled || deferred.receiptStatus !== "accepted") return undefined;
    const liveAgentSessionSync = this.liveAgentSessions.apply(session, deferred.toolCallId);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      liveAgentSessionSync,
      nativeSettled: true,
    });
    return liveAgentSessionSync;
  }

  getRefreshTarget(session: object): string | undefined {
    return this.refreshTargets.get(session);
  }

  getLiveAgentSyncStatus(session: object): AgentSessionSyncOutcome {
    return this.deferredTravelRefresh.get(session)?.liveAgentSessionSync
      ?? this.liveAgentSessions.getStatus(session);
  }

  setUsage(session: object, usage: UsageLike): void {
    this.cachedUsage.set(session, usage);
  }

  getUsage(session: object): UsageLike | undefined {
    return this.cachedUsage.get(session);
  }
  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  authoritativeContextPressure(
    session: object,
    hostUsage: ContextUsageInput | undefined,
  ): ContextUsagePressure | undefined {
    const providerDelivery = this.getProviderDeliveryStatus(session);
    const usage = providerDelivery.persistentMutationApplied && providerDelivery.usageObserved
      ? this.getUsage(session) ?? hostUsage
      : hostUsage;
    return calculateContextUsagePressure(usage?.tokens, usage?.contextWindow, usage?.percent);
  }

  resetUsageForModelChange(session: object): void {
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    const deferred = this.deferredTravelRefresh.get(session);
    if (deferred?.providerUsageObserved) {
      this.deferredTravelRefresh.set(session, { ...deferred, providerUsageObserved: false });
    }
  }

  resetGaugeCycle(session: object): void {
    // 中文说明。
    // 中文说明。
    this.gaugeStates.delete(session);
  }

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.deferredTravelRefresh.delete(session);
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    this.liveAgentSessions.clear(session);
  }

  private gaugeState(session: object): GaugeState {
    let state = this.gaugeStates.get(session);
    if (!state) {
      state = createGaugeState();
      this.gaugeStates.set(session, state);
    }
    return state;
  }

  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  shouldShowGaugeNow(session: object, pressurePercent: number): boolean {
    if (isGaugeDisabled()) return false;
    return shouldShowGauge(this.gaugeState(session), pressurePercent);
  }

  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  confirmGaugeShown(session: object, pressurePercent: number): void {
    markGaugeShown(this.gaugeState(session), pressurePercent);
  }
}
