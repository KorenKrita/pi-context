import { type MessageAggregate, type UsageLike } from "./usage-estimation.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LabelMaps } from "./label-journal.js";
/** One cached fold projection: the compact facts the checkpoints view renders
 * per target, kept instead of the packet itself so the per-entry memory is a
 * few numbers regardless of session depth - the packet and its branch arrays
 * are O(history) each and are released as soon as the numbers are derived. */
export interface FoldProjectionCacheEntry {
  aggregate: MessageAggregate;
  projectedSummaryDepth: number;
}

import { ContextRefreshRegistry } from "./context-refresh-registry.js";
import {
  createLiveAgentSessionAdapter,
  type LiveAgentSessionAdapter,
} from "./live-agent-session-adapter.js";
import {
  createGaugeState,
  isNewBoundary,
  isGaugeDisabled,
  markGaugeShown,
  resetGaugeOdometer,
  shouldShowGauge,
  type GaugeState,
} from "./context-gauge.js";
import { calculateContextUsagePressure, type ContextUsagePressure } from "./context-pressure.js";
import { createLedgerState, type LedgerState } from "./boundary-ledger.js";
import { ProviderDelivery } from "./provider-delivery.js";

export type {
  ContextDeliveryPhase,
  ProviderDeliveryPhase,
  ProviderDeliveryStatus,
} from "./provider-delivery.js";

interface ContextUsageInput {
  readonly tokens: number | null | undefined;
  readonly contextWindow: number | null | undefined;
  readonly percent: number | null | undefined;
}

/**
 * Describes which context is deliverable to the model for this SessionManager.
 * The provider delivery phases themselves live in provider-delivery.ts; this
 * re-export keeps existing import paths stable.
 */
/**
 * Per-extension state shared only by ACM modules that participate in session lifecycle.
 * Provider delivery is a deep module of its own; the runtime keeps the
 * cross-store orchestration (refresh scheduling, usage cache, gauge cycle,
 * ledger, travel-turn counters) and the single pressure authority.
 */
export class AcmSessionRuntime {
  readonly contextRefresh = new ContextRefreshRegistry();
  readonly liveAgentSessions: LiveAgentSessionAdapter;
  private readonly delivery: ProviderDelivery;
  private readonly cachedUsage = new WeakMap<object, UsageLike>();
  private readonly refreshTargets = new WeakMap<object, string>();
  /**
   * Constant-gauge odometer state. Reset on every context transition (travel,
   * compaction, manual /tree). Per SessionManager, like all runtime state.
   */
  private readonly gaugeStates = new WeakMap<object, GaugeState>();
  /**
   * Passive boundary/fold ledger counters, one per SessionManager so fold
   * rows and boundary rows share a session discriminator and can be joined.
   * Deliberately NOT touched by clear(): compaction, manual /tree, and
   * session_start reset perception state, but the ledger's "session" is the
   * SessionManager's lifetime in this process — changing the discriminator
   * mid-session would sever the join the ledger exists to provide.
   */
  private readonly ledgerStates = new WeakMap<object, LedgerState>();
  private ledgerSeq = 0;
  /**
   * Token/message aggregates behind the gauge fold needles, per SessionManager.
   * Values are two numbers — no message bodies are retained. The current-leaf
   * slot keys on (leafId, entries length, last entry id) so any append or
   * branch move misses; historical leaves key on the entry id alone, sound
   * because the session is append-only. Unlike the ledger counters above,
   * this cache IS dropped by clear(): compaction and session surgery are
   * exactly the events whose key math no longer holds.
   */
  private readonly foldAggregates = new WeakMap<object, {
    currentKey: string | null;
    currentValue: MessageAggregate | undefined;
    targets: Map<string, MessageAggregate>;
  }>();
  /**
   * Compact fold projections, same key faces as the aggregates: the
   * checkpoints view's per-target cost is the rebuild (protocol analysis),
   * so the rebuild's derived facts are cached instead of its packet. Each
   * entry is a few numbers, so the limit safely tracks the checkpoints
   * view's full result-entry budget. Dropped by clear() with the aggregates.
   */
  private readonly foldProjections = new WeakMap<object, {
    currentKey: string | null;
    currentEntry: FoldProjectionCacheEntry | undefined;
    targets: Map<string, FoldProjectionCacheEntry>;
  }>();
  private static readonly FOLD_PROJECTION_CACHE_LIMIT = 512;
  /**
   * Trace-free branch verdicts for the context-event normalize path. Keyed
   * like the other caches on (branch length, last entry id): every host
   * mutation is an append with a fresh id, so a verdict can only flip when
   * the key changes. Unlike a module-level cache, this one is dropped by
   * clear() — session surgery (compact, /tree, start) re-establishes the
   * verdict from a scan, not from a key that predates the surgery.
   */
  private readonly traceFreeVerdicts = new WeakMap<object, string>();
  private static readonly FOLD_TARGET_CACHE_LIMIT = 8;
  /**
   * Label-journal replay, cached per SessionManager on the same key face as
   * the fold aggregates (entries length + last entry id): the journal is
   * append-only, so any label change misses, and clear() drops the entry for
   * the same session-surgery reasons. One replay serves the save-point count
   * and the fold reference selection on a gauge render instead of two.
   */
  private readonly labelMapsCache = new WeakMap<object, { key: string; maps: LabelMaps }>();
  /**
   * Travels completed within the current assistant turn. Low-capability
   * models have oscillated between return tickets (11 travels in one turn in
   * matrix testing); the count feeds a loop-guard line on the receipt.
   * Reset on turn_start via the lifecycle hooks.
   */
  private readonly travelTurnCounters = new WeakMap<object, number>();

