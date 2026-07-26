import type { ContextUsagePressure } from "./context-pressure.js";

/**
 * Constant context gauge — the only perception surface ACM injects.
 *
 * Design contract (AGENTS.md gauge contract): the gauge is furniture, not an
 * event. It renders two facts and nothing else: working-budget pressure (the
 * soft attention envelope, breakable for a clean extraction) and hard window
 * usage (the physical runway). No verbs, no evaluation, no thresholds, no
 * escalation — any injected wording beyond the numbers gets read as an
 * instruction by an obedient model, which is exactly the failure mode this
 * design retired (burst cues, boundary cues, tier reminders).
 *
 * Cadence is an odometer: the suffix appears only when the integer percent
 * changes (in either direction). Display frequency therefore tracks
 * consumption speed with zero editorial judgment about "important moments" —
 * a gauge that chooses its moments becomes an event again.
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
 * Odometer cadence: show when the integer part of the budget percent differs
 * from the last shown one. Downward changes show too — watching the number
 * drop after a fold is honest feedback, not noise. A fresh cycle always shows
 * on the first opportunity (null baseline): after a context transition the
 * new reading is exactly the fact worth rendering once.
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

/**
 * Dual needle when the working budget is smaller than the model window:
 * budget is the advisory attention envelope, window is the physical truth.
 * When the window itself is at or under the budget cap the two needles
 * coincide and only the window fact remains.
 */
export function buildGaugeSuffix(pressure: ContextUsagePressure): string {
  if (pressure.policy === "400k-cap") {
    return `\n[ctx ${Math.floor(pressure.pressurePercent)}% budget · ${Math.floor(pressure.usagePercent)}% window]`;
  }
  return `\n[ctx ${Math.floor(pressure.usagePercent)}% window]`;
}
