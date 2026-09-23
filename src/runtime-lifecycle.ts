import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendCheckpointLabel } from "./host-bridge.js";
import {
  createAcmPacketSnapshot,
  normalizeExistingAcmPacketForSession,
} from "./context-packet.js";
import { scanProtocolAnchor } from "./anchor-scan.js";
import { calculateContextUsagePressure } from "./context-pressure.js";
import { buildLabelMaps, type LabelMaps } from "./label-journal.js";
import { ANCHOR_SEARCH_WINDOW } from "./conventions.js";
import { TREE_SUMMARY_INSTRUCTIONS } from "./generated-guidance.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { buildGaugeSuffix, isAcmTool, type GaugeStructure } from "./context-gauge.js";
import { estimateFoldGainsFromAggregates, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import { aggregateMessages, type MessageAggregate } from "./usage-estimation.js";
import { appendLedgerRow, buildBoundaryRow, flushLedgerQueue, markBoundaryCounted, modelDiscriminator, shouldCountBoundary } from "./boundary-ledger.js";

type ToolResultEventContent = { type: "text"; text: string } | { type: string };

/**
 * Append a delimited ACM suffix to the last text part of a finalized tool
 * result. Returns a tool_result patch, or undefined when the content shape
 * offers no text part to extend (never invent one — the result is a receipt).
 */
function appendSuffixPatch<T extends ToolResultEventContent>(
  content: readonly T[],
  suffix: string,
): { content: T[] } | undefined {
  for (let index = content.length - 1; index >= 0; index--) {
    const part = content[index]!;
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      const patched = [...content];
      patched[index] = { ...part, text: (part as { text: string }).text + suffix };
      return { content: patched };
    }
  }
  return undefined;
}

/**
 * The summarizer model cannot see session node IDs, so the abandoned branch tip
 * is handed to it as a concrete fact: a Recover pointer that acm_travel can
 * rehydrate directly.
 */
export function buildTreeSummaryInstructions(oldLeafId: string | null): string {
  if (!oldLeafId) return TREE_SUMMARY_INSTRUCTIONS;
  return `${TREE_SUMMARY_INSTRUCTIONS}\n\nThe abandoned branch tip is node ${oldLeafId}. Name it in the Recover slot unless the branch contains a more specific save point.`;
}

