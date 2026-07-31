import { buildLabelMaps, estimateUsageAfterMessageChange, getEntryLabel, type LabelMaps, type UsageLike } from "./lib.js";

/**
 * Fold-gain estimation for the gauge and for checkpoint receipts.
 *
 * Design contract (AGENTS.md gauge contract): these are needles, not verdicts.
 * A needle reports how much attention a fold at a structural reference point
 * would return; whether that fold is semantically appropriate is CORE's
 * extraction bar, never a number. Restored from the fold preview that shipped
 * until 7c3bdff7 (2026-07-12) silently dropped it during the single-file
 * split, with one deliberate change: reference points no longer require a
 * label, because `estimateUsageAfterMessageChange` only consumes message
 * arrays. Label-gated preview stayed silent for sessions that never
 * checkpointed — exactly the sessions that needed it.
 */

/**
 * Nominal token cost of the handoff a fold appends, charged to every projection.
 *
 * A needle that ignored it would report a saving travel cannot deliver. The
 * exact handoff is unknown at projection time, so this is a deliberate nominal
 * figure: a seven-field cold-start handoff plus the branch-summary entry
 * overhead that estimateUsageAtTravelTarget already charges.
 */
const NOMINAL_HANDOFF_TOKENS = 400;

/** Minimal shape this module needs from a session entry. */
export interface FoldEstimateEntry {
  readonly id: string;
  readonly type?: string;
  readonly message?: { readonly role?: string };
}

export interface FoldReference {
  /** Entry id usable directly as an acm_travel target. */
  entryId: string;
  /** Label when the reference point carries one; null for a structural node. */
  label: string | null;
}

/** Both reference points the gauge reports, either may be absent on a short spine. */
export interface FoldReferences {
  /** Phase/burst granularity: the most recent user-request boundary or save point. */
  turn: FoldReference | null;
  /** Task-chain granularity: the earliest on-path save point, else the earliest user boundary. */
  task: FoldReference | null;
}

export interface FoldEstimates {
  /** Projected budget-pressure percent after folding to the turn reference. */
  turnPercent: number | null;
  /** Messages the turn fold would remove (before the one handoff it adds). */
  turnMessagesRemoved: number | null;
  /** Projected budget-pressure percent after folding to the task reference. */
  taskPercent: number | null;
  /** Messages the task fold would remove (before the one handoff it adds). */
  taskMessagesRemoved: number | null;
}

function isUserBoundary(entry: FoldEstimateEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

function labelOf(labelMaps: LabelMaps, entryId: string): string | null {
  return getEntryLabel(labelMaps, entryId) ?? null;
}

/**
 * Pick both reference points from the active branch, tip-first for `turn` and
 * root-first for `task`. A labeled node wins over a bare structural node at
 * the same granularity because the label is a better travel target for the
 * model; when no label exists the structural node still works, so the needle
 * never goes blind. `excludeId` skips the entry a checkpoint call just labeled.
 */
export function selectFoldReferences(
  branch: readonly FoldEstimateEntry[],
  labelMaps: LabelMaps,
  excludeId?: string,
): FoldReferences {
  // Skip the current user turn before looking for the turn reference.
  //
  // A fold collapses a tail, never a middle, so the target for "fold the
  // previous stretch's process" is necessarily the boundary that opened that
  // stretch. Taking the nearest boundary tip-first points at the current
  // turn's own opening line the moment a new request arrives — precisely the
  // structural position CORE names as already a candidate — and reports a
  // near-zero saving there. That is a value-range defect, not a precision one:
  // the meaningful target was not expressible at all.
  //
  // The cost is real and accepted: in a long turn, "fold this turn's own
  // exploration" is no longer expressed by this needle. The checkpoint receipt
  // carries that projection instead, since it excludes the entry just labeled.
  // Skipping is unconditional — advancing the reference once the current turn
  // has "produced enough" would let a number choose the reference point.
  let currentTurnStart = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (isUserBoundary(branch[index]!)) {
      currentTurnStart = index;
      break;
    }
  }
  let turn: FoldReference | null = null;
  for (let index = currentTurnStart >= 0 ? currentTurnStart - 1 : branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.id === excludeId) continue;
    const label = labelOf(labelMaps, entry.id);
    if (label !== null || isUserBoundary(entry)) {
      turn = { entryId: entry.id, label };
      break;
    }
  }

  let task: FoldReference | null = null;
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index]!;
    if (entry.id === excludeId) continue;
    if (labelOf(labelMaps, entry.id) !== null) {
      task = { entryId: entry.id, label: labelOf(labelMaps, entry.id) };
      break;
    }
  }
  if (task === null) {
    for (let index = 0; index < branch.length; index++) {
      const entry = branch[index]!;
      if (entry.id === excludeId) continue;
      if (isUserBoundary(entry)) {
        task = { entryId: entry.id, label: null };
        break;
      }
    }
  }
  if (task && turn && task.entryId === turn.entryId) task = null;

  return { turn, task };
}

/** Walk the active branch tip-first for the nearest save point. Pure fact, no verdict. */
export function findNearestSavePoint(
  branch: readonly FoldEstimateEntry[],
  labelMaps: LabelMaps,
): { name: string | null; stepsBack: number | null } {
  let stepsBack = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    const label = labelOf(labelMaps, branch[index]!.id);
    if (label !== null) return { name: label, stepsBack };
    stepsBack++;
  }
  return { name: null, stepsBack: null };
}

export interface FoldEstimateInputs {
  usage: UsageLike | undefined;
  /** Working-budget token cap so a projected percent uses the same yardstick as the gauge. */
  workingBudgetTokens: number;
  currentMessages: Parameters<typeof estimateUsageAfterMessageChange>[1];
  messagesAt: (entryId: string) => Parameters<typeof estimateUsageAfterMessageChange>[2] | undefined;
}

function projectedFold(
  inputs: FoldEstimateInputs,
  reference: FoldReference | null,
): { percent: number; messagesRemoved: number } | null {
  if (!reference || !inputs.usage || inputs.workingBudgetTokens <= 0) return null;
  const after = inputs.messagesAt(reference.entryId);
  if (!after) return null;
  // A fold does not merely remove messages: it appends one handoff. Excluding
  // that cost makes every needle optimistic, and worst exactly where it matters
  // — at turn granularity, where the handoff can be the same order of magnitude
  // as the saving. estimateUsageAtTravelTarget already charges it; charge the
  // same nominal cost here so the needle cannot promise more than travel gives.
  const estimate = estimateUsageAfterMessageChange(
    inputs.usage,
    inputs.currentMessages,
    after,
    NOMINAL_HANDOFF_TOKENS,
  );
  if (!estimate) return null;
  return {
    percent: (estimate.tokens * 100) / inputs.workingBudgetTokens,
    messagesRemoved: Math.max(0, inputs.currentMessages.length - after.length),
  };
}

/** Project both needles against the working budget the gauge already reports. */
export function estimateFoldGains(
  inputs: FoldEstimateInputs,
  references: FoldReferences,
): FoldEstimates {
  const turn = projectedFold(inputs, references.turn);
  const task = projectedFold(inputs, references.task);
  return {
    turnPercent: turn?.percent ?? null,
    turnMessagesRemoved: turn?.messagesRemoved ?? null,
    taskPercent: task?.percent ?? null,
    taskMessagesRemoved: task?.messagesRemoved ?? null,
  };
}

export { buildLabelMaps };
