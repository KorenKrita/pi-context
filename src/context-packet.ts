import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./host-bridge.js";
import { buildSessionMessages, createSessionSnapshot } from "./host-bridge.js";
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

function normalizeAppliedTravelReceipts(
  messages: readonly AgentMessage[],
  trustedTransactions: readonly TrustedAcmTravelTransaction[],
): { messages: AgentMessage[]; normalizations: AcmProtocolNormalization[] } {
  // Receipts arrive pre-collected: the caller already scanned the branch for
  // its fast-path decision, so a second O(entries) collection here would be
  // the only reason a traced session pays double.
  const trustedReceipts = new Map<string, AcmProtocolNormalization[]>();
  for (const transaction of trustedTransactions) {
    const candidates = trustedReceipts.get(transaction.receiptIdentity) ?? [];
    candidates.push(transaction.normalization);
    trustedReceipts.set(transaction.receiptIdentity, candidates);
  }
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
  target?: string;
  returnTicket?: string;
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
    queue.push({
      currentUserTurnOpen: details.currentUserTurnOpen === true,
      ...(typeof details.target === "string" && details.target.length > 0 ? { target: details.target } : {}),
      ...(typeof details.backupCurrentHeadAs === "string" && details.backupCurrentHeadAs.length > 0
        ? { returnTicket: details.backupCurrentHeadAs }
        : {}),
    });
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
      "[ACM CONTINUATION — ACTIVE SESSION STATE AFTER TRAVEL]",
      "",
      "Travel completed. This message is the active continuation of the user's work; where older surviving history conflicts with it, this handoff wins.",
      // The replay fence is the one deliberate prohibition on this surface:
      // stale requests surviving above this message are the highest-harm
      // failure (phantom replay), and the affirmative-copy evidence covers
      // pre-travel fold reluctance, not post-travel fences. Registered as a
      // narrow exception in AGENTS.md; everything else here is affirmative.
      "All earlier requests visible above are historical context. Do not execute or repeat an earlier request unless REQUIRED NEXT explicitly reactivates it.",
      ...(metadata.target ? [
        `Fold result: returned to '${metadata.target}'. The replaced history stays archived${metadata.returnTicket ? ` — return ticket '${metadata.returnTicket}' reopens it via acm_travel` : ""}.`,
      ] : []),
      ...(goal ? [`CURRENT GOAL: ${goal}`] : []),
      ...(next ? [`REQUIRED NEXT: ${next}`] : []),
      ...(metadata.currentUserTurnOpen ? [
        "CURRENT USER TURN IS STILL OPEN: continue this turn until you deliver a visible result to the user. Recording the answer in State records progress; visible delivery completes the turn.",
      ] : []),
      "Act on REQUIRED NEXT now, treating this handoff as the working state. Reopen folded material only when REQUIRED NEXT names a specific fact to verify, reading just what that fact needs, and create save points for new work.",
      "Evidence lists supporting references; Recover lists targets that reopen archived history. Use them only when REQUIRED NEXT points to them.",
      "A later user message or later authoritative session state may supersede this continuation. Recheck only facts recorded as uncertain here, or facts that later activity outside this conversation may have changed.",
      "",
      "The full handoff follows; CURRENT GOAL and REQUIRED NEXT above quote its Goal and NEXT fields.",
      handoff,
    ].join("\n"),
    display: false,
    details: { kind: "acm-continuation", version: 1, fromId: message.fromId },
    timestamp: message.timestamp,
  };
}

/** Both branch scans a normalize needs, collected once so callers with a
 * cache can reuse the verdict. */
interface BranchTrace {
  trusted: Map<string, TrustedContinuationMetadata[]>;
  trustedTransactions: readonly TrustedAcmTravelTransaction[];
}

function analyzeBranchTrace(activeEntries: readonly SessionEntry[]): BranchTrace {
  return {
    trusted: trustedContinuationQueues(activeEntries),
    trustedTransactions: collectTrustedAcmTravelTransactions(activeEntries),
  };
}

function isTraceFree(trace: BranchTrace): boolean {
  return trace.trusted.size === 0 && trace.trustedTransactions.length === 0;
}

/** The trace-free packet: no projection, no removal, only protocol analysis —
 * the outgoing packet's own requirement, never skipped. analyzeToolProtocol
 * does not mutate its input, so the original array passes through untouched. */
