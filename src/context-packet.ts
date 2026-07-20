import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./host-bridge.js";
import { buildSessionMessages } from "./host-bridge.js";
import { ACM_CONTINUATION_MARKER } from "./handoff.js";
import { analyzeToolProtocol, type ToolProtocolDefect, type ToolProtocolRepair } from "./tool-protocol.js";

export { ACM_CONTINUATION_MARKER } from "./handoff.js";

export interface AcmContextPacket {
  messages: AgentMessage[];
  protocol: {
    status: "complete" | "repaired" | "invalid";
    repairs: ToolProtocolRepair[];
    defects: ToolProtocolDefect[];
  };
  continuation:
    | { status: "projected"; count: number }
    | { status: "not_present" };
}

function continuationKey(summary: string, fromId: string, timestamp: number): string {
  return JSON.stringify([summary, fromId, timestamp]);
}

function trustedContinuationCounts(entries: readonly SessionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "branch_summary" || !entry.summary.startsWith(ACM_CONTINUATION_MARKER)) continue;
    const details = typeof entry.details === "object" && entry.details !== null
      ? entry.details as Record<string, unknown>
      : undefined;
    if (details?.kind !== "acm_travel" || details.handoffVersion !== 1) continue;
    const key = continuationKey(entry.summary, entry.fromId, new Date(entry.timestamp).getTime());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function projectContinuation(message: AgentMessage, trusted: Map<string, number>): AgentMessage {
  if (message.role !== "branchSummary" || !message.summary.startsWith(ACM_CONTINUATION_MARKER)) return message;
  const key = continuationKey(message.summary, message.fromId, message.timestamp);
  const remaining = trusted.get(key) ?? 0;
  if (remaining === 0) return message;
  if (remaining === 1) trusted.delete(key);
  else trusted.set(key, remaining - 1);
  const handoff = message.summary.slice(ACM_CONTINUATION_MARKER.length).replace(/^\n/, "");
  return {
    role: "custom",
    customType: "acm:continuation",
    content: [
      "[ACM CONTINUATION — AUTHORITATIVE WORKING STATE]",
      "",
      "This is your current memory after deliberate travel. Trust it exactly, including stated uncertainty.",
      "Where older surviving history conflicts with this handoff, the handoff supersedes that history.",
      "Continue directly with NEXT unless a later user message or later authoritative session state changes the objective.",
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
  const trusted = trustedContinuationCounts(activeEntries);
  let projectedCount = 0;
  const projected = messages.map((message) => {
    const next = projectContinuation(message, trusted);
    if (next !== message) projectedCount++;
    return next;
  });
  const protocol = analyzeToolProtocol(projected);
  return {
    messages: protocol.messages,
    protocol: {
      status: protocol.status,
      repairs: protocol.repairs,
      defects: protocol.defects,
    },
    continuation: projectedCount > 0
      ? { status: "projected", count: projectedCount }
      : { status: "not_present" },
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
