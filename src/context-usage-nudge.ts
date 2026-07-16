export type ContextUsageNudgeLevel = 30 | 50 | 70;

export const CONTEXT_USAGE_NUDGE_STATE_CUSTOM_TYPE = "acm:context-usage-state";
export const ACM_CONTEXT_WORKING_BUDGET_CAP_TOKENS = 400_000;

export type ContextWorkingBudgetPolicy = "actual-window" | "400k-cap";

export interface ContextUsagePressure {
  tokens: number;
  contextWindow: number;
  usagePercent: number;
  workingBudgetTokens: number;
  pressurePercent: number;
  policy: ContextWorkingBudgetPolicy;
}

export interface PersistedContextUsageBaselineState extends ContextUsagePressure {
  kind: "context-usage-baseline";
  highestReachedLevel: 0 | ContextUsageNudgeLevel;
}

export interface PendingContextUsageNudge extends ContextUsagePressure {
  level: ContextUsageNudgeLevel;
}

export interface ContextUsageNudgeMessage {
  customType: "acm:context-usage-reminder";
  content: string;
  display: false;
  details: ContextUsagePressure & {
    kind: "context-usage-reminder";
    level: ContextUsageNudgeLevel;
  };
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

export function classifyContextUsageNudgeLevel(percent: number): 0 | ContextUsageNudgeLevel {
  if (percent >= 70) return 70;
  if (percent >= 50) return 50;
  if (percent >= 30) return 30;
  return 0;
}

export interface RestoredContextUsageNudgeState {
  highestReachedLevel: 0 | ContextUsageNudgeLevel;
  baselinePending: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isContextCycleBoundary(entry: Record<string, unknown>): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type !== "branch_summary") return false;
  const details = asRecord(entry.details);
  if (!details) return false;
  return details.kind === "acm_travel"
    || (typeof details.originId === "string" && typeof details.targetId === "string");
}

function getPersistedReminderLevel(entry: Record<string, unknown>): 0 | ContextUsageNudgeLevel {
  if (entry.type !== "custom_message" || entry.customType !== "acm:context-usage-reminder") return 0;
  const details = asRecord(entry.details);
  if (details?.kind !== "context-usage-reminder") return 0;
  return details.level === 30 || details.level === 50 || details.level === 70 ? details.level : 0;
}

function getPersistedBaselineLevel(
  entry: Record<string, unknown>,
): 0 | ContextUsageNudgeLevel | undefined {
  if (entry.type !== "custom" || entry.customType !== CONTEXT_USAGE_NUDGE_STATE_CUSTOM_TYPE) return undefined;
  const data = asRecord(entry.data);
  if (data?.kind !== "context-usage-baseline") return undefined;
  return data.highestReachedLevel === 0
    || data.highestReachedLevel === 30
    || data.highestReachedLevel === 50
    || data.highestReachedLevel === 70
    ? data.highestReachedLevel
    : undefined;
}

export function restoreContextUsageNudgeState(entries: readonly unknown[]): RestoredContextUsageNudgeState {
  let lastBoundaryIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = asRecord(entries[index]);
    if (entry && isContextCycleBoundary(entry)) lastBoundaryIndex = index;
  }

  let highestReachedLevel: 0 | ContextUsageNudgeLevel = 0;
  let baselineEstablished = false;
  for (let index = lastBoundaryIndex + 1; index < entries.length; index++) {
    const entry = asRecord(entries[index]);
    if (!entry) continue;
    const baselineLevel = getPersistedBaselineLevel(entry);
    if (baselineLevel !== undefined) {
      baselineEstablished = true;
      if (baselineLevel > highestReachedLevel) highestReachedLevel = baselineLevel;
    }
    const reminderLevel = getPersistedReminderLevel(entry);
    if (reminderLevel === 0) continue;
    baselineEstablished = true;
    if (reminderLevel > highestReachedLevel) highestReachedLevel = reminderLevel;
  }

  return {
    highestReachedLevel,
    baselinePending: lastBoundaryIndex >= 0 && !baselineEstablished,
  };
}

export function buildContextUsageNudgeMessage(nudge: PendingContextUsageNudge): ContextUsageNudgeMessage {
  const pressure = nudge.pressurePercent.toFixed(1);
  const hardUsage = nudge.usagePercent.toFixed(1);
  const header = nudge.level === 70
    ? "[ACM Context Reminder · 70% tier · Final reminder]"
    : `[ACM Context Reminder · ${nudge.level}% tier]`;

  const guidance = nudge.level === 30
    ? [
        "Context pressure increases the value of attention. Keep compressing cognition continuously and notice when a coherent representation update is ready for a batched fold.",
        "Carry the hot set, encode uncertainty faithfully, and checkpoint when the value of returning to the current state materially changes.",
      ]
    : nudge.level === 50
      ? [
          "Review the working set for sediment, repeated reasoning, competing handoffs, and a representation delta large enough to serve the next stretch of work.",
          "Prefer a high-yield fold when its attention gain will persist; batch related observations so travel cost is amortized rather than paid for every action.",
        ]
      : [
          "Context pressure is high and attention gain is valuable now. Form the smallest authoritative representation that carries the hot set, faithful uncertainty, evidence provenance, external effects, and an executable NEXT.",
          "Use the next viable compression seam for a batched fold or rebase when it improves that representation; let pressure shorten cadence without turning each action into travel or dropping detail that would be reread immediately.",
        ];

  return {
    customType: "acm:context-usage-reminder",
    content: [
      header,
      "",
      `ACM working-budget pressure has reached approximately ${pressure}% (${formatTokenCount(nudge.tokens)} / ${formatTokenCount(nudge.workingBudgetTokens)} working budget). Hard context usage is ${hardUsage}% (${formatTokenCount(nudge.tokens)} / ${formatTokenCount(nudge.contextWindow)} model window). This is an automated ACM notice, not a new user request.`,
      "",
      ...guidance,
    ].join("\n"),
    display: false,
    details: {
      kind: "context-usage-reminder",
      level: nudge.level,
      tokens: nudge.tokens,
      contextWindow: nudge.contextWindow,
      usagePercent: nudge.usagePercent,
      workingBudgetTokens: nudge.workingBudgetTokens,
      pressurePercent: nudge.pressurePercent,
      policy: nudge.policy,
    },
  };
}