export function registerAcmLifecycle(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  // Gauge pressure reads the host's usage directly: since Pi 0.87 it follows the
  // SessionManager projection, so it is correct immediately after a travel.
  const currentGaugePressure = (ctx: ExtensionContext) => {
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    return calculateContextUsagePressure(usage?.tokens, usage?.contextWindow, usage?.percent);
  };
  // Fold needles for the gauge: project what a fold at each structural
  // reference point would leave. Reference points never require a label, so a
  // session that has not checkpointed still gets both numbers. Estimation is
  // bounded to the two references the gauge renders, and a failed rebuild
  // simply omits that needle.
  const currentFoldEstimates = (
    ctx: ExtensionContext,
    pressure: { workingBudgetTokens: number; tokens: number; contextWindow: number },
    branch: readonly FoldEstimateEntry[] | undefined,
    entries: { length: number; at(index: number): { id: string } | undefined } | undefined,
    labelMaps: LabelMaps | undefined,
  ) => {
    const session = ctx.sessionManager;
    try {
      // Shared reads are the fast path; a transient acquisition failure must
      // not lose the needle, so fall back to this consumer's own reads — the
      // same independent recovery the pre-shared path had.
      let activeBranch = branch;
      if (activeBranch === undefined) {
        try {
          activeBranch = session.getBranch() as unknown as readonly FoldEstimateEntry[];
        } catch {
          return undefined;
        }
      }
      let activeEntries = entries;
      let activeLabelMaps = labelMaps;
      if (activeEntries === undefined || activeLabelMaps === undefined) {
        try {
          const readEntries = session.getEntries();
          activeEntries = readEntries;
          activeLabelMaps = runtime.labelMapsFor(session, readEntries, () => buildLabelMaps(readEntries));
        } catch {
          return undefined;
        }
      }
      if (!Array.isArray(activeBranch) || activeBranch.length === 0) return undefined;
      const references = selectFoldReferences(activeBranch, activeLabelMaps);
      if (!references.turn && !references.task) return undefined;
      const leafId = session.getLeafId();
      // One shared snapshot serves every cold-path miss in this render; warm
      // renders whose keys have not moved rebuild nothing and scan nothing.
      let snapshot: ReturnType<typeof createAcmPacketSnapshot> | undefined;
      const aggregateAt = (wantedLeafId: string | null): MessageAggregate | undefined => {
        snapshot ??= createAcmPacketSnapshot(session);
        const result = snapshot.rebuild(wantedLeafId);
        return result.ok ? aggregateMessages(result.value.messages) : undefined;
      };
      const currentAggregate = runtime.foldAggregate(
        session,
        { kind: "current", leafId, entriesLength: activeEntries.length, lastEntryId: activeEntries.at(-1)?.id ?? "" },
        () => aggregateAt(leafId),
      );
      if (!currentAggregate) return undefined;
      return estimateFoldGainsFromAggregates({
        usage: { tokens: pressure.tokens, contextWindow: pressure.contextWindow, percent: 0 },
        workingBudgetTokens: pressure.workingBudgetTokens,
        currentAggregate,
        aggregateAt: (entryId) => runtime.foldAggregate(session, { kind: "target", entryId }, () => aggregateAt(entryId)),
      }, references);
    } catch {
      return undefined;
    }
  };
  // Ledger counters live on the runtime so fold rows written from the travel
  // receipt share this session discriminator and stay joinable.
  const recordBoundary = (
    ctx: ExtensionContext,
    pressure: { pressurePercent: number; usagePercent: number },
    folds: { turnPercent: number | null; taskPercent: number | null } | undefined,
    savePoints: number | null,
    sharedBranch: readonly { id: string; type?: string; message?: { role?: string } }[] | undefined,
    sharedBoundaryId: string | null,
  ): void => {
    try {
      // The shared reads are the fast path; when they failed transiently this
      // consumer recovers on its own — its own branch read, its own boundary
      // scan — exactly as it did before the reads were shared. A null
      // boundaryId with a branch in hand also covers the gate scan having
      // failed while the render-path branch read succeeded.
      let branch = sharedBranch;
      if (branch === undefined) {
        branch = (ctx.sessionManager as { getBranch?: () => readonly { id: string; type?: string; message?: { role?: string } }[] }).getBranch?.();
      }
      if (!Array.isArray(branch) || branch.length === 0) return;
      let boundaryId = sharedBoundaryId;
      if (boundaryId === null) {
        for (let index = branch.length - 1; index >= 0; index--) {
          const entry = branch[index]!;
          if (entry.type === "message" && entry.message?.role === "user") {
            boundaryId = entry.id;
            break;
          }
        }
      }
      const session = ctx.sessionManager as unknown as object;
      const state = runtime.ledgerState(session);
      if (!shouldCountBoundary(state, boundaryId)) return;
      const ordinal = markBoundaryCounted(state, boundaryId!);
      appendLedgerRow("boundary", buildBoundaryRow({
        state,
        boundary: ordinal,
        budgetPercent: pressure.pressurePercent,
        windowPercent: pressure.usagePercent,
        foldTurnPercent: folds?.turnPercent,
        foldTaskPercent: folds?.taskPercent,
        entries: branch.length,
        savePoints,
        model: modelDiscriminator((ctx as { model?: { provider?: unknown; id?: unknown } }).model),
      }));
    } catch {
      // A diagnostic writer must never reach the tool result.
    }
  };
  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    // tool_result handlers are chained and later extensions may still replace
    // content/details/isError. Final travel authorization is therefore read
    // only from the finalized toolResult message on the next context event.
    //
    // The constant gauge is the only decoration: numbers, no wording.
    // ACM tool results carry mutation receipts with their own usage line and
    // are never decorated; error results stay clean receipts too.
    const session = ctx.sessionManager;
    if (isAcmTool(event.toolName) || event.isError) return;
    const pressure = currentGaugePressure(ctx);
    if (!pressure) return;
    // The boundary id is a gate input, so it is resolved first — but it only
    // needs a short backward scan for the last user entry. The save-point
    // count replays the whole label journal, so it waits until the odometer
    // has actually decided to render; most readings are silenced and must
    // not pay O(entries) for a suffix that never appears.
    let boundaryId: string | null = null;
    let gateBranch: readonly { id: string; type?: string; message?: { role?: string } }[] | undefined;
    const resolveBoundary = (branch: readonly { id: string; type?: string; message?: { role?: string } }[]): string | null => {
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (entry.type === "message" && entry.message?.role === "user") return entry.id;
      }
      return null;
    };
    try {
      gateBranch = session.getBranch() as readonly { id: string; type?: string; message?: { role?: string } }[];
      boundaryId = resolveBoundary(gateBranch);
    } catch {
      // A transient read must not swallow this request's first reading: the
      // odometer gates on the boundary id, and a null boundary silences a
      // first-reading render whose integer pressure has not moved. Retry
      // once before the gate; only a second failure degrades to null.
      try {
        gateBranch = session.getBranch() as readonly { id: string; type?: string; message?: { role?: string } }[];
        boundaryId = resolveBoundary(gateBranch);
      } catch {
        boundaryId = null;
        gateBranch = undefined;
      }
    }
    if (!runtime.shouldShowGaugeNow(session, pressure.pressurePercent, boundaryId)) return;
    // The odometer has decided to render, so everything below pays O(entries)
    // once per render instead of once per consumer: one branch (already in
    // hand from the gate scan), one entries read, and one label replay served
    // from the cross-render cache — shared by the save-point count, the fold
    // needles, and the boundary ledger row.
    let branch = gateBranch;
    if (branch === undefined) {
      try {
        branch = session.getBranch() as readonly { id: string; type?: string; message?: { role?: string } }[];
      } catch {
        branch = undefined;
      }
    }
    let entries: { length: number; at(index: number): { id: string } | undefined } | undefined;
    let labelMaps: LabelMaps | undefined;
    try {
      const readEntries = session.getEntries();
      entries = readEntries;
      labelMaps = runtime.labelMapsFor(session, readEntries, () => buildLabelMaps(readEntries));
    } catch {
      entries = undefined;
      labelMaps = undefined;
    }
    let savePoints: number | null = null;
    try {
      if (branch !== undefined && labelMaps !== undefined) {
        let count = 0;
        for (const entry of branch) {
          if (labelMaps.entryToLabel.get(entry.id) !== undefined) count++;
        }
        savePoints = count;
      }
    } catch {
      savePoints = null;
    }
    const structure: GaugeStructure = {
      boundary: runtime.isNewGaugeBoundary(session, boundaryId),
      savePoints,
    };
    const folds = currentFoldEstimates(ctx, pressure, branch, entries, labelMaps);
    // Passive boundary ledger: one row per distinct user-request boundary, so
    // "boundaries crossed N, folds M" accumulates without any injection. Never
    // allowed to affect this result — every failure is swallowed inside.
    recordBoundary(ctx, pressure, folds, savePoints, branch, boundaryId);
    const patch = appendSuffixPatch(event.content, buildGaugeSuffix(pressure, folds, structure));
    // Move the odometer only on actual delivery; an undeliverable result (no
    // text part) leaves the tick armed for the next tool completion.
    if (patch) runtime.confirmGaugeShown(session, pressure.pressurePercent, boundaryId);
    return patch;
  });


  // Since Pi 0.87 every provider request is projected from the SessionManager, so a travel's
  // persisted fold reaches the next request (same run included) without any delivery state.
  // This hook only normalizes that projection: trusted continuation projection, applied-travel
  // receipt normalization, and orphan repair. Pi hands conversation messages only and restores
  // prompt/tool system state afterwards, so system messages are never returned.
  pi.on("context", (event, ctx: ExtensionContext) => {
    const original = event.messages as AgentMessage[];
    const fixed = normalizeExistingAcmPacketForSession(original, ctx.sessionManager, runtime).messages
      .filter((message) => message.role !== "system");
    const changed = fixed.length !== original.length || fixed.some((message, index) => message !== original[index]);
    return changed ? { messages: fixed as typeof event.messages } : undefined;
  });

  // Pi refreshes its finalized transcript (agent.state.messages) from the SessionManager when it
  // commits turn_end boundary drafts, which it does only while some turn_end handler exists. A
  // travel mutates the SessionManager mid-run; without that refresh, session.messages and Pi's own
  // system-prompt section diff keep reading the pre-travel array. No drafts are returned.
  pi.on("turn_end", () => undefined);

  pi.on("turn_start", (_event, ctx: ExtensionContext) => {
    runtime.resetTravelTurnCount(ctx.sessionManager);
  });

  pi.on("model_select", (_event, ctx: ExtensionContext) => {
    // A new model has a new context window: the first reading always shows once.
    runtime.resetGaugeCycle(ctx.sessionManager);
  });

  pi.on("session_before_compact", (event, ctx: ExtensionContext) => {
    const sessionManager = ctx.sessionManager;
    const branch = sessionManager.getBranch();
    if (branch.length === 0) return;
    const compactEntries = sessionManager.getEntries();
    const labelMaps = runtime.labelMapsFor(sessionManager, compactEntries, () => buildLabelMaps(compactEntries));
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const checkpointBase = `pre-compact-${timestamp}`;
    let checkpointName = checkpointBase;
    for (let ordinal = 2; labelMaps.labelToEntryId.has(checkpointName); ordinal++) {
      checkpointName = `${checkpointBase}-${ordinal}`;
    }
    const scan = scanProtocolAnchor({
      branch,
      startIndex: branch.length - 1,
      window: ANCHOR_SEARCH_WINDOW,
      signal: event.signal,
      rebuild: createAcmPacketSnapshot(sessionManager).rebuild,
    });
    if (scan.aborted) return;
    const checkpointTargetId = scan.entryId ?? undefined;
    if (!checkpointTargetId) {
      ctx.ui.notify(
        `No pre-compaction checkpoint was created because no entry within the last ${ANCHOR_SEARCH_WINDOW} entries of the bounded search window can rebuild a lawful context packet.`,
        "warning",
      );
      return;
    }
    const append = appendCheckpointLabel(sessionManager, checkpointTargetId, checkpointName);
    if (!append.ok) ctx.ui.notify(`Could not create pre-compaction checkpoint: ${append.message}`, "warning");
  });

  pi.on("session_compact", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
  });
  // When the user summarizes an abandoned branch during manual /tree navigation
  // without custom instructions, shape the native summary as a cold-start handoff
  // so every branch_summary on the tree speaks the same seven-slot vocabulary.
  pi.on("session_before_tree", (event) => {
    const preparation = event.preparation;
    if (!preparation.userWantsSummary) return;
    if (preparation.customInstructions?.trim()) return;
    if (preparation.entriesToSummarize.length === 0) return;
    return {
      customInstructions: buildTreeSummaryInstructions(preparation.oldLeafId),
      replaceInstructions: true,
    };
  });
  // Manual /tree navigation bypasses acm_travel: the host already rebuilds live
  // messages itself, so stale refresh targets, sync tickets, and usage baselines
  // must not survive onto the newly selected branch.
  pi.on("session_tree", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // A fresh session starts a fresh odometer: the first reading after resume
    // always shows once. No persisted gauge state exists by design.
    runtime.clear(ctx.sessionManager);
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    runtime.clear(ctx.sessionManager);
    // The host's extension runner awaits each handler's returned promise
    // through shutdown, so returning the flush lets queued ledger rows drain
    // before the process exits. A hard kill can still lose the tail — the
    // ledger's diagnostic contract already prices that in.
    return flushLedgerQueue(500);
  });
}
