import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  buildLabelMaps,
  ContextRefreshRegistry,
  countActiveSummaryDepth,
  estimateUsageAfterMessageChange,
  extractTextFromContent,
  formatBoundaryTravelCue,
  formatContextUsage,
  getEntryLabel,
  optionalString,
  projectSummaryDepthAfterTravel,
  pushTreeChildrenPreOrder,
  sanitizeTerminalText,
  type LabelMaps,
} from "./lib.js";
import { collectTrustedAcmTravelTransactions, rebuildAcmContextPacket } from "./context-packet.js";
import { estimateFoldGains, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import { calculateContextUsagePressure, formatContextUsagePressure } from "./context-pressure.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime, ProviderDeliveryPhase } from "./runtime.js";
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";
import { getAvailableAdvancedGuidance, withAvailableAdvancedGuidance } from "./advanced-guidance.js";

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

function entryText(entry: SessionEntry, verbose: boolean): string {
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

function searchTree(
  tree: SessionTreeNode[],
  labelMaps: LabelMaps,
  query: string,
  limit: number,
  signal?: AbortSignal,
): { matches: SearchMatch[]; truncated: boolean } {
  const normalizedQuery = query.toLowerCase();
  const stack = [...tree].reverse();
  const matches: SearchMatch[] = [];
  let truncated = false;
  while (stack.length > 0) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }
    const node = stack.pop()!;
    const label = getEntryLabel(labelMaps, node.entry.id);
    const matched = node.entry.id.toLowerCase().includes(normalizedQuery)
      || (label !== undefined && label.toLowerCase().includes(normalizedQuery))
      || entryText(node.entry, true).toLowerCase().includes(normalizedQuery);
    if (matched) {
      if (matches.length < limit) matches.push({ entry: node.entry, label });
      else truncated = true;
    }
    pushTreeChildrenPreOrder(stack, node.children);
  }
  return { matches, truncated };
}

function renderTree(
  tree: SessionTreeNode[],
  labelMaps: LabelMaps,
  rawArchiveAliases: ReadonlySet<string>,
  leafId: string | null,
  activeIds: Set<string>,
  maxDepth: number,
  signal?: AbortSignal,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const visit = (node: SessionTreeNode, depth: number, prefix: string, last: boolean): void => {
    if (signal?.aborted || lines.length >= 200) {
      truncated = true;
      return;
    }
    const role = displayRole(node.entry);
    const labels = formatTimelineLabel(getEntryLabel(labelMaps, node.entry.id), rawArchiveAliases);
    const tags = [
      node.entry.id === leafId ? "HEAD" : null,
      activeIds.has(node.entry.id) ? "active" : "off-path",
      labels ? `checkpoint: ${labels}` : null,
    ].filter((tag): tag is string => tag !== null);
    const body = entryText(node.entry, true).replace(/\s+/g, " ").slice(0, 100);
    lines.push(`${prefix}${last ? "└─" : "├─"} ${node.entry.id} (${tags.join(", ")}) [${role}] ${body}`);
    if (depth >= maxDepth && node.children.length > 0) {
      truncated = true;
      return;
    }
    const childPrefix = `${prefix}${last ? "  " : "│ "}`;
    node.children.forEach((child, index) => visit(child, depth + 1, childPrefix, index === node.children.length - 1));
  };
  tree.forEach((root, index) => visit(root, 1, "", index === tree.length - 1));
  return { lines, truncated };
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

function timelineResultCharacterBudget(ctx: ExtensionContext): number {
  const usage = ctx.getContextUsage();
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
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const footer = `\n… [timeline output truncated at ${budget} characters; active leaf ${leafId ?? "none"}. Use a narrower filter/query or a smaller view.]`;
  const prefixLength = Math.max(0, budget - footer.length);
  return { text: `${text.slice(0, prefixLength)}${footer}`, truncated: true };
}

function countOffPathSummaries(branch: SessionEntry[], tree: SessionTreeNode[], activeIds: Set<string>): number {
  const branchIds = new Set(branch.map((entry) => entry.id));
  let count = 0;
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (branchIds.has(node.entry.id) && node.children.some((child) => !activeIds.has(child.entry.id) && child.entry.type === "branch_summary")) count++;
    stack.push(...node.children);
  }
  return count;
}

