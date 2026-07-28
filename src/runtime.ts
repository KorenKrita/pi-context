import type { UsageLike } from "./lib.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextRefreshRegistry } from "./lib.js";
import {
  createLiveAgentSessionAdapter,
  type AgentSessionSyncOutcome,
  type LiveAgentSessionAdapter,
} from "./live-agent-session-adapter.js";
import {
  createGaugeState,
  isGaugeDisabled,
  markGaugeShown,
  shouldShowGauge,
  type GaugeState,
} from "./context-gauge.js";
import { calculateContextUsagePressure, type ContextUsagePressure } from "./context-pressure.js";

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
  readonly sourceMessages: AgentMessage[];
}

interface ContextUsageInput {
  readonly tokens: number | null | undefined;
  readonly contextWindow: number | null | undefined;
  readonly percent: number | null | undefined;
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
 * 描述这个 SessionManager 当前能交付给模型的上下文。一次 travel 有相互独立的
 * provider 和 native 两个阶段：provider 交付在对应的持久化 tool_result 出现后
 * 切换；native AgentSession 状态只在空闲的 agent_settled 边界替换。
 */
export type ProviderDeliveryPhase =
  | "active"
  | "pending_tool_result"
  | "ready"
  | "fallback"
  | "cached_exhausted"
  | "receipt_rejected";

/**
 * 给回执和 HUD 用的兼容交付状态。provider 交付激活后仍显式保留 native 状态，而
 * 不是把两个阶段折叠成一个含糊的 "active"。
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

export class AcmSessionRuntime {
  readonly contextRefresh = new ContextRefreshRegistry();
  readonly liveAgentSessions: LiveAgentSessionAdapter;
  private readonly cachedUsage = new WeakMap<object, UsageLike>();
  private readonly refreshTargets = new WeakMap<object, string>();
  /**
   * 成功的 travel 在源 agent run 还在执行时就改变了持久化树。状态按
   * SessionManager 隔离：子代理和并行会话不能继承彼此的 settlement 门。
   */
  private readonly deferredTravelRefresh = new WeakMap<object, DeferredTravelRefreshState>();
  /**
   * 常驻仪表的里程表状态。每次上下文切换（travel、压缩、手动 /tree）都重置。和所
   * 有 runtime 状态一样按 SessionManager 隔离。
   */
  private readonly gaugeStates = new WeakMap<object, GaugeState>();

  constructor(liveAgentSessions: LiveAgentSessionAdapter = createLiveAgentSessionAdapter()) {
    this.liveAgentSessions = liveAgentSessions;
  }

  scheduleRefresh(session: object, preferredLeafId?: string): void {
    this.contextRefresh.markPending(session);
    if (preferredLeafId) this.refreshTargets.set(session, preferredLeafId);
    else this.refreshTargets.delete(session);
  }

  /**
   * 成功的 travel 记下两个独立阶段各自的 ticket。provider 停在当前有效的工具批次
   * 上，直到对应的持久化 tool_result 出现；native AgentSession 的替换仍推迟到空
   * 闲的 settled 边界。
   */
  deferPostTravelRefresh(
    session: object,
    toolCallId: string,
    preferredLeafId?: string,
  ): AgentSessionSyncOutcome {
    this.scheduleRefresh(session, preferredLeafId);
    // travel 之前 provider prompt 的用量属于上一个上下文纪元。不能让 HUD 把它错标
    // 成切换后的 provider 证据。
    this.cachedUsage.delete(session);
    // 回退指针记录的是已验证的 travel 叶节点，但 AgentSession 替换必须跟随
    // agent_settled 时的活动叶节点：travel 之后的读写和工具结果会合法地推进它。
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
    const deferred = this.deferredTravelRefresh.get(session);
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
      && (deferred.providerPhase === "pending_tool_result" || deferred.providerPhase === "fallback")
      ? deferred.toolCallId
      : undefined;
  }