  /** Record one completed travel this turn and return the running count. */
  noteTravelThisTurn(session: object): number {
    const next = (this.travelTurnCounters.get(session) ?? 0) + 1;
    this.travelTurnCounters.set(session, next);
    return next;
  }

  /** A new turn starts with a clean travel count. */
  resetTravelTurnCount(session: object): void {
    this.travelTurnCounters.delete(session);
  }

  constructor(liveAgentSessions: LiveAgentSessionAdapter = createLiveAgentSessionAdapter()) {
    this.liveAgentSessions = liveAgentSessions;
    this.delivery = new ProviderDelivery(liveAgentSessions);
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
  ) {
    this.scheduleRefresh(session, preferredLeafId);
    // Usage from the pre-travel provider prompt belongs to the previous context
    // epoch. Do not let the HUD relabel it as post-cutover provider evidence.
    this.cachedUsage.delete(session);
    return this.delivery.defer(session, toolCallId);
  }

  /** Keep the originating assistant run's current valid tool batch untouched. */
  shouldKeepCurrentRunContext(session: object): boolean {
    return this.delivery.shouldKeepCurrentRunContext(session);
  }

  getContextDeliveryPhase(session: object) {
    return this.delivery.getContextDeliveryPhase(session);
  }

  getProviderDeliveryStatus(session: object) {
    return this.delivery.getProviderDeliveryStatus(session);
  }

  /** The matching success receipt opens provider cutover, never native replacement. */
  markProviderCutoverReady(session: object, toolCallId: string): boolean {
    return this.delivery.markCutoverReady(session, toolCallId);
  }

  getPendingTravelToolCallId(session: object): string | undefined {
    return this.delivery.getPendingTravelToolCallId(session);
  }

  /** A finalized error receipt cancels both provider cutover and native replacement. */
  rejectProviderCutover(session: object, toolCallId: string): boolean {
    if (!this.delivery.rejectTicket(session, toolCallId)) return false;
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.cachedUsage.delete(session);
    this.resetGaugeCycle(session);
    return true;
  }

  /** A persisted packet is the only provider-delivery authority after cutover. */
  activateProviderPacket(
    session: object,
    messages: readonly AgentMessage[],
    leafId: string | null,
    sourceMessages: readonly AgentMessage[] = messages,
  ): boolean {
    return this.delivery.activatePacket(session, messages, leafId, sourceMessages);
  }

  /** Preserve a known compact packet instead of ever re-expanding stale raw history. */
  recordProviderDeliveryFailure(
    session: object,
    message: string,
    disposition: "retry" | "unsafe_fallback" | "cached_exhausted" = "retry",
  ): void {
    this.delivery.recordDeliveryFailure(session, message, disposition);
  }

  getCachedProviderPacket(session: object): readonly AgentMessage[] | undefined {
    return this.delivery.getCachedPacket(session);
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
    return this.delivery.mergeCachedPacket(session, incomingMessages);
  }

  /** Retain a valid cached fallback plus its observed provider source tail. */
  cacheProviderFallbackPacket(
    session: object,
    messages: readonly AgentMessage[],
    sourceMessages: readonly AgentMessage[],
  ): boolean {
    return this.delivery.cacheFallbackPacket(session, messages, sourceMessages);
  }

  /** True whenever a travel still owns provider delivery, including cached retry fallback. */
  shouldRebuildProviderContext(session: object): boolean {
    return this.delivery.shouldRebuildProviderContext(session);
  }

  isProviderDeliveryActive(session: object): boolean {
    return this.delivery.isDeliveryActive(session);
  }

  markProviderUsageObserved(session: object): void {
    this.delivery.markUsageObserved(session);
  }

