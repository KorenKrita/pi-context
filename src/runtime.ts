import { type MessageAggregate } from "./usage-estimation.js";
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

import {
  createGaugeState,
  isNewBoundary,
  isGaugeDisabled,
  markGaugeShown,
  resetGaugeOdometer,
  shouldShowGauge,
  type GaugeState,
} from "./context-gauge.js";
import { createLedgerState, type LedgerState } from "./boundary-ledger.js";

/**
 * Per-extension state shared only by ACM modules that participate in session lifecycle:
 * gauge cycle, ledger, fold caches, and travel-turn counters. Provider context needs no
 * state here: since Pi 0.87 every request is projected from the SessionManager, and the
 * `context` hook normalizes that projection statelessly.
 */
export class AcmSessionRuntime {
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
    this.gaugeStates.delete(session);
    this.foldAggregates.delete(session);
    this.foldProjections.delete(session);
    this.traceFreeVerdicts.delete(session);
    this.travelTurnCounters.delete(session);
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