export function registerTimelineTool(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const limitSchema = Type.Optional(Type.Integer({
    minimum: 1,
    description: "Requested recent visible entries (active), checkpoint entries (checkpoints), matches (search), or traversal depth per root (tree). Default 50. Runtime applies and reports a context-derived per-call work/result budget instead of rejecting large requests.",
  }));
  const schema = Type.Object({
    view: Type.Optional(Type.Union([
      Type.Literal("active"),
      Type.Literal("checkpoints"),
      Type.Literal("search"),
      Type.Literal("tree"),
    ], { description: "Timeline view mode. Default: active." })),
    limit: limitSchema,
    verbose: Type.Optional(Type.Boolean({ description: "Show all active-path messages, including internal tool traffic and system/custom metadata. (active view only)" })),
    filter: Type.Optional(Type.String({ minLength: 1, description: "Optional non-blank checkpoint label or entry-ID filter, matched case-insensitively. (checkpoints view only)" })),
    query: Type.Optional(Type.String({ minLength: 1, description: "Full-tree query matching labels, node IDs, or rendered content case-insensitively. Required when view=search." })),
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
      const qualifiers = [`limit ${limit ?? 50}`];
      if (view === "active" && verbose) qualifiers.push("verbose");
      if (view === "checkpoints" && filter) qualifiers.push(`filter “${sanitizeTerminalText(filter)}”`);
      if (view === "search" && query) qualifiers.push(`query “${sanitizeTerminalText(query)}”`);
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
      const depth = typeof details?.activeSummaryDepth === "number" ? details.activeSummaryDepth : 0;
      const usage = details?.contextUsage && typeof details.contextUsage === "object"
        ? formatContextUsage(details.contextUsage as { tokens: number; contextWindow: number; percent: number }, true)
        : "unknown";
      let evidence: string;
      if (view === "checkpoints") {
        const hasEntryCounts = typeof details?.checkpointsDisplayedEntries === "number"
          && typeof details?.checkpointsMatchingEntries === "number";
        const shownAliases = typeof details?.checkpointsDisplayedAliases === "number" ? details.checkpointsDisplayedAliases : 0;
        const totalAliases = typeof details?.checkpointsMatchingAliases === "number" ? details.checkpointsMatchingAliases : 0;
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
        const matches = typeof details?.searchDisplayedMatches === "number" ? details.searchDisplayedMatches : 0;
        evidence = `${matches} match${matches === 1 ? "" : "es"}${details?.searchTruncated ? " · truncated" : ""}`;
      } else if (view === "tree") {
        const lines = typeof details?.outputLines === "number" ? details.outputLines : 0;
        evidence = `${lines} rendered lines${details?.treeTruncated ? " · truncated" : ""}`;
      } else {
        const nodes = typeof details?.activePathNodes === "number" ? details.activePathNodes : 0;
        const shown = typeof details?.activeDisplayedEntries === "number" ? details.activeDisplayedEntries : 0;
        const visible = typeof details?.activeVisibleEntries === "number" ? details.activeVisibleEntries : 0;
        evidence = `${nodes} active nodes · ${shown}/${visible} visible entries shown`;
      }

      const delivery = sanitizeTerminalText(typeof details?.contextDeliveryPhase === "string"
        ? details.contextDeliveryPhase
        : "active");
      const lines = [
        theme.fg("success", "✓ TIMELINE READY") + theme.fg("accent", `  ${displayView.toUpperCase()}`),
        theme.fg("muted", `  ${evidence} · summary depth ${depth}`),
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
      const params = { view, limit: limit ?? 50, verbose, filter, query } as
        | { view: "active"; limit: number; verbose?: boolean }
        | { view: "checkpoints"; limit: number; filter?: string }
        | { view: "search"; limit: number; query: string }
        | { view: "tree"; limit: number };
      if (params.view === "search" && !params.query) {
        return {
          content: [{ type: "text" as const, text: "Error: 'query' is required when view=search." }],
          details: { error: "missing_query" },
        };
      }
      const requestedLimit = params.limit;
      const resultEntryBudget = timelineResultEntryBudget(ctx);
      const effectiveLimit = Math.min(requestedLimit, resultEntryBudget);
      const resultBudgetApplied = requestedLimit > effectiveLimit;
      const resultCharacterBudget = timelineResultCharacterBudget(ctx);
      const advancedTargetPointer = getAvailableAdvancedGuidance(pi, GUIDANCE_CUES.advancedTargetPointer);
      const sessionManager = ctx.sessionManager;
      const tree = sessionManager.getTree();
      const branch = sessionManager.getBranch();
      const entries = sessionManager.getEntries();
      const leafId = sessionManager.getLeafId();
      const labelMaps = buildLabelMaps(entries);
      const activeIds = new Set(branch.map((entry) => entry.id));
      const activeSummaryDepth = countActiveSummaryDepth(branch);
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      const pathOrder = new Map(branch.map((entry, index) => [entry.id, index]));
      const rawArchiveAliases = collectRawArchiveAliases(entries, labelMaps);
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
      let rootCandidateDisplayed = false;
      let rootCandidateEntryId: string | null = null;
      let rootProjectedSummaryDepth: number | null = null;
      let searchDisplayedMatches = 0;
      let searchTruncated = false;

      if (params.view === "checkpoints") {
        const filter = params.filter?.toLowerCase() ?? "";
        const listings = collectListings(labelMaps, activeIds, leafId, filter, entriesById, pathOrder, rawArchiveAliases);
        const rootEntry = tree[0]?.entry;
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
        const usage = toUsageLike(ctx.getContextUsage());
        const currentResult = rebuildAcmContextPacket(sessionManager, leafId);
        if (!currentResult.ok) {
          return {
            content: [{ type: "text" as const, text: `Checkpoints (${listings.length} matching entries / ${checkpointsMatchingAliases} matched aliases / ${checkpointAliasesOnMatchingEntries} total aliases, 0 displayed). Current messages could not be built: ${currentResult.message}` }],
            details: { error: currentResult.error, message: currentResult.message },
          };
        }
        const matchingEntryLabel = listings.length === 1 ? "entry" : "entries";
        const displayedEntryLabel = displayedListings.length === 1 ? "entry" : "entries";
        const matchingAliasLabel = checkpointsMatchingAliases === 1 ? "alias" : "aliases";
        const aliasCountText = filter
          ? `${checkpointsMatchingAliases} matched ${matchingAliasLabel} / ${checkpointAliasesOnMatchingEntries} total aliases`
          : `${checkpointAliasesOnMatchingEntries} aliases`;
        lines.push(`Checkpoints (${listings.length} matching ${matchingEntryLabel} / ${aliasCountText}, ${displayedListings.length} ${displayedEntryLabel} displayed${filter ? ` for '${boundedTimelineValue(params.filter ?? "")}'` : ""}; requested ${requestedLimit}, effective ${effectiveLimit}). Current: ${currentResult.value.messages.length} msgs, ${formatContextUsage(usage, true)}, summary depth ${activeSummaryDepth}:`);
        const cache = new Map<string, { ok: true; messages: AgentMessage[] } | { ok: false }>();
        const projectedDepthCache = new Map<string, number>();
        if (rootEntry && rootMatchesFilter) {
          const rootResult = rebuildAcmContextPacket(sessionManager, rootEntry.id);
          const rootMessages = rootResult.ok ? rootResult.value.messages : [];
          cache.set(rootEntry.id, rootResult.ok ? { ok: true, messages: rootMessages } : { ok: false });
          rootCandidateDisplayed = true;
          rootCandidateEntryId = rootEntry.id;
          rootProjectedSummaryDepth = projectSummaryDepthAfterTravel(sessionManager.getBranch(rootEntry.id));
          projectedDepthCache.set(rootEntry.id, rootProjectedSummaryDepth);
          let estimateText = "message estimate unavailable";
          if (rootResult.ok) {
            const estimated = estimateUsageAfterMessageChange(usage, currentResult.value.messages, rootMessages);
            estimateText = estimated
              ? `~${rootMessages.length} msgs, ~${formatContextUsage(estimated, true)} est. (+summary)`
              : `~${rootMessages.length} msgs`;
          }
          const rootTopology = tree.length > 1 ? `, first of ${tree.length} top-level roots` : "";
          const rootDepthNote = activeSummaryDepth > 0 && rootProjectedSummaryDepth === 1
            ? "; projected depth is 1 rather than 0 because travel appends one new handoff"
            : "";
          lines.push(`  root → ${rootEntry.id} (structural candidate, not a checkpoint${rootTopology}) ${estimateText}; summary depth ${activeSummaryDepth} → ${rootProjectedSummaryDepth} projected${rootDepthNote}`);
        }
        for (const checkpoint of displayedListings) {
          if (signal?.aborted) break;
          let cachedTarget = cache.get(checkpoint.entryId);
          if (!cachedTarget) {
            const targetResult = rebuildAcmContextPacket(sessionManager, checkpoint.entryId);
            cachedTarget = targetResult.ok
              ? { ok: true, messages: targetResult.value.messages }
              : { ok: false };
            cache.set(checkpoint.entryId, cachedTarget);
          }
          const estimated = cachedTarget.ok
            ? estimateUsageAfterMessageChange(usage, currentResult.value.messages, cachedTarget.messages)
            : undefined;
          const estimateText = !cachedTarget.ok
            ? "message estimate unavailable"
            : estimated
              ? `~${cachedTarget.messages.length} msgs, ~${formatContextUsage(estimated, true)} est. (+summary)`
              : `~${cachedTarget.messages.length} msgs`;
          let projectedSummaryDepth = projectedDepthCache.get(checkpoint.entryId);
          if (projectedSummaryDepth === undefined) {
            projectedSummaryDepth = projectSummaryDepthAfterTravel(sessionManager.getBranch(checkpoint.entryId));
            projectedDepthCache.set(checkpoint.entryId, projectedSummaryDepth);
          }
          const rawArchiveNote = checkpoint.isRawArchive
            ? "; raw archive origin — restore/rehydrate only, not a fold/rebase base"
            : "";
          lines.push(`  ${checkpoint.entryId} (checkpoint: ${formatCheckpointLabel(checkpoint)}; ${checkpoint.onActivePath ? "on-path" : "off-path"}${checkpoint.isHead ? ", *HEAD*" : ""}${rawArchiveNote}) ${estimateText}; summary depth ${activeSummaryDepth} → ${projectedSummaryDepth} projected`);
        }
        if (listings.length > displayedListings.length) lines.push(`  ... +${listings.length - displayedListings.length} more — use a narrower filter or query`);
      } else if (params.view === "search") {
        const search = searchTree(tree, labelMaps, params.query, effectiveLimit, signal);
        searchDisplayedMatches = search.matches.length;
        searchTruncated = search.truncated;
        lines.push(
          `Search '${boundedTimelineValue(params.query)}': ${search.matches.length} displayed${search.truncated ? "; additional matches truncated" : " matching node(s)"}.`,
        );
        for (const match of search.matches) {
          const body = entryText(match.entry, true).replace(/\s+/g, " ").slice(0, 100);
          const displayLabel = formatTimelineLabel(match.label, rawArchiveAliases);
          lines.push(`  ${match.entry.id}${displayLabel ? ` (checkpoint: ${displayLabel})` : ""} [${displayRole(match.entry)}] ${body}`);
        }
        if (search.truncated) lines.push("  ... additional matches truncated");
      } else if (params.view === "tree") {
        const rendered = renderTree(tree, labelMaps, rawArchiveAliases, leafId, activeIds, effectiveLimit, signal);
        lines.push(...rendered.lines);
        treeTruncated = rendered.truncated || lines.length >= 200;
        if (treeTruncated) lines.unshift("⚠ tree truncated by depth/line limit — use view checkpoints or view search to see hidden nodes");
      } else {
        const verbose = params.verbose ?? false;
        const visible = branch.filter((entry) => visibleOnActivePath(entry, labelMaps, leafId, verbose));
        activeVisibleEntries = visible.length;
        activeDisplayedEntries = Math.min(visible.length, effectiveLimit);
        activeOmittedEntries = Math.max(0, visible.length - effectiveLimit);
        if (activeOmittedEntries > 0) lines.push(`  :  ... (${activeOmittedEntries} earlier visible entries omitted by limit) ...`);
        for (const entry of visible.slice(-effectiveLimit)) {
          const labels = formatTimelineLabel(getEntryLabel(labelMaps, entry.id), rawArchiveAliases);
          const tags = [entry === branch[0] ? "ROOT" : null, entry.id === leafId ? "HEAD" : null, labels ? `checkpoint: ${labels}` : null]
            .filter((tag): tag is string => tag !== null);
          const body = entryText(entry, verbose).replace(/\s+/g, " ").slice(0, 100);
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
      let nearestCheckpoint: string | null = null;
      for (let index = branch.length - 1; index >= 0; index--) {
        const label = getEntryLabel(labelMaps, branch[index]!.id);
        if (label !== undefined) {
          nearestCheckpoint = label;
          break;
        }
        stepsSinceCheckpoint++;
      }
      const refreshFailure = runtime.contextRefresh.getFailure(sessionManager);
      const refreshPending = runtime.contextRefresh.isPending(sessionManager);
      const deliveryPhase = runtime.getContextDeliveryPhase(sessionManager);
      const providerDelivery = runtime.getProviderDeliveryStatus(sessionManager);
      const providerEpoch = providerDelivery.persistentMutationApplied;
      const providerTurnUsageAuthoritative = providerEpoch && providerDelivery.usageObserved;
      const authoritativePressure = runtime.authoritativeContextPressure(sessionManager, officialUsage);
      // Fold projections: what a fold at each structural reference point would
      // leave, on the same working-budget yardstick the pressure line uses.
      // Facts only — whether the extraction is complete stays CORE's bar.
      let foldProjectionText = "unavailable";
      try {
        const foldBranch = branch as unknown as readonly FoldEstimateEntry[];
        const references = selectFoldReferences(foldBranch, labelMaps);
        const hudCurrent = rebuildAcmContextPacket(sessionManager);
        const estimates = authoritativePressure && hudCurrent.ok
          ? estimateFoldGains({
              usage: officialUsage,
              contextWindow: authoritativePressure.contextWindow,
              currentMessages: hudCurrent.value.messages,
              messagesAt: (id: string) => {
                const result = rebuildAcmContextPacket(sessionManager, id);
                return result.ok ? result.value.messages : undefined;
              },
            }, references)
          : { turnPercent: null, taskPercent: null };
        const segs: string[] = [];
        if (estimates.turnPercent != null && references.turn) {
          segs.push(`turn '${boundedTimelineValue(references.turn.label ?? references.turn.entryId)}' → ~${Math.floor(estimates.turnPercent)}% budget`);
        }
        if (estimates.taskPercent != null && references.task) {
          segs.push(`task '${boundedTimelineValue(references.task.label ?? references.task.entryId)}' → ~${Math.floor(estimates.taskPercent)}% budget`);
        }
        foldProjectionText = segs.length > 0 ? segs.join("; ") : "no reference point on this spine";
      } catch {
        foldProjectionText = "unavailable";
      }
      const hudParts = [
        "[Context Dashboard]",
        `• Travel Mutation:  ${providerDelivery.persistentMutationApplied ? "applied" : "none pending"}`,
        `• Context Usage:    ${formatContextUsage(officialUsage, true)} (${providerEpoch ? "native AgentSession estimate" : "official hard window"})`,
        `• ACM Pressure:     ${authoritativePressure ? formatContextUsagePressure(authoritativePressure) : "N/A"} (${providerTurnUsageAuthoritative ? "provider actual" : "native context"})`,
        `• Last LLM Prompt:  ${lastUsage ? formatContextUsage(lastUsage, true) : "N/A"} (${providerTurnUsageAuthoritative ? "provider actual turn_end" : "turn_end"})`,
        `• Active Path:      ${branch.length} node(s) — LLM context follows this spine`,
        `• Summary Depth:    ${activeSummaryDepth} active handoff summary layer(s) on the current spine`,
        `• Off-path Summaries: ${countOffPathSummaries(branch, tree, activeIds)} branch point(s) with abandoned summaries`,
        `• Recovery Distance: ${stepsSinceCheckpoint} step(s) since last save point '${nearestCheckpoint ? boundedTimelineValue(nearestCheckpoint) : "None"}'`,
        `• Fold Projection:  ${foldProjectionText}`,
        `• ACM Judgment:     ${activeSummaryDepth > 0
          ? `${GUIDANCE_CUES.rebaseCheck}${advancedTargetPointer ? ` ${advancedTargetPointer}` : ""}`
          : formatBoundaryTravelCue(nearestCheckpoint ? boundedTimelineValue(nearestCheckpoint) : null, advancedTargetPointer)}`,
      ];
      if (resultBudgetApplied) {
        hudParts.push(`• Result Budget:    requested ${requestedLimit}; this call processed at most ${effectiveLimit} entries from the ${resultEntryBudget}-entry context-derived budget. Narrow with filter/query for the remainder.`);
      }
      if (refreshFailure) {
        const attempts = runtime.contextRefresh.getAttemptCount(sessionManager);
        const exhausted = attempts >= ContextRefreshRegistry.MAX_ATTEMPTS && !refreshPending;
        const refreshGuidance = exhausted
          ? withAvailableAdvancedGuidance(pi, RECOVERY_GUIDANCE.refreshExhausted, GUIDANCE_CUES.advancedExceptionalPointer)
          : "";
        hudParts.push(`• Context Sync:     last travel refresh failed — ${refreshFailure}${refreshGuidance ? ` ${refreshGuidance}` : ""}`);
      }
      // Failure evidence and the currently deliverable provider state are
      // complementary; show both while a bounded retry remains pending.
      const providerPacketLine = `• Provider Packet: ${providerDelivery.phase}; ${providerDelivery.packetMessageCount ?? "none"} message(s) at ${providerDelivery.leafId ?? "no verified leaf"}${providerDelivery.error ? `; last error: ${providerDelivery.error}` : ""}`;
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
        hudParts.push(providerPacketLine);
      } else {
        hudParts.push(`• Context Delivery: ${providerDelivery.phase === "active" ? "active persisted provider context" : providerDelivery.phase}`);
        hudParts.push(providerPacketLine);
      }
      const liveSync = runtime.getLiveAgentSyncStatus(sessionManager);
      const liveSyncRecovery = getLiveAgentSyncRecoveryGuidance(liveSync);
      if (liveSync.status === "applied") {
        hudParts.push(`• Native Replacement: applied — ${liveSync.messageCount} message(s) at ${liveSync.leafId ?? "no leaf"}`);
      } else if (liveSyncRecovery) {
        const message = "message" in liveSync ? liveSync.message : "no adapter diagnostic";
        hudParts.push(`• Native Replacement: ${liveSync.status} — ${message}. ${liveSyncRecovery}`);
      } else {
        hudParts.push(`• Native Replacement: ${liveSync.status}`);
      }
      const cue = params.view === "active"
        ? GUIDANCE_CUES.timelineActive
        : params.view === "checkpoints"
          ? GUIDANCE_CUES.timelineCheckpoints
          : params.view === "search"
            ? GUIDANCE_CUES.timelineSearch
            : GUIDANCE_CUES.timelineTree;
      hudParts.push(`• Guidance:        ${cue}`, "---------------------------------------------------");

      const rawOutput = `${hudParts.join("\n")}\n${lines.join("\n") || "(Root Path Only)"}`;
      const fittedOutput = fitTimelineOutputToBudget(rawOutput, resultCharacterBudget, leafId);
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
          offPathSummaries: countOffPathSummaries(branch, tree, activeIds),
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
          rootCandidateDisplayed: params.view === "checkpoints" ? rootCandidateDisplayed : false,
          rootCandidateEntryId: params.view === "checkpoints" ? rootCandidateEntryId : null,
          rootProjectedSummaryDepth: params.view === "checkpoints" ? rootProjectedSummaryDepth : null,
          searchDisplayedMatches: params.view === "search" ? searchDisplayedMatches : null,
          searchTruncated: params.view === "search" ? searchTruncated : false,
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
