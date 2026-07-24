import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./host-bridge.js";
import { buildSessionMessages } from "./host-bridge.js";
import { ACM_CONTINUATION_MARKER } from "./handoff.js";
import { analyzeToolProtocol, type ToolProtocolDefect, type ToolProtocolRepair } from "./tool-protocol.js";

export { ACM_CONTINUATION_MARKER } from "./handoff.js";

export type AcmProtocolNormalization = {
  kind: "removed_applied_acm_travel_receipt";
  toolCallId: string;
  summaryEntryId: string;
};

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

function trustedAppliedTravelReceipts(entries: readonly SessionEntry[]): Map<string, AcmProtocolNormalization> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const trusted = new Map<string, AcmProtocolNormalization>();
  const ambiguous = new Set<string>();
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
      || !summaryEntryId
      || receipt.resultingLeafId !== summaryEntryId
      || entry.parentId !== summaryEntryId
    ) continue;
    const summary = byId.get(summaryEntryId);
    if (
      summary?.type !== "branch_summary"
      || typeof summary.summary !== "string"
      || !summary.summary.startsWith(ACM_CONTINUATION_MARKER)
    ) continue;
    const provenance = record(summary.details);
    if (
      provenance?.kind !== "acm_travel"
      || provenance.handoffVersion !== 1
      || receipt.originId !== provenance.originId
      || receipt.targetId !== provenance.targetId
      || (typeof provenance.toolCallId === "string" && provenance.toolCallId !== message.toolCallId)
    ) continue;
    if (trusted.has(message.toolCallId)) {
      trusted.delete(message.toolCallId);
      ambiguous.add(message.toolCallId);
      continue;
    }
    if (!ambiguous.has(message.toolCallId)) {
      trusted.set(message.toolCallId, {
        kind: "removed_applied_acm_travel_receipt",
        toolCallId: message.toolCallId,
        summaryEntryId,
      });
    }
  }
  return trusted;
}

function normalizeProtocol(
  protocol: ReturnType<typeof analyzeToolProtocol>,
  activeEntries: readonly SessionEntry[],
) {
  if (protocol.status === "invalid") {
    return { ...protocol, normalizations: [] as AcmProtocolNormalization[] };
  }
  const trustedReceipts = trustedAppliedTravelReceipts(activeEntries);
  const normalizations: AcmProtocolNormalization[] = [];
  const repairs = protocol.repairs.filter((repair) => {
    if (repair.kind !== "removed_orphan_result" || repair.toolName !== "acm_travel") return true;
    const normalization = trustedReceipts.get(repair.toolCallId);
    if (!normalization) return true;
    normalizations.push(normalization);
    return false;
  });
  return {
    ...protocol,
    status: repairs.length === 0 ? "complete" as const : "repaired" as const,
    normalizations,
    repairs,
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
  // One message may only be projected when its persisted provenance has one
  // unambiguous owner. Multiple marked candidates must stay archival: their
  // order is evidence, not permission to make every handoff authoritative.
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
      "[ACM CURRENT CONTINUATION — HIGHEST-PRIORITY SESSION STATE]",
      "",
      "Travel completed. This message is the active continuation of the user's work at this point in the session.",
      "All earlier requests visible above are historical context. Do not execute or repeat them unless REQUIRED NEXT explicitly says to.",
      "Where older surviving history conflicts with this handoff, the handoff supersedes that history.",
      ...(goal ? [`CURRENT GOAL: ${goal}`] : []),
      ...(next ? [`REQUIRED NEXT: ${next}`] : []),
      ...(metadata.currentUserTurnOpen ? [
        "CURRENT USER TURN IS STILL OPEN: the request that triggered travel still requires a visible result. Do not stop, wait for another request, or treat recording the answer in State as delivery.",
      ] : []),
      "Act on REQUIRED NEXT now. Do not reread folded material, recreate old save points, or replay an earlier task unless REQUIRED NEXT requires it.",
      "Evidence and Recover are optional receipts and recovery pointers, not prerequisites: do not open them unless REQUIRED NEXT names them.",
      "A later user message or later authoritative session state may supersede this continuation.",
      "Verify only uncertainty recorded here or facts changed by later independent activity.",
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
  // Active-path ordering resolves stacked continuation epochs: the latest
  // provenance-valid ACM summary is the current authority, while older
  // summaries remain archival. Ambiguity is reserved for the latest message
  // itself having duplicate/unresolvable persisted provenance owners.
  const latestCandidate = candidates.at(-1);
  const projected = latestCandidate?.metadata
    ? messages.map((message, index) => index === latestCandidate.index
      ? projectContinuation(message, latestCandidate.metadata!)
      : message)
    : [...messages];
  const protocol = normalizeProtocol(analyzeToolProtocol(projected), activeEntries);
  return {
    messages: protocol.messages,
    protocol: {
      status: protocol.status,
      normalizations: protocol.normalizations,
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
    // Existing host-projected messages remain usable in archival form. A
    // transient or capability-incomplete branch read must not crash the
    // context lifecycle merely to upgrade ACM continuation authority.
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