function buildTraceFreePacket(messages: readonly AgentMessage[]): AcmContextPacket {
  const protocol = analyzeToolProtocol(messages);
  return {
    messages: protocol.messages,
    protocol: {
      status: protocol.status,
      normalizations: [],
      repairs: protocol.repairs,
      defects: protocol.defects,
    },
    continuation: { status: "not_present" },
  };
}

function normalizeWithTrace(
  messages: readonly AgentMessage[],
  trace: BranchTrace,
): AcmContextPacket {
  const trusted = trace.trusted;
  const trustedTransactions = trace.trustedTransactions;
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
  const normalized = normalizeAppliedTravelReceipts(projected, trustedTransactions);
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

export function normalizeExistingAcmPacket(
  messages: readonly AgentMessage[],
  activeEntries: readonly SessionEntry[] = [],
): AcmContextPacket {
  const trace = analyzeBranchTrace(activeEntries);
  if (isTraceFree(trace)) return buildTraceFreePacket(messages);
  return normalizeWithTrace(messages, trace);
}

export function normalizeExistingAcmPacketForSession(
  messages: readonly AgentMessage[],
  sessionManager: ReadonlySessionManager,
  verdictCache?: { traceFreeVerdictFor(session: object, branch: readonly SessionEntry[], probe: () => boolean): boolean },
): AcmContextPacket {
  try {
    const branch = sessionManager.getBranch();
    // Every context event pays this normalize; on a trace-free branch the two
    // entry scans are pure overhead once the verdict is known. The verdict
    // rides the runtime's per-session cache (cleared by clear(), so session
    // surgery re-scans instead of inheriting a pre-surgery key); callers
    // without a runtime skip the cache entirely. The probe runs the scans
    // once and hands the trace back so a traced branch pays nothing twice.
    if (verdictCache) {
      let trace: BranchTrace | undefined;
      const traceFree = verdictCache.traceFreeVerdictFor(sessionManager as object, branch, () => {
        trace = analyzeBranchTrace(branch);
        return isTraceFree(trace);
      });
      if (traceFree) return buildTraceFreePacket(messages);
      return normalizeWithTrace(messages, trace ?? analyzeBranchTrace(branch));
    }
    const trace = analyzeBranchTrace(branch);
    if (isTraceFree(trace)) return buildTraceFreePacket(messages);
    return normalizeWithTrace(messages, trace);
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

/** A snapshot rebuild's success carries the branch it just read, so callers
 * that need the entries (fold-depth projections, structural checks) do not
 * walk getBranch(leafId) a second time for a fact already in hand. */
export type AcmPacketSnapshotOk = { ok: true; value: AcmContextPacket; branch: SessionEntry[] };

export interface AcmPacketSnapshot {
  /** Rebuild one explicit leaf's packet on the shared entries/ID index; null means the root/empty branch, matching rebuildAcmContextPacket. */
  rebuild(leafId: string | null): Exclude<ReturnType<typeof rebuildAcmContextPacket>, { ok: true }> | AcmPacketSnapshotOk;
}

/**
 * Snapshot-backed packet rebuild for scans that consult many candidate
 * leaves: entries and the ID index are read once, while protocol analysis
 * per leaf — the semantic work — still runs per candidate. When the shared
 * read itself fails, every rebuild reports that failure, which is exactly
 * what per-candidate rebuildAcmContextPacket calls would have produced.
 */
export function createAcmPacketSnapshot(sessionManager: ReadonlySessionManager): AcmPacketSnapshot {
  const snapshot = createSessionSnapshot(sessionManager);
  return {
    rebuild(leafId: string | null) {
      if (!snapshot.ok) {
        return {
          ok: false as const,
          error: snapshot.error,
          message: snapshot.message,
          details: { leafId, cause: snapshot.details.cause },
        };
      }
      const result = snapshot.value.messagesAt(leafId);
      if (!result.ok) return result;
      if (leafId === null) {
        return { ok: true as const, value: normalizeExistingAcmPacket(result.value, []), branch: [] };
      }
      // Mixed provenance is deliberate: packet messages come from the shared
      // snapshot while activeEntries reads the live branch. The scans that
      // use this run synchronously with no await between the snapshot and
      // here, so on a single-threaded host the two cannot observe different
      // session versions.
      let activeEntries: SessionEntry[];
      try {
        activeEntries = sessionManager.getBranch(leafId);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          error: "host_operation_failed" as const,
          message: `Failed to read active branch entries for ACM context projection: ${cause}`,
          details: { leafId: leafId ?? null, cause },
        };
      }
      return { ok: true as const, value: normalizeExistingAcmPacket(result.value, activeEntries), branch: activeEntries };
    },
  };
}