  /**
   * tool_execution_end happens before the containing run settles. The ticket
   * is deliberately retained; only the latest matching travel ticket is
   * applied at agent_settled.
   */
  keepDeferredRefreshThroughToolExecution(session: object, toolCallId: string): boolean {
    return this.delivery.keepThroughToolExecution(session, toolCallId);
  }

  /** Apply the latest scheduled ticket at Pi's actual run-settlement boundary. */
  settleDeferredRefresh(session: object) {
    return this.delivery.settle(session);
  }

  getRefreshTarget(session: object): string | undefined {
    return this.refreshTargets.get(session);
  }

  getLiveAgentSyncStatus(session: object) {
    return this.delivery.getLiveSyncStatus(session);
  }

  setUsage(session: object, usage: UsageLike): void {
    this.cachedUsage.set(session, usage);
  }

  getUsage(session: object): UsageLike | undefined {
    return this.cachedUsage.get(session);
  }
  /**
   * One pressure authority for every ACM perception surface. Between a
   * travel's provider cutover and its native replacement, the host's native
   * estimate describes the pre-travel branch, so only actual provider
   * turn_end usage is trusted — one LLM call behind, bounded by the current
   * tool batch, self-healing. Once the native live messages are verifiably
   * the post-travel world, the native estimate is real-time and correct
   * again, and staying on the cached value would keep a lag with no
   * compensating benefit.
   */
  authoritativeContextPressure(
    session: object,
    hostUsage: ContextUsageInput | undefined,
  ): ContextUsagePressure | undefined {
    const usage = this.isProviderUsageAuthoritative(session)
      ? this.getUsage(session) ?? hostUsage
      : hostUsage;
    return calculateContextUsagePressure(usage?.tokens, usage?.contextWindow, usage?.percent);
  }

  /**
   * Single authority decision for every perception surface (gauge, timeline
   * HUD): cached provider turn_end usage governs only inside the window where
   * the native estimate still describes the pre-travel branch.
   */
  isProviderUsageAuthoritative(session: object): boolean {
    const providerDelivery = this.getProviderDeliveryStatus(session);
    return providerDelivery.persistentMutationApplied
      && providerDelivery.usageObserved
      && !this.delivery.nativeReplacementApplied(session);
  }

  resetUsageForModelChange(session: object): void {
    this.cachedUsage.delete(session);
    this.resetGaugeCycle(session);
    this.delivery.clearUsageObserved(session);
  }

