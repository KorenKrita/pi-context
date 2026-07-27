/**
 * Simple context gauge — just reports the percentage of the context window used.
 * No fold needles, no budget/window distinction, no policy.
 */

import type { ContextUsagePressure } from "./context-pressure.js";

/** Kill switch: ACM_GAUGE_DISABLED=1 silences the gauge. */
export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM tool results carry mutation receipts; never decorate them. */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

/** Per-session gauge state. */
export interface GaugeState {
  lastShownPercent: number | null;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null };
}

/**
 * Show when the integer part of the usage percent changes.
 * A fresh cycle always shows on the first opportunity (null baseline).
 */
export function shouldShowGauge(state: GaugeState, usagePercent: number): boolean {
  if (!Number.isFinite(usagePercent) || usagePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(usagePercent) !== Math.floor(state.lastShownPercent);
}

/** Move the odometer — call only after the suffix was actually attached to a result. */
export function markGaugeShown(state: GaugeState, usagePercent: number): void {
  state.lastShownPercent = usagePercent;
}

/** Build the gauge suffix: just the usage percent. */
export function buildGaugeSuffix(pressure: ContextUsagePressure): string {
  return `\n[ctx ${Math.floor(pressure.usagePercent)}%]`;
}