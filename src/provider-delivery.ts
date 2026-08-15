import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSessionSyncOutcome,
  LiveAgentSessionAdapter,
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
  /** Provider messages observed when this compact packet was built. Omitted
   * when the packet was built from the live provider array itself — then it
   * is `messages`, and holding a second container of the same references
   * only doubles the ticket's footprint for the refresh window. */
  readonly sourceMessages?: AgentMessage[];
}

/**
 * Structural equality over the JSON-observable projection of two messages:
 * exactly the values the old serializer would emit, in key order. This is a
 * correctness boundary — a false positive grafts an unrelated tail onto the
 * cached packet — so every case the old serializer threw on (cycles, BigInt)
 * or that cannot be compared faithfully without re-running serialization
 * (objects with toJSON) fails closed to false, which only ever declines a
 * graft, never invents one.
 */
export function stableMessageMatch(left: AgentMessage, right: AgentMessage): boolean {
  if (left === right) return true;
  try {
    return jsonEquals(left, right, [], []);
  } catch {
    // The old serializer's catch-all: getters, proxies, anything that throws
    // mid-walk is a decline, never an exception into the caller.
    return false;
  }
}

/**
 * JSON renders NaN, +Infinity and -Infinity all as "null", so they compare
 * equal to each other and to nothing else; every other primitive compares
 * exactly by ===. Functions, symbols, and BigInt never serialize as object
 * values, so they never reach this comparison as equal-by-rendering.
 */
function jsonPrimitiveEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return !Number.isFinite(left) && !Number.isFinite(right);
  }
  return false;
}

/** Enumerable own string keys that survive serialization, in stringify order. */
function jsonObjectKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(value)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested === undefined || typeof nested === "function" || typeof nested === "symbol") continue;
    keys.push(key);
  }
  return keys;
}

/** Array slots that stringify renders as null: holes, undefined, functions, symbols. */
function arrayElementJsonValue(array: unknown[], index: number): unknown {
  const value = array[index];
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  return value;
}

/**
 * Boxed primitives serialized as their primitive value, except BigInt which
 * threw. Returns the unwrapped primitive, "bigint" for the throwing case, or
 * undefined for everything else (plain objects, arrays, class instances).
 */
function boxedPrimitiveOf(value: object): string | number | boolean | "bigint" | undefined {
  switch (Object.prototype.toString.call(value)) {
    case "[object BigInt]":
      return "bigint";
    case "[object Number]":
      return (value as Number).valueOf();
    case "[object String]":
      return (value as String).valueOf();
    case "[object Boolean]":
      return (value as Boolean).valueOf();
    default:
      return undefined;
  }
}

function jsonEquals(left: unknown, right: unknown, leftAncestors: readonly unknown[], rightAncestors: readonly unknown[]): boolean {
  // BigInt threw under the old serializer, yet 1n === 1n is true in JS — any
  // identity shortcut below would accept it. Guard first, fail closed.
  if (typeof left === "bigint" || typeof right === "bigint") return false;
  // JSON renders null, NaN and ±Infinity identically as null, so that class
  // compares equal to itself and to nothing else.
  const leftNullish = left === null || (typeof left === "number" && !Number.isFinite(left));
  const rightNullish = right === null || (typeof right === "number" && !Number.isFinite(right));
  if (leftNullish || rightNullish) return leftNullish && rightNullish;
  // A cycle would have thrown under the old serializer. Checking before any
  // shortcut keeps a shared cyclic reference false on both sides — which is
  // why there is no identity shortcut inside this walk: two messages sharing
  // one cyclic sub-object must decline exactly as serialization would have.
  if (leftAncestors.includes(left) || rightAncestors.includes(right)) return false;
  const leftIsObject = typeof left === "object" && left !== null;
  const rightIsObject = typeof right === "object" && right !== null;
  // Boxed primitives serialize as their primitive value (BigInt boxes threw):
  // unwrap before the object dispatch so a wrapper meets a primitive as its
  // own value and never passes as a plain empty object.
  const leftBoxed = leftIsObject ? boxedPrimitiveOf(left) : undefined;
  const rightBoxed = rightIsObject ? boxedPrimitiveOf(right) : undefined;
  if (leftBoxed === "bigint" || rightBoxed === "bigint") return false;
  const effectiveLeft = leftBoxed !== undefined ? leftBoxed : left;
  const effectiveRight = rightBoxed !== undefined ? rightBoxed : right;
  if (typeof effectiveLeft !== "object" || effectiveLeft === null || typeof effectiveRight !== "object" || effectiveRight === null) {
    return jsonPrimitiveEquals(effectiveLeft, effectiveRight);
  }
  // toJSON is a serialization escape hatch that no AgentMessage surface uses;
  // guessing its output could graft an unrelated tail, so it fails closed.
  if (typeof (effectiveLeft as { toJSON?: unknown }).toJSON === "function" || typeof (effectiveRight as { toJSON?: unknown }).toJSON === "function") {
    return false;
  }
  if (Array.isArray(effectiveLeft) || Array.isArray(effectiveRight)) {
    if (!Array.isArray(effectiveLeft) || !Array.isArray(effectiveRight) || effectiveLeft.length !== effectiveRight.length) return false;
    const nextLeft = [...leftAncestors, effectiveLeft];
    const nextRight = [...rightAncestors, effectiveRight];
    for (let index = 0; index < effectiveLeft.length; index++) {
      if (!jsonEquals(arrayElementJsonValue(effectiveLeft, index), arrayElementJsonValue(effectiveRight, index), nextLeft, nextRight)) return false;
    }
    return true;
  }
  // Key order is part of stringify output: {a:1,b:2} and {b:2,a:1} differ.
  const leftKeys = jsonObjectKeys(effectiveLeft);
  const rightKeys = jsonObjectKeys(effectiveRight);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    if (leftKeys[index] !== rightKeys[index]) return false;
  }
  const nextLeft = [...leftAncestors, effectiveLeft];
  const nextRight = [...rightAncestors, effectiveRight];
  for (const key of leftKeys) {
    if (!jsonEquals((effectiveLeft as Record<string, unknown>)[key], (effectiveRight as Record<string, unknown>)[key], nextLeft, nextRight)) return false;
  }
  return true;
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
 * The provider-facing phase is intentionally independent from native state.
 * A travel has independent provider and native phases: provider delivery cuts
 * over after the matching persisted tool_result; native AgentSession state is
 * replaced only at an idle agent_settled boundary.
 */
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

