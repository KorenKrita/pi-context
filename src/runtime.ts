import type { UsageLike } from "./lib.js";
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
  readonly phase: "same_run" | "next_context";
  readonly toolCallId: string;
  readonly liveAgentSessionSync: AgentSessionSyncOutcome;
}

/**
 * Describes which context is deliverable to the model for this SessionManager.
 * A successful travel preserves the in-flight run's host messages until Pi
 * reports agent_settled; the first later context event rebuilds the persisted
 * branch.
 */
export type ContextDeliveryPhase =
  | "active"
  | "pending_run_settle"
  | "next_context_rebuild";

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
   * A successful travel changes persisted history while the agent run that
   * invoked it still owns a coherent live message sequence. Keep that sequence
   * intact until Pi reports the run fully settled; then apply the latest
   * matching AgentSession ticket and let the first later context event rebuild
   * from the persisted branch.
   */
  deferPostTravelRefresh(
    session: object,
    toolCallId: string,
    preferredLeafId?: string,
  ): AgentSessionSyncOutcome {
    this.scheduleRefresh(session, preferredLeafId);
    // The fallback pointer records the verified travel leaf, but AgentSession
    // replacement must follow the active leaf at agent_settled: post-travel
    // reads, writes, and tool results legitimately advance it before then.
    const liveAgentSessionSync = this.liveAgentSessions.schedule(session, toolCallId);
    this.deferredTravelRefresh.set(session, {
      phase: "same_run",
      toolCallId,
      liveAgentSessionSync,
    });
    return liveAgentSessionSync;
  }

  /** Keep the originating assistant run's current live context untouched. */
  shouldKeepCurrentRunContext(session: object): boolean {
    return this.deferredTravelRefresh.get(session)?.phase === "same_run";
  }

  getContextDeliveryPhase(session: object): ContextDeliveryPhase {
    const phase = this.deferredTravelRefresh.get(session)?.phase;
    if (phase === "same_run") return "pending_run_settle";
    if (phase === "next_context") return "next_context_rebuild";
    return "active";
  }

  /**
   * tool_execution_end happens before the containing run settles. The ticket
   * is deliberately retained; only the latest matching travel ticket is
   * applied at agent_settled.
   */
  keepDeferredRefreshThroughToolExecution(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.phase === "same_run" && deferred.toolCallId === toolCallId;
  }

  /** Apply the latest scheduled ticket at Pi's actual run-settlement boundary. */
  settleDeferredRefresh(session: object): AgentSessionSyncOutcome | undefined {
    const deferred = this.deferredTravelRefresh.get(session);
    if (deferred?.phase !== "same_run") return undefined;
    const liveAgentSessionSync = this.liveAgentSessions.apply(session, deferred.toolCallId);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      phase: "next_context",
      liveAgentSessionSync,
    });
    return liveAgentSessionSync;
  }

  /** Release the one-shot gate only after a successful persisted rebuild. */
  consumeDeferredRefreshForNextContext(session: object): boolean {
    if (this.deferredTravelRefresh.get(session)?.phase !== "next_context") return false;
    this.deferredTravelRefresh.delete(session);
    return true;
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
