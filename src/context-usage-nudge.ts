export type ContextUsageNudgeLevel = 30 | 50 | 70;

export interface PendingContextUsageNudge {
  level: ContextUsageNudgeLevel;
  usagePercent: number;
}

export interface ContextUsageNudgeMessage {
  customType: "acm:context-usage-reminder";
  content: string;
  display: false;
  details: {
    kind: "context-usage-reminder";
    level: ContextUsageNudgeLevel;
    usagePercent: number;
  };
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

export function restoreContextUsageNudgeState(entries: readonly unknown[]): RestoredContextUsageNudgeState {
  let lastBoundaryIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = asRecord(entries[index]);
    if (entry && isContextCycleBoundary(entry)) lastBoundaryIndex = index;
  }

  let highestReachedLevel: 0 | ContextUsageNudgeLevel = 0;
  for (let index = lastBoundaryIndex + 1; index < entries.length; index++) {
    const entry = asRecord(entries[index]);
    if (!entry) continue;
    const level = getPersistedReminderLevel(entry);
    if (level > highestReachedLevel) highestReachedLevel = level;
  }

  return {
    highestReachedLevel,
    baselinePending: lastBoundaryIndex >= 0 && highestReachedLevel === 0,
  };
}

export function buildContextUsageNudgeMessage(nudge: PendingContextUsageNudge): ContextUsageNudgeMessage {
  const usage = nudge.usagePercent.toFixed(1);
  const header = nudge.level === 70
    ? "[ACM Context Reminder · 70% tier · Final reminder]"
    : `[ACM Context Reminder · ${nudge.level}% tier]`;

  const guidance = nudge.level === 30
    ? [
        "Continue the current work normally. At the next natural semantic boundary, consider whether current task requirements permit a safe fold or rebase travel.",
        "Travel is optional, but keeping the active context small is preferred when it can be done without losing needed working state.",
      ]
    : nudge.level === 50
      ? [
          "Context pressure is becoming material. Based on the current task requirements, actively look for the next safe opportunity for a fold or rebase travel.",
          "Travel is recommended when a complete handoff can preserve the required working state and make NEXT executable. Do not travel if important context is still needed, but prefer returning to a smaller active context when safely possible.",
        ]
      : [
          "Context pressure is high. At the earliest safe semantic boundary, strongly consider a fold or rebase travel if current task requirements allow a complete and recoverable handoff.",
          "Keeping the active context small is strongly preferred, but correctness, task continuity, and recoverability take priority. If no safe travel is available, continue normally; native compaction is acceptable for a genuinely long task.",
        ];

  return {
    customType: "acm:context-usage-reminder",
    content: [
      header,
      "",
      `Active context usage has reached approximately ${usage}%. This is an automated ACM notice, not a new user request.`,
      "",
      ...guidance,
    ].join("\n"),
    display: false,
    details: {
      kind: "context-usage-reminder",
      level: nudge.level,
      usagePercent: nudge.usagePercent,
    },
  };
}
