import type { ContextUsagePressure } from "./context-pressure.js";

/**
 * Constant context gauge — a single number showing how full the context is.
 *
 * Grassroots design: one needle, plain percent, no projections. A normal model
 * reads `[ctx 30%]` and knows the conversation is growing. When (or whether) to
 * fold stays the model's own judgment, not a threshold the gauge crosses.
 *
 * Cadence is an odometer: the suffix appears only when the integer percent
 * changes (in either direction). ACM tool results and error results are never
 * decorated — they carry their own usage line and clean receipts.
 */

/** Kill switch: ACM_GAUGE_DISABLED=1 silences the gauge. Read per call so tests can toggle it. */
export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM tool results carry mutation receipts with their own usage line; never decorate them. */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

/** Per-session gauge state. Reset on every context transition (travel, compaction, manual /tree). */
export interface GaugeState {
  /** Pressure percent at the last shown gauge; null means nothing shown this cycle. */
  lastShownPercent: number | null;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null };
}

/**
 * Odometer cadence: show when the integer part of the pressure percent differs
 * from the last shown one. Downward changes show too — watching the number drop
 * after a fold is honest feedback. A fresh cycle always shows on the first
 * opportunity (null baseline): after a context transition the new reading is
 * exactly the fact worth rendering once.
 */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

/** Move the odometer — call only after the suffix was actually attached to a result. */
export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/** Single needle: how full the context is, floored to an integer percent. */
export function buildGaugeSuffix(pressure: ContextUsagePressure): string {
  return `\n[ctx ${Math.floor(pressure.pressurePercent)}%]`;
}
