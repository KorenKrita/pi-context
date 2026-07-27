import { buildLabelMaps, estimateUsageAfterMessageChange, getEntryLabel, type LabelMaps, type UsageLike } from "./lib.js";

/** Nominal token cost of the handoff a fold appends. */
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

export interface FoldReferences {
  turn: FoldReference | null;
  task: FoldReference | null;
}

export interface FoldEstimates {
  turnPercent: number | null;
  taskPercent: number | null;
}

function isUserBoundary(entry: FoldEstimateEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

function labelOf(labelMaps: LabelMaps, entryId: string): string | null {
  return getEntryLabel(labelMaps, entryId) ?? null;
}

/**
 * Pick both reference points from the active branch.
 * `turn` is the most recent user boundary or save point before the current turn.
 * `task` is the earliest save point, else the earliest user boundary.
 */
export function selectFoldReferences(
  branch: readonly FoldEstimateEntry[],
  labelMaps: LabelMaps,
  excludeId?: string,
): FoldReferences {
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

/** Walk the active branch tip-first for the nearest save point. */
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
  /** Context window size for projecting percentage. */
  contextWindow: number;
  currentMessages: Parameters<typeof estimateUsageAfterMessageChange>[1];
  messagesAt: (entryId: string) => Parameters<typeof estimateUsageAfterMessageChange>[2] | undefined;
}

function projectedBudgetPercent(
  inputs: FoldEstimateInputs,
  reference: FoldReference | null,
): number | null {
  if (!reference || !inputs.usage || inputs.contextWindow <= 0) return null;
  const after = inputs.messagesAt(reference.entryId);
  if (!after) return null;
  const estimate = estimateUsageAfterMessageChange(
    inputs.usage,
    inputs.currentMessages,
    after,
    NOMINAL_HANDOFF_TOKENS,
  );
  if (!estimate) return null;
  return (estimate.tokens * 100) / inputs.contextWindow;
}

export function estimateFoldGains(
  inputs: FoldEstimateInputs,
  references: FoldReferences,
): FoldEstimates {
  return {
    turnPercent: projectedBudgetPercent(inputs, references.turn),
    taskPercent: projectedBudgetPercent(inputs, references.task),
  };
}

export { buildLabelMaps };