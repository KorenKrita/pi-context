import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { buildLabelMaps, type LabelMaps } from "./label-journal.js";
import { optionalString, sanitizeTerminalText } from "./conventions.js";
import { aggregateMessages, countActiveSummaryDepth, estimateUsageFromAggregates, formatContextUsage, projectSummaryDepthAfterTravel, type MessageAggregate } from "./usage-estimation.js";
import { extractTextFromContent, extractTextFromContentBounded, findInTree, getEntryLabel, pushTreeChildrenPreOrder, resolveTargetId } from "./target-resolution.js";
import { ContextRefreshRegistry } from "./context-refresh-registry.js";
import { collectTrustedAcmTravelTransactions, createAcmPacketSnapshot } from "./context-packet.js";
import { estimateFoldGainsFromAggregates, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import { calculateContextUsagePressure, foldProjectionScaleName, formatContextUsagePressure, formatTokenCount, type ContextUsagePressure } from "./context-pressure.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime, FoldProjectionCacheEntry, ProviderDeliveryPhase } from "./runtime.js";
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";

interface CheckpointListing {
  entryId: string;
  label: string;
  matched: boolean;
  isRawArchive: boolean;
  onActivePath: boolean;
  isHead: boolean;
  pathOrder: number;
  timestamp: string;
}

interface SearchMatch {
  entry: SessionEntry;
  label: string | undefined;
  /** The ready-to-render snippet, cut at match time - the full rendered
   * text is never retained past this loop. */
  text: string;
}

const TIMELINE_DYNAMIC_VALUE_CHARS = 240;

function boundedTimelineValue(value: string, maxChars = TIMELINE_DYNAMIC_VALUE_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}… [truncated ${value.length} chars]`;
}

function formatTimelineLabel(label: string | undefined, rawArchiveAliases: ReadonlySet<string> = new Set()): string {
  if (!label) return "";
  return `${boundedTimelineValue(label)}${rawArchiveAliases.has(label) ? " [raw archive]" : ""}`;
}

function collectRawArchiveAliases(entries: readonly SessionEntry[], labelMaps: LabelMaps): Set<string> {
  const aliases = new Set<string>();
  for (const transaction of collectTrustedAcmTravelTransactions(entries)) {
    const alias = transaction.details.backupCurrentHeadAs;
    if (
      typeof alias === "string"
      && alias.length > 0
      && transaction.backupEntryId !== null
      && labelMaps.labelToEntryId.get(alias) === transaction.backupEntryId
    ) aliases.add(alias);
  }
  return aliases;
}

/**
 * Rendered entry text. No cross-call cache: entries live as long as the
 * session, so a WeakMap keyed by them pins every string it stores for the
 * session's lifetime, and every bounded variant review suggested (size
 * threshold, LRU, per-session ownership) traded that pinning for invalidation
 * machinery guarding a ~10% join saving. Searches re-join on demand; the
 * scan budget already bounds how much that can cost per call.
 */
function entryText(entry: SessionEntry, verbose: boolean): string {
  return buildEntryText(entry, verbose);
}

/** Bounded materialization. Message content - the shape that carries large
 * tool output - is extracted part-by-part and stops at the source-work
 * budget, so the full joined string is never built. Short single-field shapes
 * (summaries, labels) go through the full builder with a bounded prefix. */
function boundedEntryText(
  entry: SessionEntry,
  verbose: boolean,
  maxChars: number,
): { text: string; sourceCharsConsumed: number; truncated: boolean } {
  if (entry.type === "message" && "content" in entry.message) {
    return extractTextFromContentBounded(entry.message.content, maxChars);
  }
  const full = buildEntryText(entry, verbose);
  const sourceCharsConsumed = Math.min(full.length, maxChars);
  return {
    text: full.slice(0, sourceCharsConsumed),
    sourceCharsConsumed,
    truncated: sourceCharsConsumed < full.length,
  };
}

function buildEntryText(entry: SessionEntry, verbose: boolean): string {
  if (entry.type === "branch_summary" || entry.type === "compaction") return entry.summary || "[No summary provided]";
  if (entry.type === "label") return verbose ? `label ${entry.label ?? "cleared"} → ${entry.targetId}` : "";
  if (entry.type !== "message") return verbose ? entry.type : "";
  const role = entry.message.role;
  if (!verbose && (role === "custom" || (role as string) === "system")) return "";
  return "content" in entry.message ? extractTextFromContent(entry.message.content) : "";
}
function displayRole(entry: SessionEntry): string {
  if (entry.type === "branch_summary") return "SUMMARY";
  if (entry.type === "compaction") return "COMPACTION";
  if (entry.type === "label") return "LABEL";
  if (entry.type !== "message") return entry.type.toUpperCase();
  if (entry.message.role === "assistant") return "AI";
  if (entry.message.role === "user") return "USER";
  if (entry.message.role === "toolResult") return `TOOL:${entry.message.toolName}`;
  if (entry.message.role === "bashExecution") return "BASH";
  return entry.message.role.toUpperCase();
}

function visibleOnActivePath(entry: SessionEntry, labelMaps: LabelMaps, leafId: string | null, verbose: boolean): boolean {
  if (verbose) return true;
  if (entry.id === leafId || getEntryLabel(labelMaps, entry.id) !== undefined) return true;
  if (entry.type === "branch_summary" || entry.type === "compaction") return true;
  return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

function collectListings(
  labelMaps: LabelMaps,
  activeIds: Set<string>,
  leafId: string | null,
  filter: string,
  entriesById: Map<string, SessionEntry>,
  pathOrder: Map<string, number>,
  rawArchiveAliases: ReadonlySet<string>,
): CheckpointListing[] {
  const listings: CheckpointListing[] = [];
  for (const [entryId, label] of labelMaps.entryToLabel) {
    const entry = entriesById.get(entryId);
    if (!entry) continue;
    const matched = filter.length === 0
      || entryId.toLowerCase().includes(filter)
      || label.toLowerCase().includes(filter);
    if (filter && !matched) continue;
    listings.push({
      entryId,
      label,
      matched,
      isRawArchive: rawArchiveAliases.has(label),
      onActivePath: activeIds.has(entryId),
      isHead: entryId === leafId,
      pathOrder: pathOrder.get(entryId) ?? Number.MAX_SAFE_INTEGER,
      timestamp: entry.timestamp,
    });
  }
  return listings.sort((left, right) => {
    if (left.onActivePath !== right.onActivePath) return left.onActivePath ? -1 : 1;
    if (left.onActivePath && left.pathOrder !== right.pathOrder) return left.pathOrder - right.pathOrder;
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    return timestampOrder || left.entryId.localeCompare(right.entryId);
  });
}

function formatCheckpointLabel(listing: CheckpointListing): string {
  return `${boundedTimelineValue(listing.label)}${listing.isRawArchive ? " [raw archive]" : ""}`;
}

// ACM's own tool results echo every checkpoint name and dashboard line, so
// they match almost any query about past work — self-pollution, not recall.
// They stay searchable only when the entry itself carries a checkpoint label.
function isAcmToolEcho(entry: SessionEntry): boolean {
  return entry.type === "message"
    && entry.message.role === "toolResult"
    && typeof entry.message.toolName === "string"
    && entry.message.toolName.startsWith("acm_");
}

/** Hard ceiling on nodes visited by one search: a no-match query otherwise
 * reads the full content of every archived node in the tree. */
const TIMELINE_SEARCH_SCAN_NODE_BUDGET = 5_000;

interface SearchFilterOptions {
  /** Restrict matches to the active branch (active) or everything off it (archive). */
  scope?: "active" | "archive" | undefined;
  /** Restrict matches to one structural entry kind. */
  type?: "user" | "summary" | "tool" | undefined;
  /** Entry IDs on the current branch — the definition of "active". */
  activeIds: ReadonlySet<string>;
  scanNodeBudget: number;
}

type SearchTruncationReason = "limit" | "scan_budget" | "text_budget" | "signal" | null;

/** One node's source text is consumed at most this far for matching; beyond
 * it, a hit past the cut is honestly out of reach for that node. */
const SEARCH_NODE_TEXT_MAX_CHARS = 65_536;
/** Total source-text work budget per search call: the node budget bounds the
 * tree's width, while this bounds trim-independent extraction and matching
 * work across large tool outputs. */
const SEARCH_TOTAL_TEXT_BUDGET_CHARS = 2_000_000;

function searchTruncationPhrase(reason: "limit" | "scan_budget" | "text_budget" | "signal" | null): string {
  if (reason === "scan_budget") return "5,000-node scan limit";
  if (reason === "text_budget") return `text budget (${SEARCH_TOTAL_TEXT_BUDGET_CHARS.toLocaleString("en-US")} chars)`;
  if (reason === "signal") return "cancelled";
  return "display limit";
}


function searchEntryKind(entry: SessionEntry): "user" | "summary" | "tool" | null {
  if (entry.type === "branch_summary" || entry.type === "compaction") return "summary";
  if (entry.type === "message") {
    if (entry.message.role === "user") return "user";
    if (entry.message.role === "toolResult") return "tool";
  }
  return null;
}

function isAsciiText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * Case-insensitive contains without lowercasing the haystack. On a pure-ASCII
 * pair it compares normalized char codes, which is byte-identical to
 * toLowerCase().includes() semantics in that range and skips the full-string
 * lowercase copy the old form allocated for every scanned node. Any
 * non-ASCII side keeps the exact old form, so Unicode case mappings are
 * untouched. The needle must already be lowercased.
 */
function containsCaseInsensitive(haystack: string, needle: string, needleIsAscii: boolean): boolean {
  if (!needleIsAscii || !isAsciiText(haystack)) {
    return haystack.toLowerCase().includes(needle);
  }
  const needleLength = needle.length;
  if (needleLength === 0) return true;
  const limit = haystack.length - needleLength;
  if (limit < 0) return false;
  const first = needle.charCodeAt(0);
  for (let start = 0; start <= limit; start++) {
    let code = haystack.charCodeAt(start);
    if (code !== first) {
      if (code >= 0x41 && code <= 0x5a) code += 0x20;
      if (code !== first) continue;
    }
    let offset = 1;
    while (offset < needleLength) {
      code = haystack.charCodeAt(start + offset);
      if (code >= 0x41 && code <= 0x5a) code += 0x20;
      if (code !== needle.charCodeAt(offset)) break;
      offset++;
    }
    if (offset === needleLength) return true;
  }
  return false;
}

function searchTree(
  tree: SessionTreeNode[],
  labelMaps: LabelMaps,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
  options: SearchFilterOptions,
): { matches: SearchMatch[]; truncated: boolean; truncationReason: SearchTruncationReason; scannedNodes: number; scanBudget: number; textChars: number; textBudget: number; nodesCutAtNodeCap: number; nodesCutAtCallBudget: number } {
  const normalizedQuery = query.toLowerCase();
  const queryIsAscii = isAsciiText(normalizedQuery);
  const stack = [...tree].reverse();
  const matches: SearchMatch[] = [];
  let truncated = false;
  let truncationReason: SearchTruncationReason = null;
  let scannedNodes = 0;
  let textChars = 0;
  let nodesCutAtNodeCap = 0;
  let nodesCutAtCallBudget = 0;
  while (stack.length > 0) {
    if (signal?.aborted) {
      truncated = true;
      truncationReason = "signal";
      break;
    }
    // Hitting the budget with nodes still unvisited is truncation; hitting it
    // exactly as the stack empties is a complete scan, not a partial one.
    if (scannedNodes >= options.scanNodeBudget && stack.length > 0) {
      truncated = true;
      truncationReason = "scan_budget";
      break;
    }
    // The text budget is checked BEFORE materializing the next node: a node
    // read past the budget would pay its join for nothing and inflate the
    // cut-node count without ever being matched.
    if (textChars >= SEARCH_TOTAL_TEXT_BUDGET_CHARS && stack.length > 0) {
      truncated = true;
      truncationReason = "text_budget";
      break;
    }
    const node = stack.pop()!;
    scannedNodes += 1;
    // Structural filters run before any text is read: on big trees, the
    // content read is the scan cost, so excluded nodes never pay it.
    const scopePasses = options.scope === undefined
      || (options.scope === "active") === options.activeIds.has(node.entry.id);
    const typePasses = options.type === undefined || searchEntryKind(node.entry) === options.type;
    let matched = false;
    let label: string | undefined;
    let candidateText = "";
    let cutAtCallBudget = false;
    if (scopePasses && typePasses) {
      label = getEntryLabel(labelMaps, node.entry.id);
      if (label === undefined && isAcmToolEcho(node.entry)) {
        matched = false;
      } else {
        // Materialize once under both budgets. Matching/snippets use the
        // trimmed rendered prefix; the call budget charges pre-trim source
        // work, so whitespace and separators cannot bypass it.
        const remainingCallBudget = SEARCH_TOTAL_TEXT_BUDGET_CHARS - textChars;
        const appliedNodeBudget = Math.min(SEARCH_NODE_TEXT_MAX_CHARS, Math.max(0, remainingCallBudget));
        const bounded = boundedEntryText(node.entry, true, appliedNodeBudget);
        candidateText = bounded.text;
        textChars += bounded.sourceCharsConsumed;
        if (bounded.truncated) {
          if (appliedNodeBudget < SEARCH_NODE_TEXT_MAX_CHARS) {
            nodesCutAtCallBudget += 1;
            cutAtCallBudget = true;
          } else {
            nodesCutAtNodeCap += 1;
          }
        }
        matched = containsCaseInsensitive(node.entry.id, normalizedQuery, queryIsAscii)
          || (label !== undefined && containsCaseInsensitive(label, normalizedQuery, queryIsAscii))
          || containsCaseInsensitive(candidateText, normalizedQuery, queryIsAscii);
      }
    }
    if (matched) {
      if (matches.length < limit) {
        matches.push({ entry: node.entry, label, text: snippet(candidateText) });
      } else {
        truncated = true;
        truncationReason = "limit";
        break;
      }
    }
    if (cutAtCallBudget) {
      truncated = true;
      truncationReason = "text_budget";
      break;
    }
    pushTreeChildrenPreOrder(stack, node.children);
  }
  return { matches, truncated, truncationReason, scannedNodes, scanBudget: options.scanNodeBudget, textChars, textBudget: SEARCH_TOTAL_TEXT_BUDGET_CHARS, nodesCutAtNodeCap, nodesCutAtCallBudget };
}

/** Shorten a rendered body to one line, marking real truncation honestly. */
function snippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Nearest spine ancestors with readable text, returned in chronological order (closest to the target last). */
function collectSpineNeighbors(spine: readonly SessionEntry[], targetId: string, count: number): SessionEntry[] {
  const collected: SessionEntry[] = [];
  for (let index = spine.length - 1; index >= 0 && collected.length < count; index--) {
    const entry = spine[index]!;
    if (entry.id === targetId) continue;
    if (entryText(entry, true).length === 0) continue;
    collected.push(entry);
  }
  return collected.reverse();
}

/** Nearest descendants with readable text, breadth-first so every child branch is represented honestly. */
function collectDescendantNeighbors(
  node: SessionTreeNode,
  count: number,
  signal?: AbortSignal,
): { neighbors: SessionEntry[]; branchCount: number; aborted: boolean } {
  const queue: SessionTreeNode[] = [...node.children];
  let head = 0;
  const neighbors: SessionEntry[] = [];
  let aborted = false;
  while (head < queue.length && neighbors.length < count) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const next = queue[head++]!;
    if (entryText(next.entry, true).length > 0) neighbors.push(next.entry);
    queue.push(...next.children);
  }
  return { neighbors, branchCount: node.children.length, aborted };
}

// Tree noise filter: the same conversation-first bar the active view uses.
// Structural/metadata nodes (model changes, labels, tool plumbing) are
// spliced out — their children are promoted — so the branch shape survives
// while the rendering budget goes to nodes an agent can actually act on.
function treeNodeVisible(entry: SessionEntry, labelMaps: LabelMaps, leafId: string | null): boolean {
  if (entry.id === leafId || getEntryLabel(labelMaps, entry.id) !== undefined) return true;
  if (entry.type === "branch_summary" || entry.type === "compaction") return true;
  return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

function renderTree(
  tree: SessionTreeNode[],
  labelMaps: LabelMaps,
  rawArchiveAliases: ReadonlySet<string>,
  leafId: string | null,
  activeIds: Set<string>,
  maxDepth: number,
  verbose: boolean,
  signal?: AbortSignal,
): { lines: string[]; truncated: boolean; hiddenNodes: number } {
  const lines: string[] = [];
  let truncated = false;
  let hiddenNodes = 0;
  const visit = (node: SessionTreeNode, depth: number, prefix: string, last: boolean): void => {
    if (signal?.aborted || lines.length >= 200) {
      truncated = true;
      return;
    }
    if (!verbose && !treeNodeVisible(node.entry, labelMaps, leafId)) {
      // Splice: render the children in this node's place so ancestry and
      // branch counts stay truthful without spending a line on plumbing.
      hiddenNodes++;
      node.children.forEach((child, index) => visit(child, depth, prefix, last && index === node.children.length - 1));
      return;
    }
    const role = displayRole(node.entry);
    const labels = formatTimelineLabel(getEntryLabel(labelMaps, node.entry.id), rawArchiveAliases);
    const tags = [
      node.entry.id === leafId ? "HEAD" : null,
      activeIds.has(node.entry.id) ? null : "off-path",
      labels ? `checkpoint: ${labels}` : null,
    ].filter((tag): tag is string => tag !== null);
    const body = snippet(entryText(node.entry, verbose));
    lines.push(`${prefix}${last ? "└─" : "├─"} ${node.entry.id}${tags.length ? ` (${tags.join(", ")})` : ""} [${role}] ${body}`);
    if (depth >= maxDepth && node.children.length > 0) {
      truncated = true;
      return;
    }
    const childPrefix = `${prefix}${last ? "  " : "│ "}`;
    node.children.forEach((child, index) => visit(child, depth + 1, childPrefix, index === node.children.length - 1));
  };
  tree.forEach((root, index) => visit(root, 1, "", index === tree.length - 1));
  return { lines, truncated, hiddenNodes };
}

// The Dashboard spells the two scales out in words; the compact canonical
// form stays on the gauge and receipts where space is tight. Every usage
// line on the Dashboard goes through this one spelling — two spellings of
// the same concept on one screen read as a contradiction.
function describeUsage(pressure: ContextUsagePressure): string {
  const pct = `${Math.floor(pressure.pressurePercent * 10) / 10}%`;
  const ratio = `${formatTokenCount(pressure.tokens)}/${formatTokenCount(pressure.contextWindow)}`;
  return pressure.policy === "400k-cap"
    ? `${pct} of ${formatTokenCount(pressure.workingBudgetTokens)} working budget · ${ratio} hard window`
    : `${pct} of the ${formatTokenCount(pressure.contextWindow)} window (${ratio})`;
}

function describeUsageLike(usage: { tokens: number; contextWindow: number } | undefined): string {
  const pressure = usage ? calculateContextUsagePressure(usage.tokens, usage.contextWindow) : undefined;
  return pressure ? describeUsage(pressure) : "Unknown";
}

function toUsageLike(usage: ReturnType<ExtensionContext["getContextUsage"]>) {
  return usage && usage.tokens != null && usage.percent != null
    ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
    : undefined;
}

const TIMELINE_WORKING_CONTEXT_CAP = 400_000;
const TIMELINE_TOKENS_PER_RESULT_ENTRY = 1_000;
const TIMELINE_MIN_RESULT_ENTRY_BUDGET = 50;

function timelineResultEntryBudget(ctx: ExtensionContext): number {
  const contextWindow = ctx.getContextUsage()?.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return 100;
  }
  return Math.max(
    TIMELINE_MIN_RESULT_ENTRY_BUDGET,
    Math.floor(Math.min(contextWindow, TIMELINE_WORKING_CONTEXT_CAP) / TIMELINE_TOKENS_PER_RESULT_ENTRY),
  );
}

function timelineResultCharacterBudget(ctx: ExtensionContext, authoritative?: { tokens: number; contextWindow: number }): number {
  // The character budget must shrink with the same tokens the gauge and HUD
  // report: during a provider epoch the raw native estimate still describes
  // the pre-travel branch, and sizing output against it would widen the
  // budget exactly when the real context is fullest.
  const usage = authoritative ?? ctx.getContextUsage();
  const contextWindow = typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? usage.contextWindow
    : 100_000;
  const workingWindow = Math.min(contextWindow, TIMELINE_WORKING_CONTEXT_CAP);
  const usedTokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0
    ? Math.min(usage.tokens, workingWindow)
    : 0;
  const remainingTokens = Math.max(0, workingWindow - usedTokens);
  const budgetTokens = Math.max(2_000, Math.floor(Math.min(workingWindow * 0.1, remainingTokens * 0.25)));
  return budgetTokens * 4;
}

function fitTimelineOutputToBudget(
  text: string,
  budget: number,
  leafId: string | null,
  nodeTargetId?: string | null,
  // A structural fact that must survive whenever character fitting removes
  // the body that stated it. It is appended unconditionally on truncation:
  // dynamic HUD text is untrusted data and must never suppress this receipt
  // merely by containing the same words.
  pinnedOnTruncate?: { line: string; reserveChars?: number } | null,
): { text: string; truncated: boolean; retainedSourcePrefixChars: number } {
  if (text.length <= budget) return { text, truncated: false, retainedSourcePrefixChars: text.length };
  // The node view reads one entry in full, so "narrow the query" is not an
  // available move there; its footer names the target and states the cut.
  // IDs come from persisted sessions and may be arbitrarily long, so they
  // are bounded here to keep the footer itself within the budget.
  const boundedId = (value: string) => boundedTimelineValue(value, 80);
  const footer = nodeTargetId
    ? `\n… [timeline node output truncated at ${budget} characters; node ${boundedId(nodeTargetId)}; active leaf ${leafId === null ? "none" : boundedId(leafId)}.]`
    : `\n… [timeline output truncated at ${budget} characters; active leaf ${leafId === null ? "none" : boundedId(leafId)}. Use a narrower filter/query or a smaller view.]`;
  const pinned = pinnedOnTruncate
    ? `\n… [${boundedTimelineValue(pinnedOnTruncate.line, 200)}]`
    : "";
  // Search fits twice: first with a provisional delivered count, then with
  // the measured count. A fixed reservation keeps the retained source prefix
  // identical across both fits, so the count cannot move under its own receipt.
  const pinnedReserve = Math.max(pinned.length, pinnedOnTruncate?.reserveChars ?? 0);
  const prefixLength = Math.max(0, budget - footer.length - pinnedReserve);
  // Bounded IDs keep the footer far below the smallest budget; the final
  // slice enforces the budget invariant even if a future footer outgrows it.
  return {
    text: `${text.slice(0, prefixLength)}${pinned}${footer}`.slice(0, budget),
    truncated: true,
    retainedSourcePrefixChars: Math.min(prefixLength, text.length),
  };
}

/**
 * Count branch positions that fold material away below them — the off-path
 * handoff layers. Equivalent to walking the tree and counting branch nodes
 * with an off-path branch_summary child, but answerable from entries alone:
 * one pass marks branch parents that own an off-path summary. Self-parented
 * entries are roots in the tree and never a child, so they are excluded.
 */
function countOffPathSummaries(branch: SessionEntry[], entries: readonly SessionEntry[], activeIds: Set<string>): number {
  const branchIds = new Set(branch.map((entry) => entry.id));
  const parentsWithOffPathSummary = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "branch_summary") continue;
    if (activeIds.has(entry.id)) continue;
    if (entry.parentId === null || entry.parentId === entry.id) continue;
    if (!branchIds.has(entry.parentId)) continue;
    parentsWithOffPathSummary.add(entry.parentId);
  }
  return parentsWithOffPathSummary.size;
}

export function registerTimelineTool(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const limitSchema = Type.Optional(Type.Integer({
    minimum: 1,
    description: "Requested maximum entries; output budgets may return fewer. Default 50.",
  }));
  const schema = Type.Object({
    view: Type.Optional(Type.Union([
      Type.Literal("active"),
      Type.Literal("checkpoints"),
      Type.Literal("search"),
      Type.Literal("node"),
      Type.Literal("tree"),
    ], { description: "Timeline view mode. Default: active." })),
    limit: limitSchema,
    verbose: Type.Optional(Type.Boolean({ description: "Active view only: show all messages, including internal tool traffic and metadata." })),
    filter: Type.Optional(Type.String({ minLength: 1, description: "Narrow the checkpoints view by label or node-ID substring (case-insensitive)." })),
    query: Type.Optional(Type.String({ minLength: 1, description: "Search text; matches labels, node IDs, and content across the tree, bounded by the 5,000-node scan budget. Required for view=search." })),
    scope: Type.Optional(Type.Union([
      Type.Literal("active"),
      Type.Literal("archive"),
    ], { description: "Search view only: match entries on the active branch (active) or on archived/folded branches (archive). Default: the whole tree within the scan budget." })),
    type: Type.Optional(Type.Union([
      Type.Literal("user"),
      Type.Literal("summary"),
      Type.Literal("tool"),
    ], { description: "Search view only: match user messages (user), branch/compaction summaries (summary), or tool results (tool). Default: all kinds." })),
    target: Type.Optional(Type.String({ minLength: 1, description: "Node to read: a checkpoint name or node ID. Required for view=node." })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "acm_timeline",
    label: "ACM Timeline",
    description: TOOL_DESCRIPTIONS.timeline,
    promptSnippet: PROMPT_SNIPPETS.timeline,
    promptGuidelines: PROMPT_GUIDELINES.timeline.split("\n"),
    parameters: schema,
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const view = optionalString(args.view) ?? "active";
      const displayView = sanitizeTerminalText(view);
      const limit = args.limit === null ? undefined : args.limit;
      const verbose = args.verbose === null ? undefined : args.verbose;
      const filter = optionalString(args.filter);
      const query = optionalString(args.query);
      const target = optionalString(args.target);
      const qualifiers = [`limit ${limit ?? 50}`];
      if (view === "active" && verbose) qualifiers.push("verbose");
      if (view === "checkpoints" && filter) qualifiers.push(`filter “${sanitizeTerminalText(filter)}”`);
      if (view === "search" && query) qualifiers.push(`query “${sanitizeTerminalText(query)}”`);
      const scope = optionalString(args.scope);
      const type = optionalString(args.type);
      if (view === "search" && scope) qualifiers.push(`scope ${scope}`);
      if (view === "search" && type) qualifiers.push(`type ${type}`);
      if (view === "node" && target) qualifiers.push(`target “${sanitizeTerminalText(target)}”`);
      component.setText(
        theme.fg("toolTitle", theme.bold("◆ ACM TIMELINE  "))
          + theme.fg("accent", displayView)
          + theme.fg("dim", `  ·  ${qualifiers.join(" · ")}`),
      );
      return component;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const raw = sanitizeTerminalText(result.content.find((item) => item.type === "text")?.text ?? "");
      const details = result.details as Record<string, unknown> | undefined;

      if (isPartial) {
        component.setText(theme.fg("warning", "◌ Inspecting session evidence…"));
        return component;
      }

      if (typeof details?.error === "string") {
        component.setText(
          theme.fg("error", "✕ TIMELINE UNAVAILABLE")
            + (raw ? `\n${theme.fg("muted", raw.split("\n", 1)[0] ?? raw)}` : ""),
        );
        return component;
      }

      const view = typeof details?.view === "string" ? details.view : "active";
      const displayView = sanitizeTerminalText(view);
      const asCount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const depth = asCount(details?.activeSummaryDepth);
      // Authority-aware pressure for the renderer: the authoritative payload
      // wins; when the authority is not the provider, the native pressure is
      // an acceptable fallback; a declared provider authority with a missing
      // payload renders unknown rather than silently downgrading the source.
      // The payload's tokens/window are the only trusted inputs: the rendered
      // percentage is re-derived from them, so a stale or internally
      // inconsistent pressurePercent cannot disagree with the raw pair beside
      // it, and non-finite or non-positive values fail closed to unknown.
      const asPressure = (value: unknown): ContextUsagePressure | undefined => {
        if (!value || typeof value !== "object") return undefined;
        const candidate = value as Partial<ContextUsagePressure>;
        return calculateContextUsagePressure(candidate.tokens, candidate.contextWindow);
      };
      const authoritative = asPressure(details?.authoritativeContextPressure);
      const providerAuthority = details?.contextUsageAuthority === "provider_turn_end";
      const fallback = providerAuthority ? undefined : asPressure(details?.contextPressure);
      const rendererPressure = authoritative ?? fallback;
      const usage = rendererPressure ? formatContextUsagePressure(rendererPressure, 1) : "unknown";
      let evidence: string;
      if (view === "checkpoints") {
        const hasEntryCounts = typeof details?.checkpointsDisplayedEntries === "number"
          && typeof details?.checkpointsMatchingEntries === "number";
        const shownAliases = asCount(details?.checkpointsDisplayedAliases);
        const totalAliases = asCount(details?.checkpointsMatchingAliases);
        const root = typeof details?.rootCandidateEntryId === "string" ? ` · root ${sanitizeTerminalText(details.rootCandidateEntryId)}` : "";
        if (hasEntryCounts) {
          const shownEntries = details.checkpointsDisplayedEntries as number;
          const totalEntries = details.checkpointsMatchingEntries as number;
          const namedAliases = typeof details?.checkpointAliasNamesShown === "number"
            ? details.checkpointAliasNamesShown
            : shownEntries;
          const aliasesOnEntries = typeof details?.checkpointAliasesOnMatchingEntries === "number"
            ? details.checkpointAliasesOnMatchingEntries
            : totalAliases;
          evidence = `${shownEntries}/${totalEntries} entries · ${namedAliases}/${aliasesOnEntries} alias names shown${root}`;
        } else {
          evidence = `${shownAliases}/${totalAliases} aliases shown${root}`;
        }
      } else if (view === "search") {
        const matches = asCount(details?.searchDisplayedMatches);
        const scanned = asCount(details?.searchScannedNodes);
        const budget = asCount(details?.searchScanBudget);
        const scanSuffix = budget > 0 ? ` · scanned ${scanned}/${budget}` : "";
        const truncationSuffix = details?.searchTruncated
          ? (typeof details?.searchTruncationReason === "string" ? ` · truncated (${searchTruncationPhrase(details.searchTruncationReason as "limit" | "scan_budget" | "text_budget" | "signal" | null)})` : " · truncated")
          : "";
        evidence = `${matches} match${matches === 1 ? "" : "es"}${truncationSuffix}${scanSuffix}`;
      } else if (view === "node") {
        const nodeId = typeof details?.nodeEntryId === "string" ? sanitizeTerminalText(details.nodeEntryId) : "unknown";
        const before = asCount(details?.nodeBeforeCount);
        const after = asCount(details?.nodeAfterCount);
        evidence = `node ${nodeId} · ${before} before · ${after} after`;
      } else if (view === "tree") {
        const lines = asCount(details?.outputLines);
        evidence = `${lines} rendered lines${details?.treeTruncated ? " · truncated" : ""}`;
      } else {
        const nodes = asCount(details?.activePathNodes);
        const shown = asCount(details?.activeDisplayedEntries);
        const visible = asCount(details?.activeVisibleEntries);
        evidence = `${nodes} active nodes · ${shown}/${visible} visible entries shown`;
      }

      const delivery = sanitizeTerminalText(typeof details?.contextDeliveryPhase === "string"
        ? details.contextDeliveryPhase
        : "active");
      const lines = [
        theme.fg("success", "✓ TIMELINE READY") + theme.fg("accent", `  ${displayView.toUpperCase()}`),
        theme.fg("muted", `  ${evidence} · handoff layers ${depth}`),
        theme.fg("dim", `  context ${usage} · delivery ${delivery}`),
      ];

      if (expanded && raw) {
        lines.push(theme.fg("dim", "  ─ full dashboard and view ─"), theme.fg("toolOutput", raw));
      } else if (raw) {
        const marker = "---------------------------------------------------\n";
        const body = raw.includes(marker) ? raw.slice(raw.indexOf(marker) + marker.length) : "";
        const bodyLines = body.split("\n").filter((line) => line.length > 0);
        for (const line of bodyLines.slice(0, 4)) lines.push(theme.fg("toolOutput", `  ${line}`));
        if (bodyLines.length > 4) lines.push(theme.fg("dim", `  … ${bodyLines.length - 4} more line(s); expand for full output`));
      }

      component.setText(lines.join("\n"));
      return component;
    },
    async execute(
      _id: string,
      rawParams: Static<typeof schema>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const view = optionalString(rawParams.view) ?? "active";
      const limit = rawParams.limit === null ? undefined : rawParams.limit;
      const verbose = rawParams.verbose === null ? undefined : rawParams.verbose;
      const filter = optionalString(rawParams.filter);
      const query = optionalString(rawParams.query);
      const target = optionalString(rawParams.target);
      const scope = optionalString(rawParams.scope) as "active" | "archive" | undefined;
      const type = optionalString(rawParams.type) as "user" | "summary" | "tool" | undefined;
      const params = { view, limit: limit ?? 50, verbose, filter, query, target, scope, type } as
        | { view: "active"; limit: number; verbose?: boolean }
        | { view: "checkpoints"; limit: number; filter?: string }
        | { view: "search"; limit: number; query: string; scope?: "active" | "archive"; type?: "user" | "summary" | "tool" }
        | { view: "node"; limit: number; target: string }
        | { view: "tree"; limit: number; verbose?: boolean };
      // Silently ignored parameters produce false negatives (a filter on the
      // search view looks like an empty result). Name what was ignored.
      const ignoredParams: string[] = [];
      if (filter && view !== "checkpoints") ignoredParams.push(`'filter' (only applies to view=checkpoints)`);
      if (query && view !== "search") ignoredParams.push(`'query' (only applies to view=search)`);
      if (target && view !== "node") ignoredParams.push(`'target' (only applies to view=node)`);
      if (verbose !== undefined && view !== "active" && view !== "tree") ignoredParams.push(`'verbose' (only applies to view=active and view=tree)`);
      if (scope !== undefined && view !== "search") ignoredParams.push(`'scope' (only applies to view=search)`);
      if (type !== undefined && view !== "search") ignoredParams.push(`'type' (only applies to view=search)`);
      if (params.view === "search" && !params.query) {
        return {
          content: [{ type: "text" as const, text: "Error: 'query' is required when view=search." }],
          details: { error: "missing_query" },
        };
      }
      if (params.view === "node" && !params.target) {
        return {
          content: [{ type: "text" as const, text: "Error: 'target' is required when view=node. Pass a checkpoint name or node ID; view=search locates candidates." }],
          details: { error: "missing_target" },
        };
      }
      const requestedLimit = params.limit;
      const resultEntryBudget = timelineResultEntryBudget(ctx);
      const effectiveLimit = Math.min(requestedLimit, resultEntryBudget);
      const resultBudgetApplied = requestedLimit > effectiveLimit;
      const budgetAuthority = runtime.authoritativeContextPressure(ctx.sessionManager, toUsageLike(ctx.getContextUsage()));
      const resultCharacterBudget = timelineResultCharacterBudget(
        ctx,
        budgetAuthority ? { tokens: budgetAuthority.tokens, contextWindow: budgetAuthority.contextWindow } : undefined,
      );
      const sessionManager = ctx.sessionManager;
      // getTree() rebuilds the whole tree on every call. Views that can
      // answer from branch/entries (active) never pay for it; the views that
      // genuinely walk the tree fetch it once here, lazily.
      let treeCache: SessionTreeNode[] | undefined;
      const treeOnce = (): SessionTreeNode[] => (treeCache ??= sessionManager.getTree());
      const branch = sessionManager.getBranch();
      const entries = sessionManager.getEntries();
      const leafId = sessionManager.getLeafId();
      // Same per-session label cache the gauge and travel read through: a
      // timeline right after a gauge render replays nothing.
      const labelMaps = runtime.labelMapsFor(sessionManager, entries, () => buildLabelMaps(entries));
      const activeIds = new Set(branch.map((entry) => entry.id));
      const activeSummaryDepth = countActiveSummaryDepth(branch);
      // Computed once here: the active view's HUD line and every view's
      // details field ask the same question; the old shape walked entries
      // twice on the active view.
      const offPathSummaryCount = countOffPathSummaries(branch, entries, activeIds);
      // entriesById/pathOrder serve only the checkpoints listing and move
      // into that view; the raw archive alias set serves several views and
      // becomes lazy instead - built on first use, shared thereafter.
      const EMPTY_LABEL_ALIASES: ReadonlySet<string> = new Set();
      let rawArchiveAliasesCache: ReadonlySet<string> | undefined;
      const rawArchiveAliasesOnce = (): ReadonlySet<string> =>
        (rawArchiveAliasesCache ??= collectRawArchiveAliases(entries, labelMaps));
      const lines: string[] = [];
      let treeTruncated = false;
      let activeVisibleEntries = 0;
      let activeDisplayedEntries = 0;
      let activeOmittedEntries = 0;
      let checkpointsMatchingAliases = 0;
      let checkpointsDisplayedAliases = 0;
      let checkpointsMatchingEntries = 0;
      let checkpointsDisplayedEntries = 0;
      let checkpointAliasesOnMatchingEntries = 0;
      let checkpointAliasNamesShown = 0;
      let checkpointsRenderAborted = false;
      let rootCandidateDisplayed = false;
      let rootCandidateEntryId: string | null = null;
      let rootProjectedSummaryDepth: number | null = null;
      let searchSelectedMatches = 0;
      let searchDisplayedMatches = 0;
      let searchMatchLineIndexes: number[] = [];
      let searchTruncated = false;
      let searchTruncationReason: "limit" | "scan_budget" | "text_budget" | "signal" | null = null;
      let searchScannedNodes = 0;
      let searchTextChars = 0;
      let searchNodesCutAtNodeCap = 0;
      let searchNodesCutAtCallBudget = 0;
      let searchPartialNodeCuts = 0;
      let searchScope: "active" | "archive" | null = null;
      let searchType: "user" | "summary" | "tool" | null = null;
      let nodeRequestedTarget: string | null = null;
      let nodeEntryId: string | null = null;
      let nodeLabel: string | null = null;
      let nodeRole: string | null = null;
      let nodeOnActivePath = false;
      let nodeBeforeCount = 0;
      let nodeAfterCount = 0;
      let nodeNeighborScanAborted = false;

      if (params.view === "checkpoints") {
        const filter = params.filter?.toLowerCase() ?? "";
        const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
        const pathOrder = new Map(branch.map((entry, index) => [entry.id, index]));
        const listings = collectListings(labelMaps, activeIds, leafId, filter, entriesById, pathOrder, rawArchiveAliasesOnce());
        const rootEntry = treeOnce()[0]?.entry;
        const rootMatchesFilter = rootEntry && rootEntry.id !== leafId && (
          !filter || "root".includes(filter) || rootEntry.id.toLowerCase().includes(filter)
        );
        const checkpointListingLimit = Math.max(0, effectiveLimit - (rootMatchesFilter ? 1 : 0));
        const displayedListings = listings.slice(0, checkpointListingLimit);
        checkpointsMatchingEntries = listings.length;
        checkpointsDisplayedEntries = displayedListings.length;
        // One label per entry, so alias counts collapse onto entry counts.
        checkpointsMatchingAliases = listings.length;
        checkpointsDisplayedAliases = displayedListings.length;
        checkpointAliasesOnMatchingEntries = listings.length;
        checkpointAliasNamesShown = displayedListings.length;
        // Same pressure authority as the gauge and HUD: during a provider
        // epoch the host estimate still describes the pre-travel branch, so
        // Current usage and every target estimate below must read the
        // authoritative tokens — mixing them with the HUD's authoritative
        // line in one result would be a visible self-contradiction.
        const checkpointsPressure = runtime.authoritativeContextPressure(sessionManager, toUsageLike(ctx.getContextUsage()));
        const usage = checkpointsPressure
          ? { tokens: checkpointsPressure.tokens, contextWindow: checkpointsPressure.contextWindow, percent: checkpointsPressure.usagePercent }
          : undefined;
        // One snapshot for the current leaf, root, and every displayed
        // checkpoint, built lazily: a repeat call whose projections all hit
        // the runtime cache never reads the entries or builds the ID index
        // at all. Every rebuild that does run flows through the compact
        // projection cache - derived numbers kept, packet and branch
        // released - so no per-target protocol analysis, no per-target
        // memory.
        let snapshotCache: ReturnType<typeof createAcmPacketSnapshot> | undefined;
        const projectionAt = (wantedLeafId: string | null): FoldProjectionCacheEntry | undefined => {
          snapshotCache ??= createAcmPacketSnapshot(sessionManager);
          const result = snapshotCache.rebuild(wantedLeafId);
          if (!result.ok) {
            // A failed snapshot (transient entries read) must not be reused:
            // drop it so the next attempt rebuilds from the host instead of
            // replaying the failure forever.
            snapshotCache = undefined;
            return undefined;
          }
          return {
            aggregate: aggregateMessages(result.value.messages),
            projectedSummaryDepth: projectSummaryDepthAfterTravel(result.branch),
          };
        };
        let currentProjection = runtime.foldProjection(
          sessionManager,
          { kind: "current", leafId, entriesLength: entries.length, lastEntryId: entries.at(-1)?.id ?? "" },
          () => projectionAt(leafId),
        );
        if (!currentProjection) {
          // Misses are not negatively cached; re-run to distinguish a real
          // failure from a transient one. A successful re-run means the miss
          // was transient — render with it rather than reporting a fabricated
          // error for a packet that did build.
          snapshotCache = createAcmPacketSnapshot(sessionManager);
          const retried = snapshotCache.rebuild(leafId);
          if (retried.ok) {
            currentProjection = {
              aggregate: aggregateMessages(retried.value.messages),
              projectedSummaryDepth: projectSummaryDepthAfterTravel(retried.branch),
            };
          } else {
            return {
              content: [{ type: "text" as const, text: `Checkpoints (${listings.length} matching entries / ${checkpointsMatchingAliases} matched aliases / ${checkpointAliasesOnMatchingEntries} total aliases, 0 displayed). Current messages could not be built: ${retried.message}` }],
              details: { error: retried.error, message: retried.message },
            };
          }
        }
        // Same aggregate cache the gauge, HUD, and checkpoint receipt render
        // through: the current reading is summed once (and shared with those
        // surfaces), each target pays one cold scan ever. The old array form
        // re-summed the full current message list for every displayed target.
        const currentAggregate = currentProjection.aggregate;
        const projectionFor = (entryId: string): FoldProjectionCacheEntry | undefined =>
          runtime.foldProjection(sessionManager, { kind: "target", entryId }, () => projectionAt(entryId));
        // Header grammar: entry counts only when they carry information.
        // An unfiltered list that fits needs one number, not five.
        const currentSummary = `Current position: ${currentAggregate.messageCount} msg(s) in context, ${describeUsageLike(usage)}${activeSummaryDepth > 0 ? `, handoff layers ${activeSummaryDepth}` : ""}.`;
        if (listings.length === 0 && !rootMatchesFilter) {
          lines.push(filter ? `No checkpoints match '${boundedTimelineValue(params.filter ?? "")}'. ${currentSummary}` : `No checkpoints yet. ${currentSummary}`);
        }
        // The header states how many rows follow, but an abort can stop the
        // render mid-list. Reserve its slot now and write it once the rendered
        // count is final, so "showing N" and the "+N more" tail describe the
        // rows actually present instead of the pre-abort plan.
        const checkpointsHeaderSlot = listings.length === 0 && !rootMatchesFilter ? -1 : lines.length;
        if (checkpointsHeaderSlot >= 0) lines.push("");
        if (rootEntry && rootMatchesFilter) {
          const rootProjection = projectionFor(rootEntry.id);
          rootCandidateDisplayed = true;
          rootCandidateEntryId = rootEntry.id;
          rootProjectedSummaryDepth = rootProjection
            ? rootProjection.projectedSummaryDepth
            : projectSummaryDepthAfterTravel(sessionManager.getBranch(rootEntry.id));
          let estimateText = "message estimate unavailable";
          if (rootProjection) {
            const estimated = usage && currentAggregate
              ? estimateUsageFromAggregates(usage, currentAggregate, rootProjection.aggregate)
              : undefined;
            estimateText = estimated
              ? `~${rootProjection.aggregate.messageCount} msg(s) kept, ~${formatContextUsage(estimated)} est. (incl. the new handoff)`
              : `~${rootProjection.aggregate.messageCount} msg(s) kept`;
          }
          const rootTopology = treeOnce().length > 1 ? `, first of ${treeOnce().length} top-level roots` : "";
          const rootDepthNote = activeSummaryDepth > 0 && rootProjectedSummaryDepth === 1
            ? "; projected depth is 1 rather than 0 because travel appends one new handoff"
            : "";
          lines.push(`  root → ${rootEntry.id} (session start — not a named checkpoint, but a valid travel target${rootTopology}) ${estimateText}; handoff layers ${activeSummaryDepth} → ${rootProjectedSummaryDepth} after this fold${rootDepthNote}`);
        }
        let checkpointsRendered = 0;
        for (const checkpoint of displayedListings) {
          if (signal?.aborted) break;
          checkpointsRendered += 1;
          const targetProjection = projectionFor(checkpoint.entryId);
          const estimated = usage && currentAggregate && targetProjection
            ? estimateUsageFromAggregates(usage, currentAggregate, targetProjection.aggregate)
            : undefined;
          const estimateText = targetProjection === undefined
            ? "message estimate unavailable"
            : estimated
              ? `~${targetProjection.aggregate.messageCount} msg(s) kept, ~${formatContextUsage(estimated)} est. (incl. the new handoff)`
              : `~${targetProjection.aggregate.messageCount} msg(s) kept`;
          // Only a failed projection falls back to a live branch walk.
          const projectedSummaryDepth = targetProjection
            ? targetProjection.projectedSummaryDepth
            : projectSummaryDepthAfterTravel(sessionManager.getBranch(checkpoint.entryId));
          const rawArchiveNote = checkpoint.isRawArchive
            ? "; raw archive — restores pre-fold history; fold targets are the entries before the folded material"
            : "";
          lines.push(`  ${checkpoint.entryId} (checkpoint: ${formatCheckpointLabel(checkpoint)}; ${checkpoint.onActivePath ? "on-path" : "off-path"}${checkpoint.isHead ? ", *HEAD*" : ""}${rawArchiveNote}) ${estimateText}; handoff layers ${activeSummaryDepth} → ${projectedSummaryDepth} after this fold`);
        }
        if (signal?.aborted && checkpointsRendered < checkpointsDisplayedEntries) {
          // Every displayed count must match rendered rows, and the reason for
          // missing rows must remain distinct from the ordinary result limit.
          checkpointsRenderAborted = true;
          checkpointsDisplayedEntries = checkpointsRendered;
          checkpointsDisplayedAliases = checkpointsRendered;
          checkpointAliasNamesShown = checkpointsRendered;
        }
        if (checkpointsHeaderSlot >= 0) {
          // checkpointsDisplayedEntries is already reconciled to the rendered
          // rows above, so header and body cannot disagree.
          const savePointCount = `${listings.length} save point${listings.length === 1 ? "" : "s"}`;
          const shownNote = checkpointsRenderAborted
            ? `, rendering interrupted after ${checkpointsDisplayedEntries}/${listings.length} by cancellation`
            : checkpointsDisplayedEntries < listings.length
              ? `, showing ${checkpointsDisplayedEntries} (limit ${effectiveLimit})`
              : "";
          const filterNote = filter ? ` matching '${boundedTimelineValue(params.filter ?? "")}'` : "";
          lines[checkpointsHeaderSlot] = `Checkpoints: ${savePointCount}${filterNote}${shownNote}. ${currentSummary} Each line projects the state after folding to that target (a handoff layer is one fold's summary standing in for replaced history):`;
        }
        const checkpointsOmitted = listings.length - checkpointsDisplayedEntries;
        if (checkpointsOmitted > 0) {
          lines.push(checkpointsRenderAborted
            ? `  ... render interrupted by cancellation; ${checkpointsOmitted} matching save point${checkpointsOmitted === 1 ? "" : "s"} not rendered — retry the request`
            : `  ... +${checkpointsOmitted} more — use a narrower filter or query`);
        }
      } else if (params.view === "search") {
        const search = searchTree(treeOnce(), labelMaps, params.query, effectiveLimit, signal, {
          scope: params.scope,
          type: params.type,
          activeIds,
          scanNodeBudget: TIMELINE_SEARCH_SCAN_NODE_BUDGET,
        });
        searchSelectedMatches = search.matches.length;
        searchTruncated = search.truncated;
        searchTruncationReason = search.truncationReason;
        searchScannedNodes = search.scannedNodes;
        searchTextChars = search.textChars;
        searchNodesCutAtNodeCap = search.nodesCutAtNodeCap;
        searchNodesCutAtCallBudget = search.nodesCutAtCallBudget;
        searchScope = params.scope ?? null;
        searchType = params.type ?? null;
        const searchQualifiers = [
          params.scope !== undefined ? `scope ${params.scope}` : null,
          params.type !== undefined ? `type ${params.type}` : null,
        ].filter((qualifier) => qualifier !== null).join(", ");
        // Selection happens before the result-character budget is fitted. The
        // final delivered count is measured from complete match rows that
        // survive fitting and is reported separately below.
        const partialNodeCuts = search.nodesCutAtNodeCap + search.nodesCutAtCallBudget;
        searchPartialNodeCuts = partialNodeCuts;
        lines.push(
          `Search '${boundedTimelineValue(params.query)}': ${search.matches.length} matching node(s) selected before output fitting${search.truncated && search.truncationReason !== null ? `; truncated (${searchTruncationPhrase(search.truncationReason)})` : ""}${partialNodeCuts > 0 ? `; ${partialNodeCuts} node(s) partially searched (their later text was not searched)` : ""}; scanned ${search.scannedNodes}/${search.scanBudget} node(s), ${search.textChars}/${search.textBudget} text-budget chars${searchQualifiers.length > 0 ? `; ${searchQualifiers}` : ""}.`,
        );
        for (const match of search.matches) {
          const body = match.text;
          const displayLabel = formatTimelineLabel(match.label, rawArchiveAliasesOnce());
          const matchLine = `  ${match.entry.id}${displayLabel ? ` (checkpoint: ${displayLabel})` : ""} [${displayRole(match.entry)}] ${body}`;
          searchMatchLineIndexes.push(lines.length);
          lines.push(matchLine);
        }
        if (search.nodesCutAtNodeCap > 0) {
          lines.push(`  ... ${search.nodesCutAtNodeCap} node(s) were searched only through their first ${SEARCH_NODE_TEXT_MAX_CHARS.toLocaleString("en-US")} source chars; matches later in those nodes were not searched`);
        }
        if (search.nodesCutAtCallBudget > 0) {
          lines.push(`  ... ${search.nodesCutAtCallBudget} node(s) were cut at the remaining per-call text budget; matches later in those nodes were not searched`);
        }
        if (search.truncated) {
          // The budget counts traversal, and scope/type only filter content —
          // narrowing filters does NOT bring later nodes into reach, so the
          // recovery line must not claim it does. A more specific query finds
          // earlier matches; unreachable nodes stay unreachable.
          lines.push(search.truncationReason === "scan_budget"
            ? `  ... scan stopped at the 5,000-node limit; nodes after it were not searched this call — use a more specific query to hit earlier matches, or view=tree to navigate`
            : search.truncationReason === "text_budget"
              ? `  ... scan stopped at the text budget; later nodes were not searched, and any partial-node cuts are reported above — use a more specific query or view=tree to navigate`
              : `  ... scan stopped early (${search.truncationReason === null ? "display limit" : searchTruncationPhrase(search.truncationReason)}); narrow with scope/type or a longer query`);
        }
      } else if (params.view === "node") {
        nodeRequestedTarget = params.target;
        const resolved = resolveTargetId(sessionManager, treeOnce(), params.target, activeIds, labelMaps);
        const treeNode = resolved.id.length > 0 ? findInTree(treeOnce(), (n) => n.entry.id === resolved.id) : undefined;
        if (!treeNode) {
          return {
            content: [{ type: "text" as const, text: `Error: Target '${boundedTimelineValue(params.target)}' not found in the session tree. Valid targets are checkpoint names and node IDs; view=search locates candidates.` }],
            details: { error: "target_not_found", nodeRequestedTarget: params.target, resolvedTargetId: resolved.id },
          };
        }
        const targetEntry = treeNode.entry;
        nodeEntryId = targetEntry.id;
        nodeRole = displayRole(targetEntry);
        nodeOnActivePath = activeIds.has(targetEntry.id);
        const label = getEntryLabel(labelMaps, targetEntry.id);
        nodeLabel = label ?? null;
        // Spine ancestors and nearest descendants frame the target; the tree
        // may fork below it, so "after" lists nearest readable descendants
        // across every child branch instead of claiming one linear next.
        const spine = sessionManager.getBranch(targetEntry.id);
        const neighborRadius = 2;
        const beforeQuota = Math.min(neighborRadius, Math.max(0, effectiveLimit - 1));
        const before = collectSpineNeighbors(spine, targetEntry.id, beforeQuota);
        const afterQuota = Math.min(neighborRadius, Math.max(0, effectiveLimit - 1 - before.length));
        const afterResult = collectDescendantNeighbors(treeNode, afterQuota, signal);
        nodeBeforeCount = before.length;
        nodeAfterCount = afterResult.neighbors.length;
        nodeNeighborScanAborted = afterResult.aborted;
        const displayLabel = formatTimelineLabel(label, rawArchiveAliasesOnce());
        const afterCountText = afterResult.aborted ? `${nodeAfterCount}+ (scan interrupted)` : `${nodeAfterCount}`;
        lines.push(`Node ${targetEntry.id}${displayLabel ? ` (checkpoint: ${displayLabel})` : ""} [${nodeRole}] — ${nodeOnActivePath ? "on-path" : "off-path"}; node text below with ${nodeBeforeCount} neighbor(s) before and ${afterCountText} after.`);
        for (const entry of before) {
          lines.push(`  before ${entry.id} [${displayRole(entry)}] ${snippet(entryText(entry, true))}`);
        }
        const fullText = entryText(targetEntry, true);
        lines.push(`--- node ${targetEntry.id} text ---`);
        lines.push(fullText.length > 0 ? fullText : "[no text content]");
        lines.push(`--- end of node ${targetEntry.id} ---`);
        if (afterResult.aborted) {
          lines.push(`  (descendant scan interrupted by cancellation — the after list may omit existing neighbors)`);
        }
        if (afterResult.branchCount > 1) {
          lines.push(`  (${afterResult.branchCount} child branches continue from this node; nearest readable descendants listed below)`);
        }
        for (const entry of afterResult.neighbors) {
          lines.push(`  after ${entry.id} [${displayRole(entry)}] ${snippet(entryText(entry, true))}`);
        }
      } else if (params.view === "tree") {
        const treeVerbose = params.verbose ?? false;
        const rendered = renderTree(treeOnce(), labelMaps, rawArchiveAliasesOnce(), leafId, activeIds, effectiveLimit, treeVerbose, signal);
        lines.push(...rendered.lines);
        treeTruncated = rendered.truncated || lines.length >= 200;
        if (rendered.hiddenNodes > 0) {
          lines.push(`  (${rendered.hiddenNodes} structural/metadata node(s) hidden — pass verbose=true to show them)`);
        }
        if (treeTruncated) lines.unshift("⚠ tree truncated by depth/line limit — use view checkpoints or view search to see hidden nodes");
      } else {
        const verbose = params.verbose ?? false;
        const visible = branch.filter((entry) => visibleOnActivePath(entry, labelMaps, leafId, verbose));
        activeVisibleEntries = visible.length;
        activeDisplayedEntries = Math.min(visible.length, effectiveLimit);
        activeOmittedEntries = Math.max(0, visible.length - effectiveLimit);
        {
          const shown = Math.min(visible.length, effectiveLimit);
          const filtered = branch.length - visible.length;
          const pastLimit = visible.length - shown;
          const reductions = [
            filtered > 0 ? `${filtered} structural/tool node${filtered === 1 ? "" : "s"} filtered (verbose=true shows them)` : null,
            pastLimit > 0 ? `${pastLimit} older row${pastLimit === 1 ? "" : "s"} past limit=${effectiveLimit}` : null,
          ].filter((part): part is string => part !== null);
          lines.push(`Showing the latest ${shown} of ${branch.length} tree nodes${reductions.length > 0 ? ` — ${reductions.join(", ")}` : ""}. Markers: * = current position (HEAD), • = user message, | = assistant/summary rows.`);
        }
        if (activeOmittedEntries > 0) lines.push(`  :  ... (${activeOmittedEntries} earlier visible entries omitted by limit) ...`);
        // The alias scan only runs when the visible window actually contains
        // a labelled entry - the only rows that can render a checkpoint
        // annotation. Label-free windows skip the O(entries) pass entirely.
        const displayedVisible = visible.slice(-effectiveLimit);
        const visibleAliases = displayedVisible.some((entry) => labelMaps.entryToLabel.has(entry.id))
          ? rawArchiveAliasesOnce()
          : EMPTY_LABEL_ALIASES;
        for (const entry of displayedVisible) {
          const labels = formatTimelineLabel(getEntryLabel(labelMaps, entry.id), visibleAliases);
          const tags = [entry === branch[0] ? "ROOT" : null, entry.id === leafId ? "HEAD" : null, labels ? `checkpoint: ${labels}` : null]
            .filter((tag): tag is string => tag !== null);
          const rawBody = snippet(entryText(entry, verbose));
          const body = rawBody || (entry.id === leafId && displayRole(entry) === "AI" ? "(in-progress assistant turn — no text yet)" : rawBody);
          lines.push(`${entry.id === leafId ? "*" : displayRole(entry) === "USER" ? "•" : "|"} ${entry.id}${tags.length ? ` (${tags.join(", ")})` : ""} [${displayRole(entry)}] ${body}`);
        }
      }

      const officialUsageRaw = ctx.getContextUsage();
      const officialUsage = toUsageLike(officialUsageRaw);
      const officialPressure = calculateContextUsagePressure(
        officialUsageRaw?.tokens,
        officialUsageRaw?.contextWindow,
        officialUsageRaw?.percent,
      );
      const lastUsage = runtime.getUsage(sessionManager);
      let stepsSinceCheckpoint = 0;
      let msgsSinceCheckpoint = 0;
      let nearestCheckpoint: string | null = null;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        const label = getEntryLabel(labelMaps, entry.id);
        if (label !== undefined) {
          nearestCheckpoint = label;
          break;
        }
        stepsSinceCheckpoint++;
        if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
          msgsSinceCheckpoint++;
        }
      }
      const refreshFailure = runtime.contextRefresh.getFailure(sessionManager);
      const refreshPending = runtime.contextRefresh.isPending(sessionManager);
      const deliveryPhase = runtime.getContextDeliveryPhase(sessionManager);
      const providerDelivery = runtime.getProviderDeliveryStatus(sessionManager);
      const providerTurnUsageAuthoritative = runtime.isProviderUsageAuthoritative(sessionManager);
      const authoritativePressure = runtime.authoritativeContextPressure(sessionManager, officialUsage);
      // Fold projections: what a fold at each structural reference point would
      // leave, on the same working-budget yardstick the pressure line uses.
      // Numerator and denominator both come from the authoritative pressure —
      // mixing the official numerator with the authoritative denominator reads
      // as a contradiction the moment the two sources diverge (same pattern as
      // the gauge adapter in runtime-lifecycle). Facts only — whether the
      // extraction is complete stays CORE's bar.
      // One aggregate serves both the fold projection and the message count
      // on the Active Path line — msg is the unit fold decisions read. It
      // flows through the same shared cache the gauge renders through, so a
      // timeline HUD right after a gauge render — the common case, since both
      // read the same session around the same boundaries — rebuilds nothing.
      let foldSnapshot: ReturnType<typeof createAcmPacketSnapshot> | undefined;
      const aggregateAt = (wantedLeafId: string | null): MessageAggregate | undefined => {
        foldSnapshot ??= createAcmPacketSnapshot(sessionManager);
        const result = foldSnapshot.rebuild(wantedLeafId);
        return result.ok ? aggregateMessages(result.value.messages) : undefined;
      };
      // Key inputs reuse the consistent snapshot this tool already read
      // (entries/leafId above): no second unprotected host read, and a
      // failure anywhere in acquisition degrades to the fallback lines
      // instead of rejecting the whole timeline call.
      let hudAggregate: MessageAggregate | undefined;
      try {
        hudAggregate = runtime.foldAggregate(
          sessionManager,
          { kind: "current", leafId, entriesLength: entries.length, lastEntryId: entries.at(-1)?.id ?? "" },
          () => aggregateAt(leafId),
        );
      } catch {
        hudAggregate = undefined;
      }
      let foldProjectionText = "unavailable";
      try {
        const foldBranch = branch as unknown as readonly FoldEstimateEntry[];
        const references = selectFoldReferences(foldBranch, labelMaps);
        const estimates = authoritativePressure && hudAggregate
          ? estimateFoldGainsFromAggregates({
              usage: {
                tokens: authoritativePressure.tokens,
                contextWindow: authoritativePressure.contextWindow,
                percent: 0,
              },
              workingBudgetTokens: authoritativePressure.workingBudgetTokens,
              currentAggregate: hudAggregate,
              aggregateAt: (id: string) => runtime.foldAggregate(sessionManager, { kind: "target", entryId: id }, () => aggregateAt(id)),
            }, references)
          : { turnPercent: null, taskPercent: null };
        const scale = authoritativePressure ? foldProjectionScaleName(authoritativePressure.policy) : "budget";
        // Before → after → saved: the current pressure is the before, each
        // projection is the after, and the delta is the decision-ready part.
        const nowPercent = authoritativePressure ? Math.floor(authoritativePressure.pressurePercent) : null;
        const withSavings = (projected: number): string => {
          const after = Math.floor(projected);
          const saved = nowPercent != null ? nowPercent - after : null;
          return saved != null && saved > 0 ? `~${after}% ${scale} (saves ~${saved}pt)` : `~${after}% ${scale}`;
        };
        const segs: string[] = [];
        if (estimates.turnPercent != null && references.turn) {
          segs.push(`turn '${boundedTimelineValue(references.turn.label ?? references.turn.entryId)}' → ${withSavings(estimates.turnPercent)}`);
        }
        if (estimates.taskPercent != null && references.task) {
          segs.push(`task '${boundedTimelineValue(references.task.label ?? references.task.entryId)}' → ${withSavings(estimates.taskPercent)}`);
        }
        const nowPrefix = nowPercent != null && segs.length > 0 ? `now ~${nowPercent}% ${scale}; ` : "";
        foldProjectionText = segs.length > 0 ? `${nowPrefix}${segs.join("; ")}` : "no reference point on this path";
      } catch {
        foldProjectionText = "unavailable";
      }
      // One authoritative usage line; the secondary readings appear only when
      // they disagree with it enough to change a decision. Identical numbers
      // repeated under three different names read as noise, not precision.
      const primaryUsageLine = authoritativePressure
        ? `• Context Usage:    ${describeUsage(authoritativePressure)} (${providerTurnUsageAuthoritative ? "provider actual" : "native estimate"})`
        : `• Context Usage:    ${formatContextUsage(officialUsage)} (native estimate)`;
      const usageLines: string[] = [primaryUsageLine];
      if (authoritativePressure && officialUsage && Math.abs(officialUsage.tokens - authoritativePressure.tokens) > 1024) {
        usageLines.push(`• Native Estimate:  ${describeUsageLike(officialUsage)} (host estimate; may lag right after a travel)`);
      }
      if (lastUsage && authoritativePressure && Math.abs(lastUsage.tokens - authoritativePressure.tokens) > 1024) {
        usageLines.push(`• Last Turn End:    ${describeUsageLike(lastUsage)} (recorded at the end of the previous turn)`);
      }
      const offPathHandoffs = offPathSummaryCount;
      // Funnel line: tree nodes -> LLM messages, one conversion statement.
      // Subtraction is not classification (packet rebuild folds tool results
      // into their parent messages), so the delta says what it is — nodes
      // with no standalone message — instead of naming node types it never
      // inspected. Tiers: zero delta needs no aside; a large one answers the
      // real question ("did I lose content?"), not the arithmetic.
      let activePathLine: string;
      if (hudAggregate) {
        const msgs = hudAggregate.messageCount;
        const nodes = branch.length;
        const delta = nodes - msgs;
        const aside = delta <= 0
          ? ""
          : delta > 5
            ? ` (${delta} nodes carry no standalone message — tool results and metadata folded into their turns; no content dropped)`
            : ` (${delta} node${delta === 1 ? "" : "s"} carr${delta === 1 ? "ies" : "y"} no standalone message — tool/metadata)`;
        activePathLine = `• Active Path:      ${nodes} tree node${nodes === 1 ? "" : "s"} → ${msgs} LLM message${msgs === 1 ? "" : "s"}${aside}`;
      } else {
        activePathLine = `• Active Path:      ${branch.length} tree node(s) — the LLM context follows this path`;
      }
      const hudParts = [
        "[Context Dashboard]",
        ...(providerDelivery.persistentMutationApplied
          ? ["• Travel Mutation:  applied — the provider context was rewritten by a travel this session"]
          : []),
        ...usageLines,
        activePathLine,
        ...(activeSummaryDepth > 0
          ? [`• Handoff Layers:   ${activeSummaryDepth} on the current path — each layer is one fold's summary standing in for replaced history`]
          : []),
        ...(offPathHandoffs > 0
          ? [`• Off-path Handoffs: ${offPathHandoffs} branch point(s) with archived handoffs`]
          : []),
        nearestCheckpoint
          ? `• Last Save Point:  '${boundedTimelineValue(nearestCheckpoint)}' — ${msgsSinceCheckpoint} user/assistant message${msgsSinceCheckpoint === 1 ? "" : "s"} back (${stepsSinceCheckpoint} tree nodes)`
          : `• Last Save Point:  none on this path yet (${msgsSinceCheckpoint} user/assistant message${msgsSinceCheckpoint === 1 ? "" : "s"} so far)`,
        `• Fold Projection:  ${foldProjectionText}`,
      ];
      if (ignoredParams.length > 0) {
        hudParts.push(`• Ignored Params:   ${ignoredParams.join("; ")}`);
      }
      if (resultBudgetApplied) {
        hudParts.push(`• Result Budget:    requested ${requestedLimit}; this call processed at most ${effectiveLimit} entries from the ${resultEntryBudget}-entry context-derived budget. Narrow with filter/query for the remainder.`);
      }
      if (refreshFailure) {
        const attempts = runtime.contextRefresh.getAttemptCount(sessionManager);
        const exhausted = attempts >= ContextRefreshRegistry.MAX_ATTEMPTS && !refreshPending;
        const refreshGuidance = exhausted
          ? RECOVERY_GUIDANCE.refreshExhausted
          : "";
        hudParts.push(`• Context Sync:     last travel refresh failed — ${refreshFailure}${refreshGuidance ? ` ${refreshGuidance}` : ""}`);
      }
      // Delivery diagnostics collapse to one line while healthy; the detailed
      // lines exist for troubleshooting, not for routine fold decisions.
      const liveSync = runtime.getLiveAgentSyncStatus(sessionManager);
      const liveSyncRecovery = getLiveAgentSyncRecoveryGuidance(liveSync);
      const packetDescription = providerDelivery.packetMessageCount != null && providerDelivery.leafId != null
        ? `${providerDelivery.packetMessageCount} message(s) at ${providerDelivery.leafId}`
        : "no packet delivered yet";
      const providerPacketLine = `• Provider Packet: ${providerDelivery.phase}; ${packetDescription}${providerDelivery.error ? `; last error: ${providerDelivery.error}` : ""}`;
      const syncHealthy = !refreshFailure && !refreshPending && providerDelivery.phase === "active" && !liveSyncRecovery;
      if (syncHealthy) {
        const healthyDetail = providerDelivery.packetMessageCount != null && providerDelivery.leafId != null
          ? `provider packet matches the active path (${packetDescription})`
          : "no travel yet; context follows the session natively";
        hudParts.push(`• Context Sync:     healthy — ${healthyDetail}`);
      } else {
        if (refreshPending) {
          const attempt = runtime.contextRefresh.getAttemptCount(sessionManager);
          const pendingPhaseByStatus: Partial<Record<ProviderDeliveryPhase, string>> = {
            pending_tool_result: "waiting for matching persisted tool_result; current valid tool batch is preserved",
            ready: "matching receipt observed; provider Context Packet rebuild starts on this context event",
            fallback: "provider rebuild fallback is retrying from the latest persisted branch",
          };
          const pendingPhase = pendingPhaseByStatus[providerDelivery.phase]
            ?? `persistent provider packet active${runtime.contextRefresh.hasRebuilt(sessionManager) ? "" : " (travel pending)"}`;
          let retry = "";
          if (attempt > 0 && providerDelivery.phase === "active" && providerDelivery.packetMessageCount !== null) {
            retry = ` (cached retry ${attempt})`;
          } else if (attempt > 0) {
            retry = ` (retry ${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS})`;
          }
          hudParts.push(`• Context Delivery: ${pendingPhase}${retry}`);
        } else {
          hudParts.push(`• Context Delivery: ${providerDelivery.phase === "active" ? "active persisted provider context" : providerDelivery.phase}`);
        }
        hudParts.push(providerPacketLine);
        if (liveSync.status === "applied") {
          hudParts.push(`• Native Replacement: applied — ${liveSync.messageCount} message(s) at ${liveSync.leafId ?? "no leaf"}`);
        } else if (liveSyncRecovery) {
          const message = "message" in liveSync ? liveSync.message : "no adapter diagnostic";
          hudParts.push(`• Native Replacement: ${liveSync.status} — ${message}. ${liveSyncRecovery}`);
        } else {
          hudParts.push(`• Native Replacement: ${liveSync.status} — no native context swap was needed this reading`);
        }
      }
      // The raw-archive sentence teaches a thing that does not exist before
      // the first fold; showing it then reads as a dangling term. The alias
      // scan only runs for the one view whose cue needs it - every other
      // view skips the O(entries) pass entirely.
      const cue = params.view === "active"
        ? GUIDANCE_CUES.timelineActive
        : params.view === "checkpoints"
          ? (rawArchiveAliasesOnce().size > 0
              ? GUIDANCE_CUES.timelineCheckpoints
              : GUIDANCE_CUES.timelineCheckpoints.split(" Raw-archive")[0]!)
          : params.view === "search"
            ? GUIDANCE_CUES.timelineSearch
            : params.view === "node"
              ? GUIDANCE_CUES.timelineNode
              : GUIDANCE_CUES.timelineTree;
      hudParts.push(`• Guidance:        ${cue}`, "---------------------------------------------------");

      const hudOutput = hudParts.join("\n");
      const bodyOutput = lines.join("\n") || "(Root Path Only)";
      const rawOutput = `${hudOutput}\n${bodyOutput}`;
      // Search result provenance is structural: line indexes are recorded while
      // building the body, then mapped to source offsets here. Dynamic HUD text
      // may repeat an identical line but can never acquire that body span.
      const lineEndOffsets: number[] = [];
      let sourceOffset = hudOutput.length + 1;
      for (const line of lines) {
        lineEndOffsets.push(sourceOffset + line.length);
        sourceOffset += line.length + 1;
      }
      let fittedOutput: ReturnType<typeof fitTimelineOutputToBudget>;
      if (params.view === "search") {
        const receiptReserveChars = 240;
        const searchReceipt = (deliveredMatches: number): string => {
          const coverage = searchTruncationReason === null
            ? "scan completed within search budgets"
            : `search stopped at ${searchTruncationPhrase(searchTruncationReason)}`;
          const partial = searchPartialNodeCuts > 0
            ? `; ${searchPartialNodeCuts} node(s) partially searched`
            : "";
          return `Search receipt: ${coverage}${partial}; ${searchSelectedMatches} selected before output fitting; ${deliveredMatches} complete result row(s) delivered`;
        };
        const provisional = fitTimelineOutputToBudget(
          rawOutput,
          resultCharacterBudget,
          leafId,
          null,
          { line: searchReceipt(0), reserveChars: receiptReserveChars },
        );
        if (!provisional.truncated) {
          searchDisplayedMatches = searchSelectedMatches;
          fittedOutput = provisional;
        } else {
          const retainedEnd = provisional.retainedSourcePrefixChars;
          searchDisplayedMatches = searchMatchLineIndexes.reduce((count, lineIndex) => {
            const lineEnd = lineEndOffsets[lineIndex];
            return count + (lineEnd !== undefined && lineEnd <= retainedEnd ? 1 : 0);
          }, 0);
          fittedOutput = fitTimelineOutputToBudget(
            rawOutput,
            resultCharacterBudget,
            leafId,
            null,
            { line: searchReceipt(searchDisplayedMatches), reserveChars: receiptReserveChars },
          );
        }
      } else {
        fittedOutput = fitTimelineOutputToBudget(
          rawOutput,
          resultCharacterBudget,
          leafId,
          params.view === "node" ? nodeEntryId : null,
        );
      }
      return {
        content: [{ type: "text" as const, text: fittedOutput.text }],
        details: {
          contextUsageAuthority: providerTurnUsageAuthoritative ? "provider_turn_end" : "native_context",
          contextPressure: officialPressure ?? null,
          authoritativeContextPressure: authoritativePressure ?? null,
          leafId,
          nearestCheckpoint,
          stepsSinceCheckpoint,
          activePathNodes: branch.length,
          activeSummaryDepth,
          offPathSummaries: offPathSummaryCount,
          view: params.view,
          limit: requestedLimit,
          effectiveLimit,
          resultEntryBudget,
          resultBudgetApplied,
          resultCharacterBudget,
          resultCharacters: fittedOutput.text.length,
          outputTruncatedByCharacterBudget: fittedOutput.truncated,
          verbose: params.view === "active" ? params.verbose ?? false : false,
          treeTruncated,
          activeVisibleEntries: params.view === "active" ? activeVisibleEntries : null,
          activeDisplayedEntries: params.view === "active" ? activeDisplayedEntries : null,
          activeOmittedEntries: params.view === "active" ? activeOmittedEntries : null,
          checkpointsMatchingAliases: params.view === "checkpoints" ? checkpointsMatchingAliases : null,
          checkpointsDisplayedAliases: params.view === "checkpoints" ? checkpointsDisplayedAliases : null,
          checkpointsMatchingEntries: params.view === "checkpoints" ? checkpointsMatchingEntries : null,
          checkpointsDisplayedEntries: params.view === "checkpoints" ? checkpointsDisplayedEntries : null,
          checkpointAliasesOnMatchingEntries: params.view === "checkpoints" ? checkpointAliasesOnMatchingEntries : null,
          checkpointAliasNamesShown: params.view === "checkpoints" ? checkpointAliasNamesShown : null,
          checkpointsRenderAborted: params.view === "checkpoints" ? checkpointsRenderAborted : false,
          rootCandidateDisplayed: params.view === "checkpoints" ? rootCandidateDisplayed : false,
          rootCandidateEntryId: params.view === "checkpoints" ? rootCandidateEntryId : null,
          rootProjectedSummaryDepth: params.view === "checkpoints" ? rootProjectedSummaryDepth : null,
          searchSelectedMatches: params.view === "search" ? searchSelectedMatches : null,
          searchDisplayedMatches: params.view === "search" ? searchDisplayedMatches : null,
          searchTruncated: params.view === "search" ? searchTruncated : false,
          searchTruncationReason: params.view === "search" ? searchTruncationReason : null,
          searchScannedNodes: params.view === "search" ? searchScannedNodes : null,
          searchTextChars: params.view === "search" ? searchTextChars : null,
          searchNodesCutAtNodeCap: params.view === "search" ? searchNodesCutAtNodeCap : null,
          searchNodesCutAtCallBudget: params.view === "search" ? searchNodesCutAtCallBudget : null,
          searchScanBudget: params.view === "search" ? TIMELINE_SEARCH_SCAN_NODE_BUDGET : null,
          searchScope: params.view === "search" ? searchScope : null,
          searchType: params.view === "search" ? searchType : null,
          nodeRequestedTarget: params.view === "node" ? nodeRequestedTarget : null,
          nodeEntryId: params.view === "node" ? nodeEntryId : null,
          nodeLabel: params.view === "node" ? nodeLabel : null,
          nodeRole: params.view === "node" ? nodeRole : null,
          nodeOnActivePath: params.view === "node" ? nodeOnActivePath : null,
          nodeBeforeCount: params.view === "node" ? nodeBeforeCount : null,
          nodeAfterCount: params.view === "node" ? nodeAfterCount : null,
          nodeNeighborScanAborted: params.view === "node" ? nodeNeighborScanAborted : null,
          outputLines: lines.length,
          contextRefreshPending: refreshPending,
          contextRefreshFailure: refreshFailure ?? null,
          contextDeliveryPhase: deliveryPhase,
          persistentMutationApplied: providerDelivery.persistentMutationApplied,
          providerDeliveryPhase: providerDelivery.phase,
          providerPacketMessageCount: providerDelivery.packetMessageCount,
          providerPacketLeafId: providerDelivery.leafId,
          providerPacketError: providerDelivery.error,
          nativeContextReplacement: liveSync,
          nativeContextReplacementRecovery: liveSyncRecovery,
        },
      };
    },
  });
}
