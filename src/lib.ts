import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { TextContent, ToolCall, ThinkingContent } from "@earendil-works/pi-ai";
import { buildLabelMaps, type LabelMaps } from "./label-journal.js";
export { buildLabelMaps, type LabelMaps } from "./label-journal.js";

export const ACM_INTERNAL_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);

/** `root` is a structural target keyword and cannot safely be used as an alias. */
export function isReservedTargetName(name: string): boolean {
 return name.toLowerCase() === "root";
}

/** Fixed token overhead for a branch_summary entry in travel usage estimates. */
const BRANCH_SUMMARY_ENTRY_OVERHEAD_TOKENS = 100;

export const HANDOFF_SLOT_HINT = "Goal/State/Evidence/External/Exclusions/Recover/NEXT";

export const HANDOFF_SLOTS = ["Goal", "State", "Evidence", "External", "Exclusions", "Recover", "NEXT"] as const;

export type HandoffSlot = typeof HANDOFF_SLOTS[number];

export type HandoffValidationResult =
 | { ok: true }
 | {
   ok: false;
   missing: HandoffSlot[];
   empty: HandoffSlot[];
   duplicate: HandoffSlot[];
   outOfOrder: boolean;
  };

/** Validate only the observable seven-slot handoff shape, never semantic sufficiency. */
export function validateHandoffStructure(summary: string): HandoffValidationResult {
 const occurrences: Record<HandoffSlot, Array<{ index: number; value: string }>> = {
  Goal: [],
  State: [],
  Evidence: [],
  External: [],
  Exclusions: [],
  Recover: [],
  NEXT: [],
 };

 const lines = summary.split(/\r?\n/);
 for (const [index, line] of lines.entries()) {
  for (const slot of HANDOFF_SLOTS) {
   const prefix = `${slot}:`;
   if (!line.startsWith(prefix)) continue;
   occurrences[slot].push({ index, value: line.slice(prefix.length).trim() });
  }
 }

 const missing = HANDOFF_SLOTS.filter((slot) => occurrences[slot].length === 0);
 const empty = HANDOFF_SLOTS.filter((slot) => occurrences[slot].some(({ value }) => value.length === 0));
 const duplicate = HANDOFF_SLOTS.filter((slot) => occurrences[slot].length > 1);
 const firstIndexes = HANDOFF_SLOTS
  .map((slot) => occurrences[slot][0]?.index)
  .filter((index): index is number => index !== undefined);
 const outOfOrder = firstIndexes.some((index, position) => position > 0 && index <= firstIndexes[position - 1]!);

 if (missing.length === 0 && empty.length === 0 && duplicate.length === 0 && !outOfOrder) return { ok: true };
 return { ok: false, missing, empty, duplicate, outOfOrder };
}

export const BOUNDARY_SELECTION_GUIDANCE = "Choose by boundary, not proximity. A candidate is correct only when it sits before the boundary being compressed; use an earliest on-path -start only when it begins the semantic chain being compressed.";

export function formatFoldCandidatePreview(previewParts: string[]): string {
 return ` Fold candidates (+handoff): ${previewParts.join("; ")}. ${BOUNDARY_SELECTION_GUIDANCE}`;
}

export function formatBoundaryTravelCue(nearestCheckpointName: string | null): string {
 if (nearestCheckpointName === null) {
  return "name the boundary first; no anchor is on this path, so checkpoint now or fold directly to the last clean node ID before the boundary";
 }
 return `name the boundary first. '${nearestCheckpointName}' is only a candidate target. Choose the target that sits before the boundary: phase start, pre-burst node, attempt start, method anchor, or semantic chain start. Load Advanced Target Selection if the target remains ambiguous`;
}

type AssistantContentPart = TextContent | ThinkingContent | ToolCall | { type: string; [key: string]: unknown };

export type StructuralMessageDirection = "decreased" | "increased" | "equal" | "unknown";

export interface UsageLike {
 tokens: number;
 contextWindow: number;
 percent: number;
}


export interface ResolvedTarget {
 id: string;
 fromOffPath: boolean;
}

export type MeaningfulSkipReason =
 | "non_message"
 | "tool_result"
 | "bash_execution"
 | "custom_message"
 | "system_message"
 | "internal_tool_only_assistant"
 | "empty_assistant"
 | "empty_user";


/** Persistent post-travel context rebuild state keyed by session manager instance. */
export class ContextRefreshRegistry {
 static readonly MAX_ATTEMPTS = 3;

 private pending = new WeakSet<object>();
 private failures = new WeakMap<object, string>();
 private attempts = new WeakMap<object, number>();
 private rebuilt = new WeakSet<object>();

 markPending(sm: object): void {
  this.pending.add(sm);
  this.failures.delete(sm);
  this.attempts.set(sm, 0);
  this.rebuilt.delete(sm);
 }

