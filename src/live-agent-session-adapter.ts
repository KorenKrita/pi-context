import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionMessages, type ReadonlySessionManager } from "./host-bridge.js";
import { analyzeToolProtocol } from "./tool-protocol.js";

const INSTALLATION_SYMBOL = Symbol.for("pi-context.live-agent-session-adapter.v1");

interface LiveAgentSession {
  readonly sessionManager: ReadonlySessionManager;
  readonly agent: {
    readonly state: {
      messages: AgentMessage[];
    };
  };
}

type GetContextUsage = (this: LiveAgentSession, ...args: unknown[]) => unknown;
type InstalledGetContextUsage = GetContextUsage & { [INSTALLATION_SYMBOL]?: InstallationState };

export interface AgentSessionHostClass {
  readonly prototype: {
    getContextUsage: InstalledGetContextUsage;
  };
}

export type AgentSessionSyncOutcome =
  | { status: "unavailable"; reason: "unsupported_host_shape" | "unsupported_session_shape"; message: string }
  | { status: "pending"; preferredLeafId?: string }
  | { status: "applied"; leafId: string | null; messageCount: number }
  | { status: "failed"; reason: "read_leaf_failed" | "build_messages_failed" | "replace_messages_failed"; message: string }
  | { status: "skipped"; reason: "branch_not_applied" | "missing_association" | "not_pending" | "stale_leaf"; message: string };

type AgentSessionUnavailableOutcome = Extract<AgentSessionSyncOutcome, { status: "unavailable" }>;

export type AgentSessionAdapterInstallationOutcome =
  | { status: "ready" }
  | AgentSessionUnavailableOutcome;

interface PendingSync {
  readonly toolCallId: string;
  readonly preferredLeafId?: string;
}

interface InstallationState {
  readonly kind: "installed";
  readonly originalGetContextUsage: GetContextUsage;
  readonly sessions: WeakMap<object, WeakRef<object>>;
  readonly pending: WeakMap<object, PendingSync>;
  readonly outcomes: WeakMap<object, AgentSessionSyncOutcome>;
}

export interface LiveAgentSessionAdapter {
  readonly installation: AgentSessionAdapterInstallationOutcome;
  schedule(sessionManager: object, toolCallId: string, preferredLeafId?: string): AgentSessionSyncOutcome;
  apply(sessionManager: object, toolCallId: string): AgentSessionSyncOutcome;
  getStatus(sessionManager: object): AgentSessionSyncOutcome;
  clear(sessionManager: object): void;
}

export interface LiveAgentSessionAdapterOptions {
  AgentSessionClass?: AgentSessionHostClass;
}

export function getLiveAgentSyncRecoveryGuidance(outcome: AgentSessionSyncOutcome): string | null {
  if (outcome.status === "unavailable") {
    return "Persistent context rebuild remains active. Reload the session to reconstruct native AgentSession state before relying on native context accounting.";
  }
  if (outcome.status === "failed") {
    return "Persistent context rebuild remains active and the traveled branch is preserved. Reload the session to reconstruct native AgentSession state before relying on native context accounting.";
  }
  return null;
}

function unavailable(
  reason: AgentSessionUnavailableOutcome["reason"],
  message: string,
): AgentSessionUnavailableOutcome {
  return { status: "unavailable", reason, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observeSessionAssociation(state: InstallationState, value: unknown): void {
  try {
    if (!value || typeof value !== "object") return;
    const sessionManager = (value as { sessionManager?: unknown }).sessionManager;
    if (!sessionManager || typeof sessionManager !== "object") return;
    state.sessions.set(sessionManager, new WeakRef(value));
  } catch {
    // Capability observation must never change host getContextUsage behavior.
  }
}

function inspectLiveSession(value: unknown, expectedSessionManager: object):
  | { ok: true; session: LiveAgentSession }
  | { ok: false; outcome: AgentSessionUnavailableOutcome } {
  try {
    if (!value || typeof value !== "object") {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession instance is unavailable") };
    }
    const candidate = value as Partial<LiveAgentSession>;
    if (candidate.sessionManager !== expectedSessionManager) {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.sessionManager does not match the scheduled SessionManager") };
    }
    if (!candidate.agent || typeof candidate.agent !== "object" || !candidate.agent.state || typeof candidate.agent.state !== "object") {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.agent.state is unavailable") };
    }
    if (!Array.isArray(candidate.agent.state.messages)) {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.agent.state.messages is not an array") };
    }
    return { ok: true, session: candidate as LiveAgentSession };
  } catch (error) {
    return { ok: false, outcome: unavailable("unsupported_session_shape", `AgentSession capability probe failed: ${errorMessage(error)}`) };
  }
}

function replacePrototypeMethod(
  prototype: AgentSessionHostClass["prototype"],
  replacement: InstalledGetContextUsage,
): AgentSessionUnavailableOutcome | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "getContextUsage");
    const replacementDescriptor: PropertyDescriptor = descriptor && "value" in descriptor
      ? { ...descriptor, value: replacement }
      : {
          value: replacement,
          configurable: descriptor?.configurable ?? true,
          enumerable: descriptor?.enumerable ?? false,
          writable: true,
        };
    Object.defineProperty(prototype, "getContextUsage", replacementDescriptor);
    return undefined;
  } catch (error) {
    return unavailable("unsupported_host_shape", `AgentSession.getContextUsage cannot be wrapped: ${errorMessage(error)}`);
  }
}

