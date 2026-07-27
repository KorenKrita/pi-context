import type { ContextUsagePressure } from "./context-pressure.js";

/**
 * Simple context usage gauge. Appends a `[ctx N%]` suffix to tool results
 * so the model knows how much context it's using.
 *
 * Shows when the integer percent changes (odometer cadence).
 * Kill switch: ACM_GAUGE_DISABLED=1
 */

/** Kill switch: ACM_GAUGE_DISABLED=1 silences the gauge. Read per call so tests can toggle it. */
export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM tool results have their own usage info; never decorate them. */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

/** Per-session gauge state. Reset on context transitions (travel, compaction, /tree). */
export interface GaugeState {
  /** Pressure percent at last shown gauge; null = nothing shown this cycle. */
  lastShownPercent: number | null;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null };
}

/**
 * Odometer: show when integer percent changes from last shown value.
 * Always shows on the first call after a reset (null baseline).
 */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

/** Move the odometer — call only after the suffix was actually attached. */
export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/**
 * Build the gauge suffix. Simple format: `[ctx N%]`
 * Shows working budget pressure when the 400k cap applies, otherwise just window usage.
 */
export function buildGaugeSuffix(pressure: ContextUsagePressure): string {
  const percent = pressure.policy === "400k-cap"
    ? Math.floor(pressure.pressurePercent)
    : Math.floor(pressure.usagePercent);
  return `\n[ctx ${percent}%]`;
}
