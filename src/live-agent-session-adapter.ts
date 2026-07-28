import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { rebuildAcmContextPacket } from "./context-packet.js";
import type { ReadonlySessionManager } from "./host-bridge.js";
import { formatToolProtocolDefects, type ToolProtocolDefect } from "./tool-protocol.js";

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
  | {
      status: "failed";
      reason: "read_leaf_failed" | "build_messages_failed" | "invalid_protocol" | "replace_messages_failed";
      message: string;
      defects?: ToolProtocolDefect[];
    }
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

export type AgentSessionTailPruneOutcome =
  | { status: "pruned"; removedCount: number; messageCount: number }
  | { status: "noop"; message: string }
  | AgentSessionUnavailableOutcome;

export interface LiveAgentSessionAdapter {
  readonly installation: AgentSessionAdapterInstallationOutcome;
  schedule(sessionManager: object, toolCallId: string, preferredLeafId?: string): AgentSessionSyncOutcome;
  apply(sessionManager: object, toolCallId: string): AgentSessionSyncOutcome;
  getStatus(sessionManager: object): AgentSessionSyncOutcome;
  clear(sessionManager: object): void;
  /**
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   * 中文说明。
   */
  pruneNonContinuableTail(sessionManager: object): AgentSessionTailPruneOutcome;
}

export interface LiveAgentSessionAdapterOptions {
  AgentSessionClass?: AgentSessionHostClass;
}

export function getLiveAgentSyncRecoveryGuidance(outcome: AgentSessionSyncOutcome): string | null {
  if (outcome.status === "unavailable") {
    return "持久化 context rebuild 仍在进行。请重新加载会话，以重建 native AgentSession state，再依赖 native context accounting。";
  }
  if (outcome.status === "failed") {
    return "持久化 context rebuild 仍在进行，travel 的 branch 已保留。请重新加载会话，以重建 native AgentSession state，再依赖 native context accounting。";
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
    // 中文说明。
  }
}

function inspectLiveSession(value: unknown, expectedSessionManager: object):
  | { ok: true; session: LiveAgentSession }
  | { ok: false; outcome: AgentSessionUnavailableOutcome } {
  try {
    if (!value || typeof value !== "object") {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession 实例不可用") };
    }
    const candidate = value as Partial<LiveAgentSession>;
    if (candidate.sessionManager !== expectedSessionManager) {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.sessionManager 与已调度的 SessionManager 不匹配") };
    }
    if (!candidate.agent || typeof candidate.agent !== "object" || !candidate.agent.state || typeof candidate.agent.state !== "object") {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.agent.state 不可用") };
    }
    if (!Array.isArray(candidate.agent.state.messages)) {
      return { ok: false, outcome: unavailable("unsupported_session_shape", "AgentSession.agent.state.messages 不是数组") };
    }
    return { ok: true, session: candidate as LiveAgentSession };
  } catch (error) {
    return { ok: false, outcome: unavailable("unsupported_session_shape", `AgentSession 能力探测失败: ${errorMessage(error)}`) };
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
    return unavailable("unsupported_host_shape", `AgentSession.getContextUsage 无法包装： ${errorMessage(error)}`);
  }
}

function install(HostClass: AgentSessionHostClass): InstallationState | AgentSessionUnavailableOutcome {
  let prototype: AgentSessionHostClass["prototype"];
  let current: InstalledGetContextUsage;
  try {
    prototype = HostClass?.prototype;
    current = prototype?.getContextUsage;
  } catch (error) {
    return unavailable("unsupported_host_shape", `AgentSession.getContextUsage 无法检查： ${errorMessage(error)}`);
  }
  if (!prototype || typeof current !== "function") {
    return unavailable("unsupported_host_shape", "AgentSession.getContextUsage 不可用");
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
 * 中文说明。
 * 中文说明。
 * 中文说明。
 * 中文说明。
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
      pruneNonContinuableTail: () => installation,
    };
  }

  const state = installation;
  const initialStatus: AgentSessionSyncOutcome = {
    status: "skipped",
    reason: "not_pending",
    message: "没有待处理的 AgentSession 同步",
  };
  return {
    installation: { status: "ready" },
    schedule(sessionManager, toolCallId, preferredLeafId) {
      const session = state.sessions.get(sessionManager)?.deref();
      if (!session) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "missing_association",
          message: "此 SessionManager 没有关联 live AgentSession",
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
          message: "没有与此次工具执行匹配的 live AgentSession 同步",
        };
      }

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
        state.pending.delete(sessionManager);
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "stale_leaf",
          message: `待处理同步目标为 ${pending.preferredLeafId}，当前 leaf 为 ${currentLeafId ?? "none"}`,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const session = state.sessions.get(sessionManager)?.deref();
      if (!session) {
        const outcome: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "missing_association",
          message: "关联的 live AgentSession 已不可用",
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const inspected = inspectLiveSession(session, sessionManager);
      if (!inspected.ok) {
        state.outcomes.set(sessionManager, inspected.outcome);
        return inspected.outcome;
      }

      const packetResult = rebuildAcmContextPacket(inspected.session.sessionManager);
      if (!packetResult.ok) {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "build_messages_failed",
          message: packetResult.message,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      if (packetResult.value.protocol.status === "invalid") {
        const outcome: AgentSessionSyncOutcome = {
          status: "failed",
          reason: "invalid_protocol",
          message: `因工具协议无效，拒绝 native context replacement： ${formatToolProtocolDefects(packetResult.value.protocol.defects) || "未提供 defect 详情"}`,
          defects: packetResult.value.protocol.defects,
        };
        state.outcomes.set(sessionManager, outcome);
        return outcome;
      }
      const messages = packetResult.value.messages;
      try {
        inspected.session.agent.state.messages = messages;
        if (!retainsMessageSequence(inspected.session.agent.state.messages, messages)) {
          throw new Error("AgentSession.agent.state.messages 未保留 replacement message sequence");
        }
        const outcome: AgentSessionSyncOutcome = {
          status: "applied",
          leafId: currentLeafId,
          messageCount: messages.length,
        };
        state.pending.delete(sessionManager);
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
    pruneNonContinuableTail(sessionManager) {
      const session = state.sessions.get(sessionManager)?.deref();
      if (!session) {
        return { status: "noop", message: "此 SessionManager 没有关联 live AgentSession" };
      }
      const inspected = inspectLiveSession(session, sessionManager);
      if (!inspected.ok) return inspected.outcome;
      const messages = inspected.session.agent.state.messages;
      let removedCount = 0;
      while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
        messages.pop();
        removedCount += 1;
      }
      if (removedCount === 0) {
        return { status: "noop", message: "live context 尾部已经可以继续" };
      }
      return { status: "pruned", removedCount, messageCount: messages.length };
    },
    clear(sessionManager) {
      state.pending.delete(sessionManager);
      state.outcomes.delete(sessionManager);
    },
  };
}
