import type { UsageLike } from "./lib.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  classifyContextUsageNudgeLevel,
  type ContextUsageNudgeLevel,
  type ContextUsagePressure,
  type PendingContextUsageNudge,
  type PersistedContextUsageBaselineState,
  type RestoredContextUsageNudgeState,
} from "./context-usage-nudge.js";
import { ContextRefreshRegistry } from "./lib.js";
import {
  createLiveAgentSessionAdapter,
  type AgentSessionSyncOutcome,
  type LiveAgentSessionAdapter,
} from "./live-agent-session-adapter.js";

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
  /** Provider messages observed when this compact packet was built. */
  readonly sourceMessages: AgentMessage[];
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
 * Describes which context is deliverable to the model for this SessionManager.
 * A travel has independent provider and native phases. Provider delivery cuts
 * over after the matching persisted tool_result; native AgentSession state is
 * replaced only at an idle agent_settled boundary.
 */
/** The provider-facing phase is intentionally independent from native state. */
export type ProviderDeliveryPhase =
  | "active"
  | "pending_tool_result"
  | "ready"
  | "fallback"
  | "cached_exhausted"
  | "receipt_rejected";

/**
 * Compatibility delivery state for receipts/HUD. Once provider delivery is
 * active it keeps native state explicit instead of collapsing both phases into
 * an ambiguous generic "active".
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

/** Per-extension state shared only by ACM modules that participate in session lifecycle. */
export class AcmSessionRuntime {
  readonly contextRefresh = new ContextRefreshRegistry();
  readonly liveAgentSessions: LiveAgentSessionAdapter;
  private readonly cachedUsage = new WeakMap<object, UsageLike>();
  private readonly refreshTargets = new WeakMap<object, string>();
  /**
   * A successful travel changes the persisted tree while its originating agent
   * run is still executing. The state is per SessionManager: subagents and
   * parallel sessions must not inherit one another's settlement gate.
   */
  private readonly deferredTravelRefresh = new WeakMap<object, DeferredTravelRefreshState>();
  private readonly contextUsageNudges = new WeakMap<object, {
    highestReachedLevel: 0 | ContextUsageNudgeLevel;
    baselinePending?: boolean;
    /** Landing tier seeded by a successful travel; wins over the first real sample when the baseline is established. */
    seededBaselineLevel?: 0 | ContextUsageNudgeLevel;
    pending?: PendingContextUsageNudge;
  }>();

  constructor(liveAgentSessions: LiveAgentSessionAdapter = createLiveAgentSessionAdapter()) {
    this.liveAgentSessions = liveAgentSessions;
  }

  scheduleRefresh(session: object, preferredLeafId?: string): void {
    this.contextRefresh.markPending(session);
    if (preferredLeafId) this.refreshTargets.set(session, preferredLeafId);
    else this.refreshTargets.delete(session);
  }

  /**
   * A successful travel records both independent phase tickets. The provider
   * remains on the current valid tool batch until the matching persisted
   * tool_result arrives; native AgentSession replacement remains deferred to
   * an idle settled boundary.
   */
  deferPostTravelRefresh(
    session: object,
    toolCallId: string,
    preferredLeafId?: string,
  ): AgentSessionSyncOutcome {
    this.scheduleRefresh(session, preferredLeafId);
    // Usage from the pre-travel provider prompt belongs to the previous context
    // epoch. Do not let the HUD relabel it as post-cutover provider evidence.
    this.cachedUsage.delete(session);
    // The fallback pointer records the verified travel leaf, but AgentSession
    // replacement must follow the active leaf at agent_settled: post-travel
    // reads, writes, and tool results legitimately advance it before then.
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

  /** Keep the originating assistant run's current valid tool batch untouched. */
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
    switch (deferred.liveAgentSessionSync.status) {
      case "pending": return "provider_active_native_pending";
      case "applied": return "provider_active_native_applied";
      case "unavailable": return "provider_active_native_unavailable";
      case "failed": return "provider_active_native_failed";
      case "skipped": return "provider_active_native_skipped";
    }
  }

  getProviderDeliveryStatus(session: object): ProviderDeliveryStatus {
    const deferred = this.deferredTravelRefresh.get(session);
    const packet = deferred?.providerPacket;
    return {
      persistentMutationApplied: deferred !== undefined,
      phase: deferred?.providerPhase ?? "active",
      packetMessageCount: packet?.messages.length ?? null,
      leafId: packet?.leafId ?? null,
      error: deferred?.providerError ?? null,
      usageObserved: deferred?.providerUsageObserved ?? false,
    };
  }

