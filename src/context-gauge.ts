import type { ContextUsagePressure } from "./context-pressure.js";

/**
 * Simple context usage gauge. Appends [ctx N%] to tool results
 * so the model knows how full the context window is.
 *
 * Shows when the integer percent changes (odometer cadence).
 * Kill switch: ACM_GAUGE_DISABLED=1
 */

export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM tool results have their own usage info; never decorate them. */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

export interface GaugeState {
  lastShownPercent: number | null;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null };
}

/** Show when the integer percent changes. Always shows on first call after reset. */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/** Build a simple [ctx N%] suffix showing context window usage. */
export function buildGaugeSuffix(pressure: ContextUsagePressure): string {
  const percent = pressure.policy === "400k-cap"
    ? Math.floor(pressure.pressurePercent)
    : Math.floor(pressure.usagePercent);
  return `\n[ctx ${percent}%]`;
}