 isPending(sm: object): boolean {
  return this.pending.has(sm);
 }

 getAttemptCount(sm: object): number {
  return this.attempts.get(sm) ?? 0;
 }

 clearPending(sm: object): void {
  this.pending.delete(sm);
 }

 private setFailure(sm: object, message: string): void {
  this.failures.set(sm, message);
 }

 getFailure(sm: object): string | undefined {
  return this.failures.get(sm);
 }

 /** Record a failed refresh attempt. Returns true if another retry is allowed. */
 recordFailedAttempt(sm: object, message: string): boolean {
  const next = (this.attempts.get(sm) ?? 0) + 1;
  this.attempts.set(sm, next);
  this.setFailure(sm, message);
  if (next >= ContextRefreshRegistry.MAX_ATTEMPTS) {
   this.clearPending(sm);
   return false;
  }
  return true;
 }

 markSuccess(sm: object): void {
  this.clear(sm);
 }

 clear(sm: object): void {
  this.pending.delete(sm);
  this.failures.delete(sm);
  this.attempts.delete(sm);
  this.rebuilt.delete(sm);
 }

 markRebuilt(sm: object): void {
  this.rebuilt.add(sm);
  this.failures.delete(sm);
  this.attempts.set(sm, 0);
 }

 hasRebuilt(sm: object): boolean {
  return this.rebuilt.has(sm);
 }
}

export interface SkippedEntry {
 id: string;
 reason: MeaningfulSkipReason;
 role?: string;
}

export interface MeaningfulResolveResult {
 entryId: string | null;
 role?: string;
 snippet?: string;
 skipped: SkippedEntry[];
 aborted?: boolean;
}

export function isValidEntryId(id: string): boolean {
 return id.length > 0;
}

/** Push tree children left-to-right so stack.pop() visits in document order. */
export function pushTreeChildrenPreOrder(stack: SessionTreeNode[], children: SessionTreeNode[]): void {
 for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
}

export function extractTextFromContent(content: unknown): string {
 if (typeof content === "string") return content.trim();
 if (Array.isArray(content)) {
  return content
   .map((p) => {
    if (typeof p === "object" && p !== null && "type" in p && p.type === "text" && "text" in p && typeof p.text === "string") {
     return p.text;
    }
    return "";
   })
   .join(" ")
   .trim();
 }
 if (typeof content === "object" && content !== null && "type" in content) {
  const part = content as { type?: string; text?: string };
  if (part.type === "text" && typeof part.text === "string") return part.text.trim();
 }
 return "";
}

/** Iterative DFS — avoids stack overflow on deep session trees. */
export function findInTree(
 nodes: SessionTreeNode[],
 predicate: (n: SessionTreeNode) => boolean,
): SessionTreeNode | undefined {
 const stack: SessionTreeNode[] = [...nodes];
 while (stack.length > 0) {
  const n = stack.pop()!;
  if (predicate(n)) return n;
  if (n.children?.length) pushTreeChildrenPreOrder(stack, n.children);
 }
 return undefined;
}


export function getEntryLabels(labelMaps: LabelMaps, entryId: string): string[] {
 return labelMaps.entryToLabels.get(entryId) ?? [];
}

export function formatEntryLabels(labelMaps: LabelMaps, entryId: string): string | undefined {
 const labels = getEntryLabels(labelMaps, entryId);
 return labels.length > 0 ? labels.join(", ") : undefined;
}

export function entryMatchesLabelSearch(labelMaps: LabelMaps, entryId: string, searchTerm: string): boolean {
 return getEntryLabels(labelMaps, entryId).some((label) => label.toLowerCase().includes(searchTerm));
}

export function findCheckpointLabelOwner(
 labelMaps: LabelMaps,
 label: string,
 backboneIds: Set<string>,
): { entryId: string; onActivePath: boolean } | undefined {
 const entryId = labelMaps.labelToEntryId.get(label);
 if (!entryId) return undefined;
 return { entryId, onActivePath: backboneIds.has(entryId) };
}

/** Resolve "root" / label / raw hex ID to an entry ID.
 *  "root" maps to the first top-level node when the forest has multiple roots. */
export interface SessionStructuralView {
 getEntries(): SessionEntry[];
 getBranch(fromId?: string): SessionEntry[];
}

export function resolveTargetId(
 view: SessionStructuralView,
 tree: SessionTreeNode[],
 target: string,
 branchIds?: Set<string>,
 labelMaps?: LabelMaps,
): ResolvedTarget {
 const ids = branchIds ?? new Set(view.getBranch().map((e: SessionEntry) => e.id));
 if (target.toLowerCase() === "root") {
  const id = tree[0]?.entry.id ?? "";
  return { id, fromOffPath: id.length > 0 && !ids.has(id) };
 }
 const maps = labelMaps ?? buildLabelMaps(view.getEntries());

 const owner = findCheckpointLabelOwner(maps, target, ids);
 if (owner) {
  return { id: owner.entryId, fromOffPath: !owner.onActivePath };
 }

 return { id: target, fromOffPath: !ids.has(target) };
}

