import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolProtocolDefect, ToolProtocolRepair } from "./tool-protocol.js";
import type { AcmProtocolNormalization, rebuildAcmContextPacket } from "./context-packet.js";

/**
 * Result shape handed to the scanner for each candidate. Structurally the
 * return of `rebuildAcmContextPacket`; snapshots that share one entries
 * read produce the same shape.
 */
export type AnchorRebuildResult = ReturnType<typeof rebuildAcmContextPacket>;

export interface AnchorScanSkip {
  id: string;
  reason: "context_build_failed" | "protocol_invalid" | "empty_context_packet" | "protocol_repaired";
  message?: string;
  repairs?: ToolProtocolRepair[];
  defects?: ToolProtocolDefect[];
}

export interface AnchorScanOptions {
  /** Active-branch entries to walk backward through. */
  branch: readonly SessionEntry[];
  /** Index (inclusive) where the backward scan starts. */
  startIndex: number;
  /** Hard lower bound (exclusive below): on-path folds must keep the ticket strictly after the target. Defaults to 0. */
  lowestIndex?: number;
  /** Maximum candidates to inspect; pass ANCHOR_SEARCH_WINDOW. */
  window: number;
  signal?: AbortSignal;
  /**
   * Accept a "repaired" candidate immediately instead of recording it as the
   * fallback. Used by the return-ticket scan when the travel target packet is
   * itself "repaired": the archive then carries exactly the damage the fold
   * already acknowledged, keeping ticket placement identical to the
   * pre-fallback behavior on every previously-succeeding path.
   */
  acceptRepairedDirectly?: boolean;
  /** Packet rebuild per candidate; share one session snapshot across the scan. */
  rebuild: (entryId: string) => AnchorRebuildResult;
}

export interface AnchorScanResult {
  entryId: string | null;
  /** The chosen candidate's original entry (for role/snippet receipts). */
  entry?: SessionEntry;
  protocolStatus?: "complete" | "repaired";
  protocolRepairs?: ToolProtocolRepair[];
  normalizations: AcmProtocolNormalization[];
  skipped: AnchorScanSkip[];
  aborted: boolean;
  /** True when nothing was chosen, the scan was not aborted, and unscanned candidates remain below the window. */
  searchExhausted: boolean;
  inspected: number;
}

/**
 * The single backward anchor scan behind automatic checkpoint placement, the
 * travel return ticket, and the pre-compaction checkpoint.
 *
 * Two-tier fallback (invalid-only hard floor): prefer the latest
 * protocol-complete candidate; when a mid-span defect leaves every candidate
 * "repaired", anchor on the latest rebuildable repaired one instead of
 * failing — the label must not become unreachable because of one dangling
 * provider-error tool call upstream. Candidates whose rebuild fails or
 * yields an empty packet are never lawful anchors, in either tier.
 *
 * Skip evidence is always collected; callers that do not surface it simply
 * ignore the array, which keeps their external behavior unchanged.
 */
export function scanProtocolAnchor(options: AnchorScanOptions): AnchorScanResult {
  const lowestIndex = options.lowestIndex ?? 0;
  const skipped: AnchorScanSkip[] = [];
  let repairedFallback: {
    entry: SessionEntry;
    protocolRepairs?: ToolProtocolRepair[];
    normalizations: AcmProtocolNormalization[];
  } | undefined;
  let chosen: AnchorScanResult | undefined;
  let index = options.startIndex;
  let inspected = 0;
  for (; index >= lowestIndex && inspected < options.window; index--, inspected++) {
    if (options.signal?.aborted) {
      return {
        entryId: null,
        normalizations: [],
        skipped,
        aborted: true,
        searchExhausted: false,
        inspected,
      };
    }
    const candidate = options.branch[index];
    if (!candidate) continue;
    const packet = options.rebuild(candidate.id);
    if (!packet.ok) {
      skipped.push({ id: candidate.id, reason: "context_build_failed", message: packet.message });
      continue;
    }
    if (packet.value.messages.length === 0) {
      skipped.push({ id: candidate.id, reason: "empty_context_packet" });
      continue;
    }
    const status = packet.value.protocol.status;
    if (status === "invalid") {
      skipped.push({
        id: candidate.id,
        reason: "protocol_invalid",
        defects: packet.value.protocol.defects,
      });
      continue;
    }
    if (status === "repaired" && !options.acceptRepairedDirectly) {
      if (repairedFallback === undefined) {
        repairedFallback = {
          entry: candidate,
          protocolRepairs: packet.value.protocol.repairs,
          normalizations: packet.value.protocol.normalizations,
        };
      }
      skipped.push({
        id: candidate.id,
        reason: "protocol_repaired",
        repairs: packet.value.protocol.repairs,
      });
      continue;
    }
    chosen = {
      entryId: candidate.id,
      entry: candidate,
      protocolStatus: status,
      protocolRepairs: packet.value.protocol.repairs,
      normalizations: packet.value.protocol.normalizations,
      skipped,
      aborted: false,
      searchExhausted: false,
      inspected: inspected + 1,
    };
    break;
  }
  if (!chosen && repairedFallback) {
    const candidate = repairedFallback.entry;
    chosen = {
      entryId: candidate.id,
      entry: candidate,
      protocolStatus: "repaired",
      ...(repairedFallback.protocolRepairs !== undefined ? { protocolRepairs: repairedFallback.protocolRepairs } : {}),
      normalizations: repairedFallback.normalizations,
      // The fallback anchor is no longer "skipped"; keep the other skip
      // evidence but drop its own entry from that list.
      skipped: skipped.filter((skip) => skip.id !== candidate.id),
      aborted: false,
      searchExhausted: false,
      inspected,
    };
  }
  if (!chosen) {
    return {
      entryId: null,
      normalizations: [],
      skipped,
      aborted: false,
      searchExhausted: inspected === options.window && index >= lowestIndex,
      inspected,
    };
  }
  return chosen;
}
