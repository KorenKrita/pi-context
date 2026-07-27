/**
 * Simple context usage pressure: just reports the percentage of the context window used.
 * No working-budget cap, no policy distinction.
 */

export interface ContextUsagePressure {
  tokens: number;
  contextWindow: number;
  /** Hard usage percent against the real model window. */
  usagePercent: number;
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
  const hardUsagePercent = Number.isFinite(usagePercent) && (usagePercent ?? -1) >= 0
    ? usagePercent as number
    : (validTokens * 100) / validContextWindow;

  return {
    tokens: validTokens,
    contextWindow: validContextWindow,
    usagePercent: hardUsagePercent,
  };
}

function formatTokenCount(tokens: number): string {
  const format = (value: number, suffix: string) => `${Number(value.toFixed(1))}${suffix}`;
  if (tokens >= 1_000_000) return format(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return format(tokens / 1_000, "K");
  return String(Math.round(tokens));
}

export function formatContextUsagePressure(pressure: ContextUsagePressure): string {
  return `${pressure.usagePercent.toFixed(1)}% (${formatTokenCount(pressure.tokens)} / ${formatTokenCount(pressure.contextWindow)})`;
}