export function formatTokens(tokens: number | null | undefined): string {
 if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return "N/A";
 if (tokens >= 999_950) return `${(tokens / 1_000_000).toFixed(1)}M`;
 if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
 return String(tokens);
}

export function formatContextUsage(usage: UsageLike | undefined, includeTokens = false): string {
 if (!usage) return "Unknown";
 const pct = Number.isFinite(usage.percent) ? `${usage.percent.toFixed(1)}%` : "N/A";
 if (!includeTokens) return pct;
 return `${pct} (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
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

export function compareEntriesByTimestamp(a: SessionEntry, b: SessionEntry): number {
 return a.timestamp.localeCompare(b.timestamp);
}

export function sumMessageTokens(messages: AgentMessage[]): number {
 return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

export function estimateUsageAfterMessageChange(
 usageBefore: UsageLike | undefined,
 messagesBefore: AgentMessage[],
 messagesAfter: AgentMessage[],
 extraTokens = 0,
): UsageLike | undefined {
 if (!usageBefore || usageBefore.contextWindow <= 0) return undefined;
 const beforeMsgTokens = sumMessageTokens(messagesBefore);
 const afterMsgTokens = sumMessageTokens(messagesAfter);
 const fixedOverhead = Math.max(0, usageBefore.tokens - beforeMsgTokens);
 const estimatedTokens = fixedOverhead + afterMsgTokens + extraTokens;
 const rawPercent = (estimatedTokens / usageBefore.contextWindow) * 100;
 return {
  tokens: estimatedTokens,
  contextWindow: usageBefore.contextWindow,
  percent: Math.min(100, Math.max(0, rawPercent)),
 };
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

export function getMeaningfulSkipReason(entry: SessionEntry): MeaningfulSkipReason | null {
 if (entry.type !== "message") return "non_message";
 const msg = entry.message;
 if (msg.role === "toolResult") return "tool_result";
 if (msg.role === "bashExecution") return "bash_execution";
 if (msg.role === "custom") return "custom_message";
 if ((msg.role as string) === "system") return "system_message";
 if (msg.role === "assistant") {
  if (Array.isArray(msg.content)) {
   const toolCalls = msg.content.filter(
    (c: AssistantContentPart): c is ToolCall => c.type === "toolCall",
   );
   const hasVisibleText = msg.content.some(
    (c: AssistantContentPart) => c.type === "text" &&
     typeof (c as TextContent).text === "string" &&
     (c as TextContent).text.trim().length > 0,
   );
   const onlyInternalTools = toolCalls.length > 0 &&
    toolCalls.every((tc: ToolCall) => ACM_INTERNAL_TOOLS.has(tc.name));
   if (onlyInternalTools && !hasVisibleText) return "internal_tool_only_assistant";
   if (!hasVisibleText && toolCalls.length === 0) return "empty_assistant";
  } else if (msg.content === null || msg.content === undefined) {
   return "empty_assistant";
  } else {
   // Defensive: older harness versions may pass string content
   const raw: unknown = msg.content;
   if (typeof raw === "string") {
    if (raw.trim().length === 0) return "empty_assistant";
   } else if (extractTextFromContent(raw).length === 0) {
    return "empty_assistant";
   }
  }
 } else if (msg.role === "user") {
  const isEmpty = msg.content === null || msg.content === undefined ||
   (typeof msg.content === "string" && msg.content.trim().length === 0) ||
   (Array.isArray(msg.content) && msg.content.length === 0);
  if (isEmpty) return "empty_user";
 }
 return null;
}

export function findLastMeaningfulEntry(
 branch: SessionEntry[],
 isSkipped: (entry: SessionEntry) => MeaningfulSkipReason | null,
 getRole: (entry: SessionEntry) => string | undefined,
 getSnippet: (entry: SessionEntry) => string,
 signal?: AbortSignal,
): MeaningfulResolveResult {
 const skipped: SkippedEntry[] = [];
 for (let i = branch.length - 1; i >= 0; i--) {
  if (signal?.aborted) {
   return { entryId: null, skipped, aborted: true };
  }
  const entry = branch[i]!;
  const skipReason = isSkipped(entry);
  const role = getRole(entry);
  if (skipReason) {
   skipped.push({ id: entry.id, reason: skipReason, ...(role === undefined ? {} : { role }) });
   continue;
  }
  return {
   entryId: entry.id,
   ...(role === undefined ? {} : { role }),
   snippet: getSnippet(entry),
   skipped,
  };
 }
 return { entryId: null, skipped };
}
