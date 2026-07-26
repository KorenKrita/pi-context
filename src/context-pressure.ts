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

function formatTokenCount(tokens: number): string {
  const format = (value: number, suffix: string) => `${Number(value.toFixed(1))}${suffix}`;
  if (tokens >= 1_000_000) return format(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return format(tokens / 1_000, "K");
  return String(Math.round(tokens));
}

export function formatContextUsagePressure(pressure: ContextUsagePressure): string {
  const policy = pressure.policy === "400k-cap" ? "400K cap" : "actual window";
  return `${pressure.pressurePercent.toFixed(1)}% (${formatTokenCount(pressure.tokens)} / ${formatTokenCount(pressure.workingBudgetTokens)} working budget; ${policy})`;
}