  rejectProviderCutover(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.toolCallId !== toolCallId || deferred.receiptStatus !== "pending") return false;
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.liveAgentSessions.clear(session);
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase: "receipt_rejected",
      receiptStatus: "rejected",
      nativeSettled: true,
      liveAgentSessionSync: {
        status: "skipped",
        reason: "not_pending",
        message: "最终 travel 回执被拒绝，native 替换已取消",
      },
      providerError: "最终 travel 回执被拒绝",
    });
    return true;
  }

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

  recordProviderDeliveryFailure(
    session: object,
    message: string,
    disposition: "retry" | "unsafe_fallback" | "cached_exhausted" = "retry",
  ): void {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred) return;
    let providerPhase: ProviderDeliveryPhase;
    if (disposition === "cached_exhausted") providerPhase = "cached_exhausted";
    else if (disposition === "unsafe_fallback") providerPhase = "fallback";
    else providerPhase = deferred.providerPacket ? "active" : "fallback";
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      providerPhase,
      providerError: message,
    });
  }

  getCachedProviderPacket(session: object): readonly AgentMessage[] | undefined {
    return this.deferredTravelRefresh.get(session)?.providerPacket?.messages;
  }

  /**
   * 只保留宿主 provider 消息中已验证的切换后尾部。第一种匹配覆盖 native 的
   * in-flight 数组；第二种覆盖已经直接从紧凑 packet 开始下一个 provider 请求的宿
   * 主。
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

  shouldRebuildProviderContext(session: object): boolean {
    // `ready` 与首次切换的回退由 ContextRefreshRegistry 管理，因此继承它的有界重试
    // 预算。紧凑 packet 交付之后，每个 provider context 都继续重建，让后续工具产出
    // 被纳入，瞬时读取失败也能用缓存。
    return this.deferredTravelRefresh.get(session)?.providerPhase === "active";
  }

  isProviderDeliveryActive(session: object): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    // 没有成功 travel ticket 的会话本来就在用宿主的权威 provider 上下文。travel 专
    // 属的门控只在 ticket 处于 pending 或回退中时生效。
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
   * tool_execution_end 发生在所在 run settled 之前。ticket 是刻意保留的；
   * agent_settled 时只应用最新匹配的 travel ticket。
   */
  keepDeferredRefreshThroughToolExecution(session: object, toolCallId: string): boolean {
    const deferred = this.deferredTravelRefresh.get(session);
    return deferred?.toolCallId === toolCallId;
  }

  settleDeferredRefresh(session: object): AgentSessionSyncOutcome | undefined {
    const deferred = this.deferredTravelRefresh.get(session);
    if (!deferred || deferred.nativeSettled || deferred.receiptStatus !== "accepted") return undefined;
    const liveAgentSessionSync = this.liveAgentSessions.apply(session, deferred.toolCallId);
    this.deferredTravelRefresh.set(session, {
      ...deferred,
      liveAgentSessionSync,
      nativeSettled: true,
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
  /**
   * 所有 ACM 感知面共用同一个压力权威。完成过一轮的 provider 描述的是 travel 接
   * 管后的上下文；否则宿主当前的 native 用量就是手头最好的读数。
   */
  authoritativeContextPressure(
    session: object,
    hostUsage: ContextUsageInput | undefined,
  ): ContextUsagePressure | undefined {
    const providerDelivery = this.getProviderDeliveryStatus(session);
    const usage = providerDelivery.persistentMutationApplied && providerDelivery.usageObserved
      ? this.getUsage(session) ?? hostUsage
      : hostUsage;
    return calculateContextUsagePressure(usage?.tokens, usage?.contextWindow, usage?.percent);
  }

  resetUsageForModelChange(session: object): void {
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    const deferred = this.deferredTravelRefresh.get(session);
    if (deferred?.providerUsageObserved) {
      this.deferredTravelRefresh.set(session, { ...deferred, providerUsageObserved: false });
    }
  }

  resetGaugeCycle(session: object): void {
    // 上下文切换（travel、压缩、手动 /tree）让里程表归零：切换后的第一个读数总会显
    // 示一次。
    this.gaugeStates.delete(session);
  }

  clear(session: object): void {
    this.contextRefresh.clear(session);
    this.refreshTargets.delete(session);
    this.deferredTravelRefresh.delete(session);
    this.cachedUsage.delete(session);
    this.gaugeStates.delete(session);
    this.liveAgentSessions.clear(session);
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
   * 对照当前压力做里程表检查。只读：基线在 confirmGaugeShown 里、后缀真正附加之
   * 后才移动——在无法附加的结果上移动会静默吞掉这一格。
   */
  shouldShowGaugeNow(session: object, pressurePercent: number): boolean {
    if (isGaugeDisabled()) return false;
    return shouldShowGauge(this.gaugeState(session), pressurePercent);
  }

  confirmGaugeShown(session: object, pressurePercent: number): void {
    markGaugeShown(this.gaugeState(session), pressurePercent);
  }
}
