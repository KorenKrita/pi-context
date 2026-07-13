import type { UsageLike } from "./lib.js";
import {
  classifyContextUsageNudgeLevel,
  type ContextUsageNudgeLevel,
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

/** Per-extension state shared only by ACM modules that participate in session lifecycle. */
export class AcmSessionRuntime {
  readonly contextRefresh = new ContextRefreshRegistry();
  readonly liveAgentSessions: LiveAgentSessionAdapter;
  private readonly cachedUsage = new WeakMap<object, UsageLike>();
  private readonly refreshTargets = new WeakMap<object, string>();
  private readonly contextUsageNudges = new WeakMap<object, {
    highestReachedLevel: 0 | ContextUsageNudgeLevel;
    baselinePending?: boolean;
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

  getRefreshTarget(session: object): string | undefined {
    return this.refreshTargets.get(session);
  }

  scheduleLiveAgentSync(
    session: object,
    toolCallId: string,
    preferredLeafId?: string,
  ): AgentSessionSyncOutcome {
    return this.liveAgentSessions.schedule(session, toolCallId, preferredLeafId);
  }

  applyLiveAgentSync(session: object, toolCallId: string): AgentSessionSyncOutcome {
    return this.liveAgentSessions.apply(session, toolCallId);
  }

  getLiveAgentSyncStatus(session: object): AgentSessionSyncOutcome {
    return this.liveAgentSessions.getStatus(session);
  }

  setUsage(session: object, usage: UsageLike): void {
    this.cachedUsage.set(session, usage);
  }

  getUsage(session: object): UsageLike | undefined {
    return this.cachedUsage.get(session);
  }

  observeContextUsage(
    session: object,
    percent: number,
    establishBaseline = false,
  ): PersistedContextUsageBaselineState | undefined {
    if (!Number.isFinite(percent) || percent < 0) return undefined;
    const state = this.contextUsageNudges.get(session) ?? { highestReachedLevel: 0 as const };
    const level = classifyContextUsageNudgeLevel(percent);
    if (state.baselinePending) {
      if (!establishBaseline) return undefined;
      state.highestReachedLevel = level;
      state.baselinePending = false;
      delete state.pending;
      this.contextUsageNudges.set(session, state);
      return {
        kind: "context-usage-baseline",
        highestReachedLevel: level,
        usagePercent: percent,
      };
    }
    if (level !== 0 && level > state.highestReachedLevel) {
      state.highestReachedLevel = level;
      state.pending = { level, usagePercent: percent };
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

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.cachedUsage.delete(session);
    this.contextUsageNudges.delete(session);
    this.liveAgentSessions.clear(session);
  }
}
