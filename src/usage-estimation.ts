import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { calculateContextUsagePressure, formatContextUsagePressure, formatTokenCount } from "./context-pressure.js";

/** Fixed token overhead for a branch_summary entry in travel usage estimates. */
const BRANCH_SUMMARY_ENTRY_OVERHEAD_TOKENS = 100;

export type StructuralMessageDirection = "decreased" | "increased" | "equal" | "unknown";

export interface UsageLike {
 tokens: number;
 contextWindow: number;
 percent: number;
}

export function formatTokens(tokens: number | null | undefined): string {
 if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return "N/A";
 return formatTokenCount(tokens);
}

/**
 * Canonical usage rendering for tool bodies and renderers: single scale-named
 * percentage plus the raw token pair, both derived from the same tokens and
 * window. `UsageLike.percent` is intentionally not rendered — host percents
 * are hard-window readings (and estimates clamp to 100), which can disagree
 * with the raw pair beside them.
 */
export function formatContextUsage(usage: UsageLike | undefined): string {
 if (!usage) return "Unknown";
 const pressure = calculateContextUsagePressure(usage.tokens, usage.contextWindow);
 if (!pressure) return "Unknown";
 return formatContextUsagePressure(pressure, 1);
}

export interface UsageDelta {
 tokenDelta: number | null;
 percentagePointDelta: number | null;
}

export function calculateUsageDelta(
 before: UsageLike | undefined,
 after: UsageLike | undefined,
): UsageDelta {
 if (!before || !after) return { tokenDelta: null, percentagePointDelta: null };
 return {
  tokenDelta: after.tokens - before.tokens,
  percentagePointDelta: after.percent - before.percent,
 };
}

export function classifyStructuralMessageDirection(
 before: number | undefined,
 after: number | undefined,
): StructuralMessageDirection {
 if (before === undefined || after === undefined) return "unknown";
 if (after === before) return "equal";
 return after < before ? "decreased" : "increased";
}

/** Count semantic handoff layers on one session spine. Native compaction is intentionally separate. */
export function countActiveSummaryDepth(branch: SessionEntry[]): number {
 return branch.reduce((depth, entry) => depth + (entry.type === "branch_summary" ? 1 : 0), 0);
}

/** A successful travel appends one new branch_summary after the selected target spine. */
export function projectSummaryDepthAfterTravel(targetBranch: SessionEntry[]): number {
 return countActiveSummaryDepth(targetBranch) + 1;
}

export function sumMessageTokens(messages: readonly AgentMessage[]): number {
 return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/** Token and message counts of one packet — the only state the gauge needs to
 * keep per leaf, so caches hold two numbers instead of message bodies. */
export interface MessageAggregate {
 tokenCount: number;
 messageCount: number;
}

export function aggregateMessages(messages: readonly AgentMessage[]): MessageAggregate {
 return { tokenCount: sumMessageTokens(messages), messageCount: messages.length };
}

/** The estimate core, given precomputed aggregates. Same arithmetic as the
 * array form: fixed overhead from the before-reading, plus the after tokens
 * and any extra, clamped to the window. */
export function estimateUsageFromAggregates(
 usageBefore: UsageLike | undefined,
 before: MessageAggregate,
 after: MessageAggregate,
 extraTokens = 0,
): UsageLike | undefined {
 if (!usageBefore || usageBefore.contextWindow <= 0) return undefined;
 const fixedOverhead = Math.max(0, usageBefore.tokens - before.tokenCount);
 const estimatedTokens = fixedOverhead + after.tokenCount + extraTokens;
 const rawPercent = (estimatedTokens / usageBefore.contextWindow) * 100;
 return {
  tokens: estimatedTokens,
  contextWindow: usageBefore.contextWindow,
  percent: Math.min(100, Math.max(0, rawPercent)),
 };
}

export function estimateUsageAfterMessageChange(
 usageBefore: UsageLike | undefined,
 messagesBefore: readonly AgentMessage[],
 messagesAfter: readonly AgentMessage[],
 extraTokens = 0,
): UsageLike | undefined {
 if (!usageBefore || usageBefore.contextWindow <= 0) return undefined;
 return estimateUsageFromAggregates(
  usageBefore,
  aggregateMessages(messagesBefore),
  aggregateMessages(messagesAfter),
  extraTokens,
 );
}

export function estimateUsageAtTravelTarget(
 usageBefore: UsageLike | undefined,
 currentMessages: AgentMessage[],
 targetMessages: AgentMessage[],
 summaryText: string,
): UsageLike | undefined {
 const summaryTokens = summaryText.length > 0
  ? estimateTokens({ role: "user", content: summaryText, timestamp: 0 })
  : 0;
 return estimateUsageAfterMessageChange(
  usageBefore,
  currentMessages,
  targetMessages,
  summaryTokens + BRANCH_SUMMARY_ENTRY_OVERHEAD_TOKENS,
 );
}
