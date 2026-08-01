export const ACM_CONTEXT_WORKING_BUDGET_CAP_TOKENS = 400_000;

export type ContextWorkingBudgetPolicy = "actual-window" | "400k-cap";

export interface ContextUsagePressure {
  tokens: number;
  contextWindow: number;
  /** Hard usage percent against the real model window — the physical runway. */
  usagePercent: number;
  workingBudgetTokens: number;
  /** Pressure percent against the working budget — the soft attention envelope. */
  pressurePercent: number;
  policy: ContextWorkingBudgetPolicy;
}

export function calculateContextUsagePressure(
  tokens: number | null | undefined,
  contextWindow: number | null | undefined,
  usagePercent?: number | null,
): ContextUsagePressure | undefined {
  if (!Number.isFinite(tokens) || (tokens ?? -1) < 0) return undefined;
  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return undefined;

  const validTokens = tokens as number;
  const validContextWindow = contextWindow as number;
  const workingBudgetTokens = Math.min(validContextWindow, ACM_CONTEXT_WORKING_BUDGET_CAP_TOKENS);
  const hardUsagePercent = Number.isFinite(usagePercent) && (usagePercent ?? -1) >= 0
    ? usagePercent as number
    : (validTokens * 100) / validContextWindow;

  return {
    tokens: validTokens,
    contextWindow: validContextWindow,
    usagePercent: hardUsagePercent,
    workingBudgetTokens,
    pressurePercent: (validTokens * 100) / workingBudgetTokens,
    policy: validContextWindow > ACM_CONTEXT_WORKING_BUDGET_CAP_TOKENS ? "400k-cap" : "actual-window",
  };
}

/**
 * Canonical token-count abbreviation for every ACM surface.
 *
 * Truncates instead of rounding: the raw token pair is the evidence that a
 * percentage did or did not cross a denominator, so 399,999 must never render
 * as the denominator it has not reached (399.9K, not 400K). Unit choice uses
 * the raw value, so 999,999 stays 999.9K rather than rounding up into 1M.
 * Trailing .0 is stripped (400K, 1M).
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "N/A";
  const truncate = (value: number, suffix: string) => `${Math.floor(value * 10) / 10}${suffix}`;
  if (tokens >= 1_000_000) return truncate(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return truncate(tokens / 1_000, "K");
  return String(Math.floor(tokens));
}

/** Percent formatting: floored for the gauge, truncated to one decimal for receipts/HUD. */
function formatPercentValue(percent: number, decimals: 0 | 1): string {
  if (!Number.isFinite(percent)) return "N/A";
  if (decimals === 0) return String(Math.floor(percent));
  return String(Math.floor(percent * 10) / 10);
}

/**
 * The two canonical pressure segments, in reading order.
 *
 * Grammar contract (AGENTS.md gauge contract): every percentage names the
 * scale it measures, and the raw numbers beside it report that same scale.
 * - Large window (400k-cap): `75% budget(400K)` then `300K/1M window`. The
 *   percentage reads against the working budget and may pass 100%; the raw
 *   used/window pair names the hard limit and is never dropped — it is the
 *   antidote that keeps a >100% budget reading honest.
 * - Small window (actual-window): `43% window` then `86K/200K`. One scale,
 *   named on the percentage; 100% is the hard wall.
 * The percentage is always pressurePercent (token-derived), never a host
 * percent that may disagree with the raw pair beside it.
 */
export function contextPressureSegments(
  pressure: ContextUsagePressure,
  decimals: 0 | 1 = 0,
): [string, string] {
  const pct = formatPercentValue(pressure.pressurePercent, decimals);
  const ratio = `${formatTokenCount(pressure.tokens)}/${formatTokenCount(pressure.contextWindow)}`;
  if (pressure.policy === "400k-cap") {
    return [`${pct}% budget(${formatTokenCount(pressure.workingBudgetTokens)})`, `${ratio} window`];
  }
  return [`${pct}% window`, ratio];
}

/** Canonical one-line pressure rendering for receipts and the HUD. */
export function formatContextUsagePressure(
  pressure: ContextUsagePressure,
  decimals: 0 | 1 = 1,
): string {
  return contextPressureSegments(pressure, decimals).join(" · ");
}

/**
 * The scale name a prose fold projection carries, matching the pressure
 * percentage's own scale: `budget` under the 400K cap, `window` otherwise.
 */
export function foldProjectionScaleName(policy: ContextWorkingBudgetPolicy): string {
  return policy === "400k-cap" ? "budget" : "window";
}

/**
 * One gauge fold needle: remaining pressure on the same scale as the leading
 * percentage, followed by the message delta. A zero message delta is omitted
 * — `-0msg` would be a fabricated saving.
 */
export function formatFoldNeedle(
  kind: "turn" | "task",
  percent: number,
  messagesRemoved: number | null,
): string {
  // Defensive floor for a canonical exported formatter: a needle that cannot
  // state a real non-negative percent must not fabricate NaN%/-1%.
  if (!Number.isFinite(percent) || percent < 0) return "";
  const wholeMessages = messagesRemoved != null && Number.isFinite(messagesRemoved)
    ? Math.floor(messagesRemoved)
    : 0;
  // Floor before the positivity check: a fractional 0.5 must not render the
  // fabricated saving "-0msg" that a zero delta is contractually spared.
  const messages = wholeMessages > 0 ? ` -${wholeMessages}msg` : "";
  return `fold@${kind}→${Math.floor(percent)}%${messages}`;
}