function install(HostClass: AgentSessionHostClass): InstallationState | AgentSessionUnavailableOutcome {
  let prototype: AgentSessionHostClass["prototype"];
  let current: InstalledGetContextUsage;
  try {
    prototype = HostClass?.prototype;
    current = prototype?.getContextUsage;
  } catch (error) {
    return unavailable("unsupported_host_shape", `AgentSession.getContextUsage cannot be inspected: ${errorMessage(error)}`);
  }
  if (!prototype || typeof current !== "function") {
    return unavailable("unsupported_host_shape", "AgentSession.getContextUsage is unavailable");
  }

  const existing = current[INSTALLATION_SYMBOL];
  if (existing) return existing;

  const state: InstallationState = {
    kind: "installed",
    originalGetContextUsage: current,
    sessions: new WeakMap(),
    pending: new WeakMap(),
    outcomes: new WeakMap(),
  };
  const replacement: InstalledGetContextUsage = function (this: LiveAgentSession, ...args: unknown[]) {
    observeSessionAssociation(state, this);
    return current.apply(this, args);
  };
  Object.defineProperty(replacement, INSTALLATION_SYMBOL, { value: state });
  return replacePrototypeMethod(prototype, replacement) ?? state;
}

function isInstallationState(
  installation: InstallationState | AgentSessionUnavailableOutcome,
): installation is InstallationState {
  return "kind" in installation && installation.kind === "installed";
}

function readLeafId(sessionManager: object): string | null {
  const candidate = sessionManager as { getLeafId?: () => string | null };
  return typeof candidate.getLeafId === "function" ? candidate.getLeafId() : null;
}

function retainsMessageSequence(actual: AgentMessage[], expected: AgentMessage[]): boolean {
  return actual.length === expected.length && actual.every((message, index) => message === expected[index]);
}

/**
 * Installs the narrow capability-probed adapter. Tree mutations remain owned by Host Bridge;
 * this adapter only replaces the matching live AgentSession message array after tool completion.
 */
export function createLiveAgentSessionAdapter(
  options: LiveAgentSessionAdapterOptions = {},
): LiveAgentSessionAdapter {
  const HostClass = options.AgentSessionClass ?? AgentSession as unknown as AgentSessionHostClass;
  const installation = install(HostClass);

  if (!isInstallationState(installation)) {
    return {
      installation,
      schedule: () => installation,
      apply: () => installation,
      getStatus: () => installation,
      clear: () => undefined,
    };
  }

  const state = installation;
  const initialStatus: AgentSessionSyncOutcome = {
    status: "skipped",
    reason: "not_pending",
    message: "No AgentSession synchronization is pending",
  };
  return {
    installation: { status: "ready" },
    schedule(sessionManager, toolCallId, preferredLeafId) {
      const session = state.sessions.get(sessionManager)?.deref();
      if (!session) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "missing_association",
          message: "No live AgentSession is associated with this SessionManager",
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const inspected = inspectLiveSession(session, sessionManager);
      if (!inspected.ok) {
        state.pending.delete(sessionManager);
        state.outcomes.set(sessionManager, inspected.outcome);
        return inspected.outcome;
      }
      const outcome: AgentSessionSyncOutcome = preferredLeafId
        ? { status: "pending", preferredLeafId }
        : { status: "pending" };
      state.pending.set(sessionManager, { toolCallId, ...(preferredLeafId ? { preferredLeafId } : {}) });
      state.outcomes.set(sessionManager, outcome);
      return outcome;
    },
    apply(sessionManager, toolCallId) {
      const pending = state.pending.get(sessionManager);
      if (!pending || pending.toolCallId !== toolCallId) {
        return {
          status: "skipped",
          reason: "not_pending",
          message: "No live AgentSession synchronization matches this tool execution",
        };
      }
      state.pending.delete(sessionManager);

      let currentLeafId: string | null;
      try {
        currentLeafId = readLeafId(sessionManager);
      } catch (error) {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "read_leaf_failed",
          message: errorMessage(error),
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      if (pending.preferredLeafId && currentLeafId !== pending.preferredLeafId) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "stale_leaf",
          message: `Pending synchronization targeted ${pending.preferredLeafId}, current leaf is ${currentLeafId ?? "none"}`,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }

      const session = state.sessions.get(sessionManager)?.deref();
      if (!session) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "missing_association",
          message: "The associated live AgentSession is no longer available",
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const inspected = inspectLiveSession(session, sessionManager);
      if (!inspected.ok) {
        state.outcomes.set(sessionManager, inspected.outcome);
        return inspected.outcome;
      }

      const messagesResult = buildSessionMessages(inspected.session.sessionManager);
      if (!messagesResult.ok) {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "build_messages_failed",
          message: messagesResult.message,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const messages = analyzeToolProtocol(messagesResult.value).messages;
      try {
        inspected.session.agent.state.messages = messages;
        if (!retainsMessageSequence(inspected.session.agent.state.messages, messages)) {
          throw new Error("AgentSession.agent.state.messages did not retain the replacement message sequence");
        }
        const outcome: AgentSessionSyncOutcome = {
          status: "applied",
          leafId: currentLeafId,
          messageCount: messages.length,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      } catch (error) {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "replace_messages_failed",
          message: errorMessage(error),
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
    },
    getStatus(sessionManager) {
      return state.outcomes.get(sessionManager) ?? initialStatus;
    },
    clear(sessionManager) {
      state.pending.delete(sessionManager);
      state.outcomes.delete(sessionManager);
    },
  };
}
