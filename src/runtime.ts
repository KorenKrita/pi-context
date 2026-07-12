import type { UsageLike } from "./lib.js";
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

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.cachedUsage.delete(session);
    this.liveAgentSessions.clear(session);
  }
}
