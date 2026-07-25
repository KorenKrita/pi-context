import type { ContextUsageNudgeLevel, ContextUsagePressure } from "./context-usage-nudge.js";
import { getEntryLabels, type LabelMaps } from "./lib.js";

interface BranchEntryLike {
  readonly id: string;
}

/** Walk the active branch tip-first for the nearest labeled save point. Pure fact, no verdict. */
export function findNearestSavePoint(
  branch: readonly BranchEntryLike[],
  labelMaps: LabelMaps,
): { name: string | null; stepsBack: number | null } {
  let stepsBack = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    const labels = getEntryLabels(labelMaps, branch[index]!.id);
    if (labels.length > 0) return { name: labels.at(-1) ?? null, stepsBack };
    stepsBack++;
  }
  return { name: null, stepsBack: null };
}

/**
 * Deterministic, syntax-only interruption triggers for the ACM nudge system.
 *
 * Design contract (docs/acm-judgment-contract.md, AGENTS.md nudge contract):
 * the host detects structural moments cheaply and hands the model a
 * ready-to-answer judgment question; the semantic verdict — sediment vs hot
 * set, fold vs continue — always stays with the model. Detectors are smoke
 * alarms: high recall, low precision, misfire cost is a few dozen tokens of
 * model-side dismissal. No detector may consult message semantics.
 */

/** Tools whose completion counts toward a read burst. Purely syntactic list. */
const READ_BURST_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);

/** Threshold at which a read burst emits an in-place judgment cue. */
export const READ_BURST_THRESHOLD = 8;

/** Minimum tool completions in a run for boundary triggers (new request / phase end). */
export const RUN_ACTIVITY_THRESHOLD = 8;

/** Gauge suffix cadence: minimum pressure-point delta since the last emission. */
export const GAUGE_DELTA_PP = 8;

/** Gauge suffixes stay silent below the cruise-protection floor. */
export const GAUGE_SILENCE_FLOOR_PP = 30;

export function isReadBurstTool(toolName: string): boolean {
  return READ_BURST_TOOLS.has(toolName);
}

export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

/**
 * Per-run trigger state. Reset on every run boundary (user turn / agent_end)
 * and on every reminder-cycle boundary (travel, compaction, manual /tree).
 */
export interface TriggerRunState {
  /** Consecutive read-class tool completions; broken by any other tool. */
  readBurstLength: number;
  /** Total tool completions in the current run. */
  runToolCount: number;
  /** True once acm_checkpoint or acm_travel completed in this run. */
  savePointCreatedInRun: boolean;
  /** Pressure percent at the last gauge emission (this cycle). */
  lastGaugePercent: number | null;
  /** True once a burst cue fired in this run: at most one burst cue per run. */
  burstCuedInRun: boolean;
  /**
   * Cycle-scoped disarm for boundary cues (new request / phase end). A cue
   * fires once, then stays silent until a real save-point action rearms it
   * or a cycle boundary resets the state. A reminder is a reminder, not a
   * snooze alarm.
   */
  boundaryCueDisarmed: boolean;
}

export function createTriggerRunState(): TriggerRunState {
  return {
    readBurstLength: 0,
    runToolCount: 0,
    savePointCreatedInRun: false,
    lastGaugePercent: null,
    burstCuedInRun: false,
    boundaryCueDisarmed: false,
  };
}

/** Reset run-scoped counters while keeping cycle-scoped gauge cadence and boundary disarm. */
export function resetRunCounters(state: TriggerRunState): void {
  state.readBurstLength = 0;
  state.runToolCount = 0;
  state.savePointCreatedInRun = false;
  state.burstCuedInRun = false;
}

export type ToolCompletionTrigger =
  | { kind: "none" }
  | { kind: "burst"; burstLength: number };

/**
 * Record one tool completion and classify whether it crosses a burst
 * threshold. ACM tool results are counted for run activity but never trigger
 * suffix injection themselves.
 */
export function recordToolCompletion(state: TriggerRunState, toolName: string): ToolCompletionTrigger {
  state.runToolCount += 1;
  if (isAcmTool(toolName)) {
    if (toolName === "acm_checkpoint" || toolName === "acm_travel") {
      state.savePointCreatedInRun = true;
      // A real save-point action rearms the boundary cue: the previous
      // reminder was acted on, so future accumulation is new information.
      state.boundaryCueDisarmed = false;
    }
    // An ACM call is a deliberate context move, not part of an ingestion burst.
    state.readBurstLength = 0;
    return { kind: "none" };
  }
  if (!isReadBurstTool(toolName)) {
    state.readBurstLength = 0;
    return { kind: "none" };
  }
  state.readBurstLength += 1;
  if (!state.burstCuedInRun && state.readBurstLength >= READ_BURST_THRESHOLD) {
    state.burstCuedInRun = true;
    return { kind: "burst", burstLength: state.readBurstLength };
  }
  return { kind: "none" };
}

