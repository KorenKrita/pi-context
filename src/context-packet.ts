import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./host-bridge.js";
import { buildSessionMessages } from "./host-bridge.js";
import { ACM_CONTINUATION_MARKER, buildCanonicalHandoff, type HandoffInput } from "./handoff.js";
import { analyzeToolProtocol, type ToolProtocolDefect, type ToolProtocolRepair } from "./tool-protocol.js";

export { ACM_CONTINUATION_MARKER } from "./handoff.js";

export type AcmProtocolNormalization = {
  kind: "removed_applied_acm_travel_receipt";
  toolCallId: string;
  summaryEntryId: string;
};

export interface TrustedAcmTravelSummaryDetails {
  toolCallId: string;
  currentUserTurnOpen: boolean;
  originId: string;
  target: string;
  targetId: string;
  backupCurrentHeadAs: string | null;
}

export interface TrustedAcmTravelTransaction {
  summaryEntryId: string;
  details: TrustedAcmTravelSummaryDetails;
  backupEntryId: string | null;
  receiptIdentity: string;
  normalization: AcmProtocolNormalization;
}

export interface AcmContextPacket {
  messages: AgentMessage[];
  protocol: {
    status: "complete" | "repaired" | "invalid";
    normalizations: AcmProtocolNormalization[];
    repairs: ToolProtocolRepair[];
    defects: ToolProtocolDefect[];
  };
  continuation:
    | { status: "projected"; count: number }
    | { status: "ambiguous"; candidates: number }
    | { status: "not_present" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function hasDomainError(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function receiptIdentity(message: AgentMessage): string | undefined {
  if (message.role !== "toolResult" || message.toolName !== "acm_travel" || !message.toolCallId) return undefined;
  try {
    return JSON.stringify({
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      details: message.details,
      isError: message.isError ?? false,
      timestamp: message.timestamp,
    });
  } catch {
    return undefined;
  }
}

function trustedTravelSummaryDetails(entry: SessionEntry | undefined): TrustedAcmTravelSummaryDetails | undefined {
  if (
    entry?.type !== "branch_summary"
    || entry.fromHook !== true
    || typeof entry.summary !== "string"
    || !isCanonicalAcmHandoff(entry.summary)
  ) return undefined;
  const details = record(entry.details);
  const toolCallId = typeof details?.toolCallId === "string" && details.toolCallId.trim().length > 0
    ? details.toolCallId
    : undefined;
  const originId = typeof details?.originId === "string" && details.originId.length > 0
    ? details.originId
    : undefined;
  const target = typeof details?.target === "string" && details.target.length > 0
    ? details.target
    : undefined;
  const targetId = typeof details?.targetId === "string" && details.targetId.length > 0
    ? details.targetId
    : undefined;
  const rawBackup = details?.backupCurrentHeadAs;
  const backupCurrentHeadAs = rawBackup === null || typeof rawBackup === "string"
    ? rawBackup
    : undefined;
  if (
    details?.kind !== "acm_travel"
    || details.handoffVersion !== 1
    || typeof details.currentUserTurnOpen !== "boolean"
    || !toolCallId
    || !originId
    || !target
    || !targetId
    || backupCurrentHeadAs === undefined
    || entry.parentId !== targetId
    || entry.fromId !== targetId
  ) return undefined;
  return {
    toolCallId,
    currentUserTurnOpen: details.currentUserTurnOpen,
    originId,
    target,
    targetId,
    backupCurrentHeadAs,
  };
}

export function collectTrustedAcmTravelTransactions(entries: readonly SessionEntry[]): TrustedAcmTravelTransaction[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const grouped = new Map<string, TrustedAcmTravelTransaction[]>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    if (message.toolName !== "acm_travel" || message.isError === true || !message.toolCallId) continue;
    const receipt = record(message.details);
    const summaryEntryId = typeof receipt?.summaryEntryId === "string" ? receipt.summaryEntryId : undefined;
    if (
      receipt?.mutationStatus !== "applied"
      || receipt.persistentMutationApplied !== true
      || receipt.handoffFormat !== "structured-v1"
      || hasDomainError(receipt.error)
      || !summaryEntryId
      || receipt.resultingLeafId !== summaryEntryId
      || entry.parentId !== summaryEntryId
    ) continue;
    const provenance = trustedTravelSummaryDetails(byId.get(summaryEntryId));
    const receiptBackupAlias = receipt.backupCurrentHeadAs;
    const backupEntryId = typeof receipt.backupEntryId === "string" && receipt.backupEntryId.length > 0
      ? receipt.backupEntryId
      : null;
    if (
      !provenance
      || receipt.originId !== provenance.originId
      || receipt.target !== provenance.target
      || receipt.targetId !== provenance.targetId
      || provenance.toolCallId !== message.toolCallId
      || receipt.currentUserTurnOpen !== provenance.currentUserTurnOpen
      || receiptBackupAlias !== provenance.backupCurrentHeadAs
      || (provenance.backupCurrentHeadAs !== null && backupEntryId === null)
    ) continue;
    const identity = receiptIdentity(message);
    if (!identity) continue;
    const transaction = {
      summaryEntryId,
      details: provenance,
      backupEntryId,
      receiptIdentity: identity,
      normalization: {
        kind: "removed_applied_acm_travel_receipt",
        toolCallId: message.toolCallId,
        summaryEntryId,
      },
    } satisfies TrustedAcmTravelTransaction;
    const key = JSON.stringify([summaryEntryId, provenance.toolCallId]);
    const candidates = grouped.get(key) ?? [];
    candidates.push(transaction);
    grouped.set(key, candidates);
  }
  return [...grouped.values()].flatMap((candidates) => candidates.length === 1 ? candidates : []);
}

function trustedAppliedTravelReceipts(entries: readonly SessionEntry[]): Map<string, AcmProtocolNormalization[]> {
  const trusted = new Map<string, AcmProtocolNormalization[]>();
  for (const transaction of collectTrustedAcmTravelTransactions(entries)) {
    const candidates = trusted.get(transaction.receiptIdentity) ?? [];
    candidates.push(transaction.normalization);
    trusted.set(transaction.receiptIdentity, candidates);
  }
  return trusted;
}

function normalizeAppliedTravelReceipts(
  messages: readonly AgentMessage[],
  activeEntries: readonly SessionEntry[],
): { messages: AgentMessage[]; normalizations: AcmProtocolNormalization[] } {
  const trustedReceipts = trustedAppliedTravelReceipts(activeEntries);
  const packetCandidates = new Map<string, number[]>();
  for (let index = 0; index < messages.length; index++) {
    const identity = receiptIdentity(messages[index]!);
    if (!identity) continue;
    const indices = packetCandidates.get(identity) ?? [];
    indices.push(index);
    packetCandidates.set(identity, indices);
  }
  const removed = new Set<number>();
  const normalizations: AcmProtocolNormalization[] = [];
  for (const [identity, persistedCandidates] of trustedReceipts) {
    const packetIndices = packetCandidates.get(identity) ?? [];
    if (persistedCandidates.length !== 1 || packetIndices.length !== 1) continue;
    removed.add(packetIndices[0]!);
    normalizations.push(persistedCandidates[0]!);
  }
  return {
    messages: messages.filter((_, index) => !removed.has(index)),
    normalizations,
  };
}

function continuationKey(summary: string, fromId: string, timestamp: number): string {
  return JSON.stringify([summary, fromId, timestamp]);
}

function canonicalField(handoff: string, label: string, nextLabel?: string): string | null {
  const prefix = label === "Goal" ? `${label}: ` : `\n${label}: `;
  const start = handoff.indexOf(prefix);
  if (start < 0) return null;
  const valueStart = start + prefix.length;
  const end = nextLabel === undefined
    ? handoff.length
    : handoff.indexOf(`\n${nextLabel}: `, valueStart);
  const raw = handoff.slice(valueStart, end < 0 ? handoff.length : end);
  return raw.replace(/\n  /g, "\n").trim() || null;
}

function isCanonicalAcmHandoff(summary: string): boolean {
  const fields = {
    goal: canonicalField(summary, "Goal", "State"),
    state: canonicalField(summary, "State", "Evidence"),
    evidence: canonicalField(summary, "Evidence", "External"),
    external: canonicalField(summary, "External", "Exclusions"),
    exclusions: canonicalField(summary, "Exclusions", "Recover"),
    recover: canonicalField(summary, "Recover", "NEXT"),
    next: canonicalField(summary, "NEXT"),
  };
  if (Object.values(fields).some((value) => value === null)) return false;
  const rebuilt = buildCanonicalHandoff(fields as HandoffInput);
  return rebuilt.ok && rebuilt.value.text === summary;
}

interface TrustedContinuationMetadata {
  currentUserTurnOpen: boolean;
}

function trustedContinuationQueues(entries: readonly SessionEntry[]): Map<string, TrustedContinuationMetadata[]> {
  const queues = new Map<string, TrustedContinuationMetadata[]>();
  for (const entry of entries) {
    if (
      entry.type !== "branch_summary"
      || typeof entry.summary !== "string"
      || !entry.summary.startsWith(ACM_CONTINUATION_MARKER)
    ) continue;
    const details = typeof entry.details === "object" && entry.details !== null
      ? entry.details as Record<string, unknown>
      : undefined;
    if (details?.kind !== "acm_travel" || details.handoffVersion !== 1) continue;
    const key = continuationKey(entry.summary, entry.fromId, new Date(entry.timestamp).getTime());
    const queue = queues.get(key) ?? [];
    queue.push({ currentUserTurnOpen: details.currentUserTurnOpen === true });
    queues.set(key, queue);
  }
  return queues;
}

function trustedContinuationMetadata(
  message: AgentMessage,
  trusted: ReadonlyMap<string, TrustedContinuationMetadata[]>,
): { metadata?: TrustedContinuationMetadata; candidates: number } | undefined {
  if (
    message.role !== "branchSummary"
    || typeof message.summary !== "string"
    || !message.summary.startsWith(ACM_CONTINUATION_MARKER)
  ) return undefined;
  const key = continuationKey(message.summary, message.fromId, message.timestamp);
  const candidates = trusted.get(key);
  // 一条消息只有在持久化来源有唯一归属时才允许投影。多个带标记的候选必须
  // 保持存档形态：它们的先后顺序是证据，不是把每份交接单都当成权威的许可。
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length !== 1) return { candidates: candidates.length };
  const metadata = candidates[0];
  return metadata ? { metadata, candidates: 1 } : { candidates: 1 };
}

function projectContinuation(message: AgentMessage, metadata: TrustedContinuationMetadata): AgentMessage {
  if (message.role !== "branchSummary" || typeof message.summary !== "string") return message;
  const handoff = message.summary.slice(ACM_CONTINUATION_MARKER.length).replace(/^\n/, "");
  const goal = canonicalField(handoff, "Goal", "State");
  const next = canonicalField(handoff, "NEXT");
  return {
    role: "custom",
    customType: "acm:continuation",
    content: [
      "[ACM 折叠续接 — 当前工作状态]",
      "",
      "折叠已完成。下面这份交接单就是你当前的工作状态，取代上面更早的历史；冲突时以交接单为准。",
      ...(goal ? [`当前目标: ${goal}`] : []),
      ...(next ? [`立即执行: ${next}`] : []),
      ...(metadata.currentUserTurnOpen ? [
        "本轮用户消息尚未答复：触发折叠的那个请求仍欠一个可见结果，State 里记了答案不等于已交付。",
      ] : []),
      "现在直接执行上面的下一步，不要重做或重读已折叠的内容；更晚的用户消息出现时以用户消息为准。",
      "",
      handoff,
    ].join("\n"),
    display: false,
    details: { kind: "acm-continuation", version: 1, fromId: message.fromId },
    timestamp: message.timestamp,
  };
}

export function normalizeExistingAcmPacket(
  messages: readonly AgentMessage[],
  activeEntries: readonly SessionEntry[] = [],
): AcmContextPacket {
  const trusted = trustedContinuationQueues(activeEntries);
  const candidates = messages.flatMap((message, index) => {
    const match = trustedContinuationMetadata(message, trusted);
    return match ? [{ index, ...match }] : [];
  });
  // 活动路径的先后顺序解决了叠层续接纪元的归属：最新的、来源可信的 ACM
  // 摘要是当前权威，更早的摘要保持存档形态。“歧义”只留给最新消息本身
  // 出现重复或无法归属的持久化来源的情形。
  const latestCandidate = candidates.at(-1);
  const projected = latestCandidate?.metadata
    ? messages.map((message, index) => index === latestCandidate.index
      ? projectContinuation(message, latestCandidate.metadata!)
      : message)
    : [...messages];
  const normalized = normalizeAppliedTravelReceipts(projected, activeEntries);
  const protocol = analyzeToolProtocol(normalized.messages);
  return {
    messages: protocol.messages,
    protocol: {
      status: protocol.status,
      normalizations: normalized.normalizations,
      repairs: protocol.repairs,
      defects: protocol.defects,
    },
    continuation: latestCandidate === undefined
      ? { status: "not_present" }
      : latestCandidate.metadata
        ? { status: "projected", count: 1 }
        : { status: "ambiguous", candidates: latestCandidate.candidates },
  };
}

export function normalizeExistingAcmPacketForSession(
  messages: readonly AgentMessage[],
  sessionManager: ReadonlySessionManager,
): AcmContextPacket {
  try {
    return normalizeExistingAcmPacket(messages, sessionManager.getBranch());
  } catch {
    // 宿主已投影的消息以存档形态照样可用。分支读取只是瞬时失败或能力不完整时，
    // 不能仅仅为了升级 ACM 续接权威就让整个上下文生命周期崩溃。
    return normalizeExistingAcmPacket(messages);
  }
}

export function rebuildAcmContextPacket(
  sessionManager: ReadonlySessionManager,
  leafId?: string | null,
) {
  const result = buildSessionMessages(sessionManager, leafId);
  if (!result.ok) return result;
  let activeEntries: SessionEntry[];
  try {
    activeEntries = leafId === null
      ? []
      : leafId === undefined
        ? sessionManager.getBranch()
        : sessionManager.getBranch(leafId);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false as const,
      error: "host_operation_failed" as const,
      message: `Failed to read active branch entries for ACM context projection: ${cause}`,
      details: { leafId: leafId ?? null, cause },
    };
  }
  return { ok: true as const, value: normalizeExistingAcmPacket(result.value, activeEntries) };
}
