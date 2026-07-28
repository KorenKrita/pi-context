import { buildLabelMaps, estimateUsageAfterMessageChange, getEntryLabel, type LabelMaps, type UsageLike } from "./lib.js";

const NOMINAL_HANDOFF_TOKENS = 400;

export interface FoldEstimateEntry {
  readonly id: string;
  readonly type?: string;
  readonly message?: { readonly role?: string };
}

export interface FoldReference {
  entryId: string;
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

export function selectFoldReferences(
  branch: readonly FoldEstimateEntry[],
  labelMaps: LabelMaps,
  excludeId?: string,
): FoldReferences {
  //
  //
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
  workingBudgetTokens: number;
  currentMessages: Parameters<typeof estimateUsageAfterMessageChange>[1];
  messagesAt: (entryId: string) => Parameters<typeof estimateUsageAfterMessageChange>[2] | undefined;
}

function projectedBudgetPercent(
  inputs: FoldEstimateInputs,
  reference: FoldReference | null,
): number | null {
  if (!reference || !inputs.usage || inputs.workingBudgetTokens <= 0) return null;
  const after = inputs.messagesAt(reference.entryId);
  if (!after) return null;
  const estimate = estimateUsageAfterMessageChange(
    inputs.usage,
    inputs.currentMessages,
    after,
    NOMINAL_HANDOFF_TOKENS,
  );
  if (!estimate) return null;
  return (estimate.tokens * 100) / inputs.workingBudgetTokens;
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