/**
 * Emit a gauge when pressure is above the silence floor and has climbed at
 * least GAUGE_DELTA_PP since the last emission. Change carries information;
 * constant state wallpapers. The first emission of a cycle baselines at the
 * floor so a fresh cycle does not fire immediately at 30.1%.
 */
export function shouldEmitGauge(state: TriggerRunState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent)) return false;
  if (pressurePercent < GAUGE_SILENCE_FLOOR_PP) return false;
  const base = state.lastGaugePercent ?? GAUGE_SILENCE_FLOOR_PP;
  return pressurePercent - base >= GAUGE_DELTA_PP;
}

export function markGaugeEmitted(state: TriggerRunState, pressurePercent: number): number {
  const base = state.lastGaugePercent ?? GAUGE_SILENCE_FLOOR_PP;
  state.lastGaugePercent = pressurePercent;
  return pressurePercent - base;
}

/**
 * Boundary triggers: substantial un-checkpointed tool work at a run boundary.
 * Once cued, the trigger disarms for the whole cycle until a real save-point
 * action rearms it — at most one boundary reminder per cycle, shared between
 * the new-request and phase-end moments (they are two exits of the same
 * "unprotected work" signal).
 */
export function shouldCueRunBoundary(state: TriggerRunState): boolean {
  return !state.boundaryCueDisarmed
    && state.runToolCount >= RUN_ACTIVITY_THRESHOLD
    && !state.savePointCreatedInRun;
}

export function markBoundaryCued(state: TriggerRunState): void {
  state.boundaryCueDisarmed = true;
}

const NEXT_TIER: Record<0 | ContextUsageNudgeLevel, ContextUsageNudgeLevel | null> = {
  0: 30,
  30: 50,
  50: 70,
  70: null,
};

export function describeDistanceToNextTier(pressurePercent: number): string | null {
  const tier = pressurePercent >= 70 ? 70 : pressurePercent >= 50 ? 50 : pressurePercent >= 30 ? 30 : 0;
  const next = NEXT_TIER[tier];
  if (next === null) return null;
  return `${next}% tier in ${(next - pressurePercent).toFixed(0)}pp`;
}

/** One-line delimited gauge suffix appended to a finalized tool result. */
export function buildGaugeSuffix(pressure: ContextUsagePressure, deltaPp: number): string {
  const distance = describeDistanceToNextTier(pressure.pressurePercent);
  const parts = [
    `ctx: ${pressure.pressurePercent.toFixed(1)}%`,
    `${deltaPp >= 0 ? "↑" : "↓"}${Math.abs(deltaPp).toFixed(0)}pp`,
    ...(distance ? [distance] : []),
  ];
  return `\n[${parts.join(" · ")}]`;
}

export interface BurstCueFacts {
  burstLength: number;
  nearestCheckpointName: string | null;
  stepsSinceCheckpoint: number | null;
}

/**
 * In-place burst cue: a judgment question with the nearest save-point fact.
 * The host reports the moment; whether conclusions are already distilled is
 * the model's call.
 */
export function buildBurstCueSuffix(facts: BurstCueFacts): string {
  const savePoint = facts.nearestCheckpointName
    ? `nearest save point '${facts.nearestCheckpointName}'${facts.stepsSinceCheckpoint !== null ? ` ${facts.stepsSinceCheckpoint} step(s) back` : ""}`
    : "no save point on this spine";
  return `\n[ACM · ${facts.burstLength} consecutive reads this run · ${savePoint} · are the conclusions distilled, or is raw process accumulating?]`;
}

/** Hidden one-line cue for run-boundary triggers (new request / phase end). */
export function buildRunBoundaryCue(
  moment: "new_request" | "phase_end",
  state: TriggerRunState,
): string {
  const lead = moment === "new_request"
    ? "A new user request arrived while the previous run had substantial un-checkpointed tool work"
    : "This run finished with substantial un-checkpointed tool work";
  return `[ACM] ${lead} (${state.runToolCount} tool calls, no save point this run). If the hot set or conclusions of that work still matter, an acm_checkpoint or fold is cheap now and expensive to reconstruct later. This is an automated ACM notice, not a user request; continue directly if the working set is already the best representation.`;
}