/**
 * The provider delivery state machine behind a travel: the deferred
 * refresh ticket (pending → ready → active → fallback/cached_exhausted or
 * receipt_rejected) plus the cached provider packet. All phase transitions
 * live here; the runtime orchestrates only the cross-store side effects.
 */
export class ProviderDelivery {
  readonly liveAgentSessions: LiveAgentSessionAdapter;

  constructor(liveAgentSessions: LiveAgentSessionAdapter) {
    this.liveAgentSessions = liveAgentSessions;
  }
  private readonly tickets = new WeakMap<object, DeferredTravelRefreshState>();

  /**
   * Record both independent phase tickets for one travel. The provider
   * remains on the current valid tool batch until the matching persisted
   * tool_result arrives; native AgentSession replacement remains deferred to
   * an idle settled boundary.
   */
  defer(session: object, toolCallId: string): AgentSessionSyncOutcome {
    // The fallback pointer records the verified travel leaf, but AgentSession
    // replacement must follow the active leaf at agent_settled: post-travel
    // reads, writes, and tool results legitimately advance it before then.
    const liveAgentSessionSync = this.liveAgentSessions.schedule(session, toolCallId);
    this.tickets.set(session, {
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
    const deferred = this.tickets.get(session);
    return deferred?.receiptStatus === "pending"
      && deferred.providerPhase === "pending_tool_result"
      && !deferred.nativeSettled;
  }

  getContextDeliveryPhase(session: object): ContextDeliveryPhase {
    const deferred = this.tickets.get(session);
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
    const deferred = this.tickets.get(session);
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

  /** The matching success receipt opens provider cutover, never native replacement. */
  markCutoverReady(session: object, toolCallId: string): boolean {
    const deferred = this.tickets.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId) return false;
    if (deferred.providerPhase === "pending_tool_result" || deferred.providerPhase === "fallback") {
      const { providerError: _providerError, ...withoutError } = deferred;
      this.tickets.set(session, {
        ...withoutError,
        providerPhase: "ready",
        receiptStatus: "accepted",
      });
      return true;
    }
    return false;
  }

  getPendingTravelToolCallId(session: object): string | undefined {
    const deferred = this.tickets.get(session);
    return deferred?.receiptStatus === "pending"
      && (deferred.providerPhase === "pending_tool_result" || deferred.providerPhase === "fallback")
      ? deferred.toolCallId
      : undefined;
  }

  /** A finalized error receipt cancels both provider cutover and native replacement. */
  rejectTicket(session: object, toolCallId: string): boolean {
    const deferred = this.tickets.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId || deferred.receiptStatus !== "pending") return false;
    // The ticket is written before the adapter clears: rejection must
    // converge even if the injected adapter misbehaves. A stale adapter
    // entry is inert — status reads fall back to the recorded skipped
    // outcome — so the clear is strictly best-effort.
    this.tickets.set(session, {
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
    try {
      this.liveAgentSessions.clear(session);
    } catch {
      // Rejection has already converged; an adapter cleanup failure must
      // not resurrect the canceled ticket.
    }
    return true;
  }

  /** A persisted packet is the only provider-delivery authority after cutover. */
  activatePacket(
    session: object,
    messages: readonly AgentMessage[],
    leafId: string | null,
    sourceMessages: readonly AgentMessage[] = messages,
  ): boolean {
    const deferred = this.tickets.get(session);
    if (!deferred || deferred.receiptStatus !== "accepted" || deferred.providerPhase === "pending_tool_result") {
      return false;
    }
    const { providerError: _providerError, ...withoutError } = deferred;
    this.tickets.set(session, {
      ...withoutError,
      providerPhase: "active",
      providerPacket: { messages: [...messages], leafId, ...(sourceMessages !== messages ? { sourceMessages: [...sourceMessages] } : {}) },
    });
    return true;
  }

  /** Preserve a known compact packet instead of ever re-expanding stale raw history. */
  recordDeliveryFailure(
    session: object,
    message: string,
    disposition: "retry" | "unsafe_fallback" | "cached_exhausted" = "retry",
  ): void {
    const deferred = this.tickets.get(session);
    if (!deferred) return;
    let providerPhase: ProviderDeliveryPhase;
    if (disposition === "cached_exhausted") providerPhase = "cached_exhausted";
    else if (disposition === "unsafe_fallback") providerPhase = "fallback";
    else providerPhase = deferred.providerPacket ? "active" : "fallback";
    this.tickets.set(session, {
      ...deferred,
      providerPhase,
      providerError: message,
    });
  }

  getCachedPacket(session: object): readonly AgentMessage[] | undefined {
    return this.tickets.get(session)?.providerPacket?.messages;
  }

  /**
   * Preserve only a verified post-cutover tail from host provider messages.
   * The first match covers native in-flight arrays; the second covers a host
   * that already starts the next provider request from the compact packet.
   */
  mergeCachedPacket(
    session: object,
    incomingMessages: readonly AgentMessage[],
  ): AgentMessage[] | undefined {
    const packet = this.tickets.get(session)?.providerPacket;
    if (!packet) return undefined;
    const tail = packet.sourceMessages === undefined
      ? suffixAfterKnownPrefix(packet.messages, incomingMessages)
      : suffixAfterKnownPrefix(packet.sourceMessages, incomingMessages)
        ?? suffixAfterKnownPrefix(packet.messages, incomingMessages);
    return tail === undefined ? undefined : [...packet.messages, ...tail];
  }

  /** Retain a valid cached fallback plus its observed provider source tail. */
  cacheFallbackPacket(
    session: object,
    messages: readonly AgentMessage[],
    sourceMessages: readonly AgentMessage[],
  ): boolean {
    const deferred = this.tickets.get(session);
    const existing = deferred?.providerPacket;
    if (!deferred || !existing) return false;
    this.tickets.set(session, {
      ...deferred,
      providerPacket: {
        messages: [...messages],
        leafId: existing.leafId,
        ...(sourceMessages !== messages ? { sourceMessages: [...sourceMessages] } : {}),
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
    return this.tickets.get(session)?.providerPhase === "active";
  }

  isDeliveryActive(session: object): boolean {
    const deferred = this.tickets.get(session);
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

  markUsageObserved(session: object): void {
    const deferred = this.tickets.get(session);
    if (!deferred || !this.isDeliveryActive(session)) return;
    this.tickets.set(session, { ...deferred, providerUsageObserved: true });
  }

  /** A model change invalidates previously observed provider usage for this ticket. */
  clearUsageObserved(session: object): void {
    const deferred = this.tickets.get(session);
    if (deferred?.providerUsageObserved) {
      this.tickets.set(session, { ...deferred, providerUsageObserved: false });
    }
  }

  /**
   * tool_execution_end happens before the containing run settles. The ticket
   * is deliberately retained; only the latest matching travel ticket is
   * applied at agent_settled.
   */
  keepThroughToolExecution(session: object, toolCallId: string): boolean {
    const deferred = this.tickets.get(session);
    return deferred?.toolCallId === toolCallId;
  }

  /** Apply the latest scheduled ticket at Pi's actual run-settlement boundary. */
  settle(session: object): AgentSessionSyncOutcome | undefined {
    const deferred = this.tickets.get(session);
    if (!deferred || deferred.nativeSettled || deferred.receiptStatus !== "accepted") return undefined;
    const liveAgentSessionSync = this.liveAgentSessions.apply(session, deferred.toolCallId);
    this.tickets.set(session, {
      ...deferred,
      liveAgentSessionSync,
      nativeSettled: true,
    });
    return liveAgentSessionSync;
  }

  getLiveSyncStatus(session: object): AgentSessionSyncOutcome {
    return this.tickets.get(session)?.liveAgentSessionSync
      ?? this.liveAgentSessions.getStatus(session);
  }

  /** Native live messages verifiably describe the post-travel world. */
  nativeReplacementApplied(session: object): boolean {
    const deferred = this.tickets.get(session);
    return deferred?.nativeSettled === true && deferred.liveAgentSessionSync.status === "applied";
  }

  /** Drop the ticket entirely (session reset, compaction, manual /tree). */
  forget(session: object): void {
    this.tickets.delete(session);
  }
}
