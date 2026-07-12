import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionMessages, type ReadonlySessionManager } from "./host-bridge.js";
import { fixOrphanedToolUse } from "./message-sanitizer.js";

export const SUPPORTED_AGENT_SESSION_HOST_VERSION = "0.80.6";
const INSTALLATION_SYMBOL = Symbol.for("pi-context.live-agent-session-adapter.v1");

interface LiveAgentSession {
  readonly sessionManager: ReadonlySessionManager;
  readonly agent: {
    readonly state: {
      messages: AgentMessage[];
    };
  };
}

export interface AgentSessionHostClass {
  readonly prototype: {
    getContextUsage(this: LiveAgentSession, ...args: unknown[]): unknown;
    [INSTALLATION_SYMBOL]?: InstallationState;
  };
}

export type AgentSessionSyncOutcome =
  | { status: "unavailable"; reason: "unsupported_host_version" | "unsupported_host_shape" | "host_version_unreadable"; message: string }
  | { status: "pending"; preferredLeafId?: string }
  | { status: "applied"; leafId: string | null; messageCount: number }
  | { status: "failed"; reason: "read_leaf_failed" | "build_messages_failed" | "replace_messages_failed"; message: string }
  | { status: "skipped"; reason: "branch_not_applied" | "missing_association" | "not_pending" | "stale_leaf"; message: string };

type AgentSessionUnavailableOutcome = Extract<AgentSessionSyncOutcome, { status: "unavailable" }>;

export type AgentSessionAdapterInstallationOutcome =
  | { status: "ready" }
  | AgentSessionUnavailableOutcome;

interface InstallationState {
  readonly kind: "installed";
  readonly originalGetContextUsage: AgentSessionHostClass["prototype"]["getContextUsage"];
  readonly sessions: WeakMap<object, WeakRef<LiveAgentSession>>;
  readonly pending: WeakMap<object, string | undefined>;
  readonly outcomes: WeakMap<object, AgentSessionSyncOutcome>;
}

export interface LiveAgentSessionAdapter {
  readonly installation: AgentSessionAdapterInstallationOutcome;
  schedule(sessionManager: object, preferredLeafId?: string): AgentSessionSyncOutcome;
  apply(sessionManager: object): AgentSessionSyncOutcome;
  getStatus(sessionManager: object): AgentSessionSyncOutcome;
  clear(sessionManager: object): void;
}

export interface LiveAgentSessionAdapterOptions {
  AgentSessionClass?: AgentSessionHostClass;
  hostVersion?: string;
}

export function getLiveAgentSyncRecoveryGuidance(outcome: AgentSessionSyncOutcome): string | null {
  if (outcome.status === "unavailable") {
    return `Persistent context rebuild remains active. Reload the session after installing the exact supported Pi ${SUPPORTED_AGENT_SESSION_HOST_VERSION} host if native AgentSession accounting must be refreshed.`;
  }
  if (outcome.status === "failed") {
    return "Persistent context rebuild remains active and the traveled branch is preserved. Reload the session to reconstruct native AgentSession state before relying on native context accounting.";
  }
  return null;
}

export function readInstalledAgentSessionHostVersion(): string | undefined {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let directory = start;
    while (true) {
      const manifestPath = join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
      if (existsSync(manifestPath)) {
        try {
          const hostPackage = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
          return typeof hostPackage.version === "string" ? hostPackage.version : undefined;
        } catch {
          return undefined;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

function unavailable(
  reason: AgentSessionUnavailableOutcome["reason"],
  message: string,
): AgentSessionUnavailableOutcome {
  return { status: "unavailable", reason, message };
}

function install(HostClass: AgentSessionHostClass): InstallationState | AgentSessionUnavailableOutcome {
  const prototype = HostClass?.prototype;
  if (!prototype || typeof prototype.getContextUsage !== "function") {
    return unavailable("unsupported_host_shape", "AgentSession.getContextUsage is unavailable");
  }

  const existing = Object.prototype.hasOwnProperty.call(prototype, INSTALLATION_SYMBOL)
    ? prototype[INSTALLATION_SYMBOL]
    : undefined;
  if (existing) return existing;

  const originalGetContextUsage = prototype.getContextUsage;
  const state: InstallationState = {
    kind: "installed",
    originalGetContextUsage,
    sessions: new WeakMap(),
    pending: new WeakMap(),
    outcomes: new WeakMap(),
  };
  Object.defineProperty(prototype, INSTALLATION_SYMBOL, {
    value: state,
    configurable: true,
  });
  prototype.getContextUsage = function (this: LiveAgentSession, ...args: unknown[]) {
    if (this && typeof this.sessionManager === "object" && this.sessionManager !== null) {
      const tracked = state.sessions.get(this.sessionManager)?.deref();
      if (tracked !== this) state.sessions.set(this.sessionManager, new WeakRef(this));
    }
    return originalGetContextUsage.apply(this, args);
  };
  return state;
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

/**
 * Installs the narrow pinned-host adapter. Tree mutations remain owned by Host Bridge;
 * this adapter only replaces the live AgentSession message array after a caller schedules it.
 */
export function createLiveAgentSessionAdapter(
  options: LiveAgentSessionAdapterOptions = {},
): LiveAgentSessionAdapter {
  const hostVersion = options.hostVersion ?? readInstalledAgentSessionHostVersion();
  const HostClass = options.AgentSessionClass ?? AgentSession as unknown as AgentSessionHostClass;
  let installation: InstallationState | AgentSessionUnavailableOutcome;
  if (!hostVersion) {
    installation = unavailable("host_version_unreadable", "Could not determine the installed Pi host version");
  } else if (hostVersion !== SUPPORTED_AGENT_SESSION_HOST_VERSION) {
    installation = unavailable(
      "unsupported_host_version",
      `AgentSession synchronization supports Pi ${SUPPORTED_AGENT_SESSION_HOST_VERSION}, found ${hostVersion}`,
    );
  } else {
    installation = install(HostClass);
  }

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
    schedule(sessionManager, preferredLeafId) {
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
      const outcome: AgentSessionSyncOutcome = preferredLeafId
        ? { status: "pending", preferredLeafId }
        : { status: "pending" };
      state.pending.set(sessionManager, preferredLeafId);
      state.outcomes.set(sessionManager, outcome);
      return outcome;
    },
    apply(sessionManager) {
      if (!state.pending.has(sessionManager)) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "not_pending",
          message: "No AgentSession synchronization is pending",
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const preferredLeafId = state.pending.get(sessionManager);
      let currentLeafId: string | null;
      try {
        currentLeafId = readLeafId(sessionManager);
      } catch (error) {
        state.pending.delete(sessionManager);
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "read_leaf_failed",
          message: error instanceof Error ? error.message : String(error),
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      state.pending.delete(sessionManager);
      if (preferredLeafId && currentLeafId !== preferredLeafId) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "stale_leaf",
          message: `Pending synchronization targeted ${preferredLeafId}, current leaf is ${currentLeafId ?? "none"}`,
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
      const messagesResult = buildSessionMessages(session.sessionManager);
      if (!messagesResult.ok) {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "build_messages_failed",
          message: messagesResult.message,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const messages = fixOrphanedToolUse(messagesResult.value);
      try {
        session.agent.state.messages = messages;
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
          message: error instanceof Error ? error.message : String(error),
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