  /** The matching success receipt opens provider cutover, never native replacement. */
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
      && (deferred?.providerPhase === "pending_tool_result" || deferred?.providerPhase === "fallback")
      ? deferred.toolCallId
      : undefined;
  }

  /** A finalized error receipt cancels both provider cutover and native replacement. */
  rejectProviderCutover(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId || deferred.receiptStatus !== "pending") return false;
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.liveAgentSessions.clear(session);
    this.cachedUsage.delete(session);
    this.contextUsageNudges.set(session, { highestReachedLevel: 0, baselinePending: true });
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase: "receipt_rejected",
      receiptStatus: "rejected",
      nativeSettled: true,
      liveAgentSessionSync: {
        status: "skipped",
        reason: "not_pending",
        message: "Native replacement was canceled because the finalized travel receipt was rejected",
      },
      providerError: "Finalized travel receipt was rejected",
    });
    return true;
  }

  /** A persisted packet is the only provider-delivery authority after cutover. */
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

  /** Preserve a known compact packet instead of ever re-expanding stale raw history. */
  recordProviderDeliveryFailure(
    session: object,
    message: string,
    disposition: "retry" | "unsafe_fallback" | "cached_exhausted" = "retry",
  ): void {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred) return;
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase: disposition === "cached_exhausted"
        ? "cached_exhausted"
        : disposition === "unsafe_fallback"
          ? "fallback"
          : deferred.providerPacket
            ? "active"
            : "fallback",
      providerError: message,
    });
  }

  getCachedProviderPacket(session: object): readonly AgentMessage[] | undefined {
    return this.deferredTravelRefresh.get(session)?.providerPacket?.messages;
  }

  /**
   * Preserve only a verified post-cutover tail from host provider messages.
   * The first match covers native in-flight arrays; the second covers a host
   * that already starts the next provider request from the compact packet.
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

  /** Retain a valid cached fallback plus its observed provider source tail. */
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

  /** True whenever a travel still owns provider delivery, including cached retry fallback. */
  shouldRebuildProviderContext(session: object): boolean {
    // `ready` and first-cutover fallback are governed by ContextRefreshRegistry
    // and therefore retain its bounded retry budget. Once a compact packet has
    // been delivered, keep rebuilding on every provider context so later tool
    // work is incorporated and a transient read failure can use the cache.
    return this.deferredTravelRefresh.get(session)?.providerPhase === "active";
  }

  shouldObserveNativeContextUsage(session: object): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred === undefined || deferred.providerPhase === "receipt_rejected";
  }

  isProviderDeliveryActive(session: object): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    // Sessions without a successful travel ticket already use the host's
    // authoritative provider context. Travel-specific gating applies only
    // while a ticket is pending/falling back.
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
   * tool_execution_end happens before the containing run settles. The ticket
   * is deliberately retained; only the latest matching travel ticket is
   * applied at agent_settled.
   */
  keepDeferredRefreshThroughToolExecution(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.toolCallId === toolCallId;
  }

  /** Apply the latest scheduled ticket at Pi's actual run-settlement boundary. */
  settleDeferredRefresh(session: object): AgentSessionSyncOutcome | undefined {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.nativeSettled || deferred.receiptStatus !== "accepted") return undefined;
    const liveAgentSessionSync = this.liveAgentSessions.apply(session, deferred.toolCallId);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      liveAgentSessionSync,
      nativeSettled: true,
      providerPhase: deferred.providerPhase,
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

  observeContextUsage(
    session: object,
    pressure: ContextUsagePressure,
    establishBaseline = false,
  ): PersistedContextUsageBaselineState | undefined {
    const state = this.contextUsageNudges.get(session) ?? { highestReachedLevel: 0 as const };
    const level = classifyContextUsageNudgeLevel(pressure.pressurePercent);
    if (state.baselinePending) {
      if (!establishBaseline) return undefined;
      // A travel-seeded landing tier wins over the first real sample: same-turn
      // regrowth after a shallow fold must not consume tiers the cycle never
      // reminded about. Unseeded cycles (compaction, manual /tree) keep the
      // sampled level, preserving their quiet period.
      state.highestReachedLevel = state.seededBaselineLevel ?? level;
      delete state.seededBaselineLevel;
      state.baselinePending = false;
      delete state.pending;
      this.contextUsageNudges.set(session, state);
      return {
        kind: "context-usage-baseline",
        highestReachedLevel: state.highestReachedLevel,
        ...pressure,
      };
    }
    if (level !== 0 && level > state.highestReachedLevel) {
      state.highestReachedLevel = level;
      state.pending = { level, ...pressure };
    }
    this.contextUsageNudges.set(session, state);
    return undefined;
  }

  takePendingContextUsageNudge(session: object): PendingContextUsageNudge | undefined {
    const state = this.contextUsageNudges.get(session);
    if (!state?.pending) return undefined;
    const pending = state.pending;
    delete state.pending;
    return pending;
  }

  restoreContextUsageNudgeState(session: object, state: RestoredContextUsageNudgeState): void {
    this.contextUsageNudges.set(session, { ...state });
  }

  resetContextUsageNudgeCycle(session: object): void {
    this.contextUsageNudges.set(session, {
      highestReachedLevel: 0,
      baselinePending: true,
    });
  }

  /**
   * Seed the pending cycle's baseline tier from a successful travel's verified
   * landing estimate. The first real post-transition usage still establishes
   * (and persists) the baseline, but the seeded tier — not that sample's tier —
   * becomes highestReachedLevel, so tiers above the landing point stay armed.
   */
  seedContextUsageNudgeBaseline(session: object, landingLevel: 0 | ContextUsageNudgeLevel): void {
    const state = this.contextUsageNudges.get(session);
    if (!state?.baselinePending) return;
    state.seededBaselineLevel = landingLevel;
    this.contextUsageNudges.set(session, state);
  }

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.deferredTravelRefresh.delete(session);
    this.cachedUsage.delete(session);
    this.contextUsageNudges.delete(session);
    this.liveAgentSessions.clear(session);
  }
}