  resetGaugeCycle(session: object): void {
    // A context transition (travel, model change) restarts the pressure
    // odometer: the first post-transition reading always shows once. Boundary
    // tracking survives so the same user request never re-renders its
    // boundary marker after a mid-request transition; full boundary resets
    // happen only in clear() (new session, compaction, manual /tree).
    const state = this.gaugeStates.get(session);
    if (state) resetGaugeOdometer(state);
  }

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.delivery.forget(session);
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    this.liveAgentSessions.clear(session);
    this.foldAggregates.delete(session);
    this.foldProjections.delete(session);
    this.labelMapsCache.delete(session);
  }

  /**
   * One aggregate through the per-session cache. `rebuild` is the cold path
   * (packet rebuild + token sum) and runs only on a miss; a rebuild that
   * yields nothing is not negatively cached, so the next render retries.
   */
  foldAggregate(
    session: object,
    key: { kind: "current"; leafId: string | null; entriesLength: number; lastEntryId: string } | { kind: "target"; entryId: string },
    rebuild: () => MessageAggregate | undefined,
  ): MessageAggregate | undefined {
    let state = this.foldAggregates.get(session);
    if (!state) {
      state = { currentKey: null, currentValue: undefined, targets: new Map() };
      this.foldAggregates.set(session, state);
    }
    if (key.kind === "current") {
      const compositeKey = `${key.leafId}|${key.entriesLength}|${key.lastEntryId}`;
      if (state.currentKey === compositeKey && state.currentValue !== undefined) return state.currentValue;
      const value = rebuild();
      if (value === undefined) return undefined;
      state.currentKey = compositeKey;
      state.currentValue = value;
      return value;
    }
    const hit = state.targets.get(key.entryId);
    if (hit !== undefined) {
      // Refresh recency on hit: eviction must remove the least-recently-used
      // target, not merely the longest-ago-inserted one, or a hot reference
      // gets repeatedly evicted and rebuilt.
      state.targets.delete(key.entryId);
      state.targets.set(key.entryId, hit);
      return hit;
    }
    const value = rebuild();
    if (value === undefined) return undefined;
    state.targets.set(key.entryId, value);
    while (state.targets.size > AcmSessionRuntime.FOLD_TARGET_CACHE_LIMIT) {
      const oldest = state.targets.keys().next().value;
      if (oldest === undefined) break;
      state.targets.delete(oldest);
    }
    return value;
  }

  /** Trace-free verdict through the per-session cache. Only positive verdicts
   * are cached - a traced branch always re-runs the probe - and clear() drops
   * the entry so session surgery cannot inherit a pre-surgery verdict. */
  traceFreeVerdictFor(session: object, branch: readonly SessionEntry[], probe: () => boolean): boolean {
    const key = `${branch.length}|${branch.at(-1)?.id ?? ""}`;
    if (this.traceFreeVerdicts.get(session) === key) return true;
    if (!probe()) return false;
    this.traceFreeVerdicts.set(session, key);
    return true;
  }

  /**
   * One compact fold projection through the per-session cache - the same key
   * faces and miss semantics as foldAggregate, for views whose per-target
   * cost is the rebuild (protocol analysis) rather than the token sum. The
   * rebuild callback derives the projection and releases the packet. A
   * rebuild that yields nothing is not negatively cached.
   */
  foldProjection(
    session: object,
    key: { kind: "current"; leafId: string | null; entriesLength: number; lastEntryId: string } | { kind: "target"; entryId: string },
    rebuild: () => FoldProjectionCacheEntry | undefined,
  ): FoldProjectionCacheEntry | undefined {
    let state = this.foldProjections.get(session);
    if (!state) {
      state = { currentKey: null, currentEntry: undefined, targets: new Map() };
      this.foldProjections.set(session, state);
    }
    if (key.kind === "current") {
      const compositeKey = `${key.leafId}|${key.entriesLength}|${key.lastEntryId}`;
      if (state.currentKey === compositeKey && state.currentEntry !== undefined) return state.currentEntry;
      const entry = rebuild();
      if (entry === undefined) return undefined;
      state.currentKey = compositeKey;
      state.currentEntry = entry;
      return entry;
    }
    const hit = state.targets.get(key.entryId);
    if (hit !== undefined) {
      state.targets.delete(key.entryId);
      state.targets.set(key.entryId, hit);
      return hit;
    }
    const entry = rebuild();
    if (entry === undefined) return undefined;
    state.targets.set(key.entryId, entry);
    while (state.targets.size > AcmSessionRuntime.FOLD_PROJECTION_CACHE_LIMIT) {
      const oldest = state.targets.keys().next().value;
      if (oldest === undefined) break;
      state.targets.delete(oldest);
    }
    return entry;
  }
  /**
   * Label maps through the per-session cache, keyed like the fold aggregates:
   * the journal is append-only, so (entries length, last entry id) keys are
   * sound, and clear() invalidates on session surgery. `entries` is the array
   * the caller already read; `rebuild` runs the full replay only on a miss.
   */
  labelMapsFor(session: object, entries: readonly SessionEntry[], rebuild: () => LabelMaps): LabelMaps {
    const key = `${entries.length}|${entries.at(-1)?.id ?? ""}`;
    let state = this.labelMapsCache.get(session);
    if (!state) {
      state = { key: "", maps: undefined! };
      this.labelMapsCache.set(session, state);
    }
    if (state.key === key && state.maps !== undefined) return state.maps;
    const maps = rebuild();
    state.key = key;
    state.maps = maps;
    return maps;
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
   * One ledger state per SessionManager: boundary rows (lifecycle) and fold
   * rows (travel receipts) must carry the same session discriminator or the
   * per-session boundary↔fold join — the ledger's whole purpose — breaks.
   */
  ledgerState(session: object): LedgerState {
    let state = this.ledgerStates.get(session);
    if (!state) {
      this.ledgerSeq += 1;
      state = createLedgerState(`${process.pid}-${Date.now().toString(36)}-${this.ledgerSeq}`);
      this.ledgerStates.set(session, state);
    }
    return state;
  }

  /**
   * Odometer check against the current pressure. Read-only: the baseline
   * moves in confirmGaugeShown, only after the suffix is actually attached
   * (moving it on an undeliverable result would silently swallow the tick).
   */
  shouldShowGaugeNow(session: object, pressurePercent: number, boundaryId?: string | null): boolean {
    if (isGaugeDisabled()) return false;
    return shouldShowGauge(this.gaugeState(session), pressurePercent, boundaryId);
  }

  /** Is this reading the first one of a new user boundary? */
  isNewGaugeBoundary(session: object, boundaryId?: string | null): boolean {
    return isNewBoundary(this.gaugeState(session), boundaryId);
  }

  /** Move the odometer after its suffix was actually attached. */
  confirmGaugeShown(session: object, pressurePercent: number, boundaryId?: string | null): void {
    markGaugeShown(this.gaugeState(session), pressurePercent, boundaryId);
  }
}
