import { contextPressureSegments, formatFoldNeedle, type ContextUsagePressure } from "./context-pressure.js";
import type { FoldEstimates } from "./fold-estimate.js";

/**
 * Constant context gauge — the only perception surface ACM injects.
 *
 * Design contract (AGENTS.md gauge contract): the gauge is furniture, not an
 * event. It renders facts and nothing else: working-budget pressure, hard
 * window usage, a constant `boundary` marker on the first reading of each
 * user request, the save-point count, and the projected pressure plus
 * messages removed for a fold at each structural reference point. No verbs,
 * no evaluation, no thresholds, no escalation — any injected wording beyond
 * numbers and constant structural markers gets read as an instruction by an
 * obedient model, which is exactly the failure mode this design retired.
 *
 * The fold needles are projections, not recommendations: they report what a
 * fold would return, never whether it is earned. Readiness stays CORE's fold
 * test. Needles are unconditional — a needle that appears only past a
 * threshold would be choosing its moment, and a gauge that chooses its
 * moments becomes an event again.
 *
 * Cadence is an odometer: the suffix appears when the integer percent
 * changes (either direction), and always on the first reading of each user
 * request — the boundary is a structural fact, not an editorial choice, so
 * rendering it unconditionally keeps the gauge event-free.
 */

/** Kill switch: ACM_GAUGE_DISABLED=1 silences the gauge. Read per call so tests can toggle it. */
export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM tool results carry mutation receipts with their own usage line; never decorate them. */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

/**
 * Per-session gauge state. The pressure odometer resets on every context
 * transition; boundary tracking resets only with the whole state (new
 * session, compaction, manual /tree) so one user request renders its
 * boundary marker at most once even across a mid-request travel.
 *
 * Boundary ids accumulate in a seen-set, not a single latest value: a fold
 * whose target precedes the current request removes that user entry from
 * the branch, so the next reading resolves an *older* user entry as the
 * boundary. That entry was already seen — rendering its marker again would
 * announce a request that is not new.
 */
export interface GaugeState {
  /** Pressure percent at the last shown gauge; null means nothing shown this cycle. */
  lastShownPercent: number | null;
  /** Entry ids of user boundaries whose first reading was already rendered. */
  seenBoundaryIds: Set<string>;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null, seenBoundaryIds: new Set() };
}

/**
 * Reset only the pressure odometer so the next reading always shows once.
 * Boundary tracking survives: a context transition (travel, model change)
 * inside one user request must not re-render that request's boundary marker.
 */
export function resetGaugeOdometer(state: GaugeState): void {
  state.lastShownPercent = null;
}

/**
 * Odometer cadence: show when the integer part of the budget percent differs
 * from the last shown one, and always on the first reading after a new user
 * boundary. Downward changes show too — watching the number drop after a
 * fold is honest feedback, not noise. A fresh cycle always shows on the
 * first opportunity (null baseline).
 */
export function shouldShowGauge(
  state: GaugeState,
  pressurePercent: number,
  boundaryId?: string | null,
): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  if (boundaryId && !state.seenBoundaryIds.has(boundaryId)) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

/** Move the odometer — call only after the suffix was actually attached to a result. */
export function markGaugeShown(
  state: GaugeState,
  pressurePercent: number,
  boundaryId?: string | null,
): void {
  state.lastShownPercent = pressurePercent;
  if (boundaryId) state.seenBoundaryIds.add(boundaryId);
}

/** Is this reading the first one of a new user boundary? Pure fact for the marker. */
export function isNewBoundary(state: GaugeState, boundaryId?: string | null): boolean {
  return Boolean(boundaryId && !state.seenBoundaryIds.has(boundaryId));
}

/** Structural facts the gauge renders beyond pressure. */
export interface GaugeStructure {
  /** True when this is the first reading of the current user request. */
  boundary: boolean;
  /** Save points on the active path; omitted from the line when null. */
  savePoints: number | null;
}

/**
 * Pressure segments first, from the canonical formatter: one scale-named
 * percentage plus the raw used/window token pair. On a large window the
 * percentage reads against the working budget and may pass 100%; the raw
 * pair names the hard limit. On a small window budget and window coincide
 * and the single percentage is labeled `window`.
 *
 * Then the constant structural markers: `boundary` on each request's first
 * reading, and the save-point count when known.
 *
 * Fold needles last, each as remaining pressure on the same scale as the
 * leading percentage, followed by the message delta: `fold@turn→24% -38msg`
 * reads "folding to the turn reference leaves 24% and removes 38 messages".
 * A needle with no reference point is omitted — absent is a fact,
 * fabricated is not.
 */
export function buildGaugeSuffix(
  pressure: ContextUsagePressure,
  folds?: FoldEstimates,
  structure?: GaugeStructure,
): string {
  const parts: string[] = [...contextPressureSegments(pressure, 0)];
  if (structure?.boundary) parts.push("boundary");
  if (structure?.savePoints != null && structure.savePoints >= 0) {
    parts.push(`${structure.savePoints}pts`);
  }
  const turnNeedle = folds?.turnPercent != null ? formatFoldNeedle("turn", folds.turnPercent, folds.turnMessagesRemoved) : "";
  if (turnNeedle) parts.push(turnNeedle);
  const taskNeedle = folds?.taskPercent != null ? formatFoldNeedle("task", folds.taskPercent, folds.taskMessagesRemoved) : "";
  if (taskNeedle) parts.push(taskNeedle);
  return `\n[ctx ${parts.join(" · ")}]`;
}
