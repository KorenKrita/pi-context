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
import { calculateContextUsagePressure, foldProjectionScaleName, formatContextUsagePressure, type ContextUsagePressure } from "./context-pressure.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime, ProviderDeliveryPhase } from "./runtime.js";
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

// ACM's own tool results echo every checkpoint name and dashboard line, so
// they match almost any query about past work — self-pollution, not recall.
// They stay searchable only when the entry itself carries a checkpoint label.
function isAcmToolEcho(entry: SessionEntry): boolean {
  return entry.type === "message"
    && entry.message.role === "toolResult"
    && typeof entry.message.toolName === "string"
    && entry.message.toolName.startsWith("acm_");
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
    const matched = (label === undefined && isAcmToolEcho(node.entry))
      ? false
      : node.entry.id.toLowerCase().includes(normalizedQuery)
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

/** Shorten a rendered body to one line, marking real truncation honestly. */
function snippet(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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
    description: "Requested maximum entries; output budgets may return fewer. Default 50.",
  }));
  const schema = Type.Object({
    view: Type.Optional(Type.Union([
      Type.Literal("active"),
      Type.Literal("checkpoints"),
      Type.Literal("search"),
      Type.Literal("tree"),
    ], { description: "Timeline view mode. Default: active." })),
    limit: limitSchema,
    verbose: Type.Optional(Type.Boolean({ description: "Active view only: show all messages, including internal tool traffic and metadata." })),
    filter: Type.Optional(Type.String({ minLength: 1, description: "Narrow the checkpoints view by label or node-ID substring (case-insensitive)." })),
    query: Type.Optional(Type.String({ minLength: 1, description: "Search text; matches labels, node IDs, and content across the whole tree. Required for view=search." })),
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
        evidence = `${matches} match${matches === 1 ? "" : "es"}${details?.searchTruncated ? " · truncated" : ""}`;
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
      const params = { view, limit: limit ?? 50, verbose, filter, query } as
        | { view: "active"; limit: number; verbose?: boolean }
        | { view: "checkpoints"; limit: number; filter?: string }
        | { view: "search"; limit: number; query: string }
        | { view: "tree"; limit: number; verbose?: boolean };
      // Silently ignored parameters produce false negatives (a filter on the
      // search view looks like an empty result). Name what was ignored.
      const ignoredParams: string[] = [];
      if (filter && view !== "checkpoints") ignoredParams.push(`'filter' (only applies to view=checkpoints)`);
      if (query && view !== "search") ignoredParams.push(`'query' (only applies to view=search)`);
      if (verbose !== undefined && view !== "active" && view !== "tree") ignoredParams.push(`'verbose' (only applies to view=active and view=tree)`);
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
      const budgetAuthority = runtime.authoritativeContextPressure(ctx.sessionManager, toUsageLike(ctx.getContextUsage()));
      const resultCharacterBudget = timelineResultCharacterBudget(
        ctx,
        budgetAuthority ? { tokens: budgetAuthority.tokens, contextWindow: budgetAuthority.contextWindow } : undefined,
      );
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
        // Same pressure authority as the gauge and HUD: during a provider
        // epoch the host estimate still describes the pre-travel branch, so
        // Current usage and every target estimate below must read the
        // authoritative tokens — mixing them with the HUD's authoritative
        // line in one result would be a visible self-contradiction.
        const checkpointsPressure = runtime.authoritativeContextPressure(sessionManager, toUsageLike(ctx.getContextUsage()));
        const usage = checkpointsPressure
          ? { tokens: checkpointsPressure.tokens, contextWindow: checkpointsPressure.contextWindow, percent: checkpointsPressure.usagePercent }
          : undefined;
        const currentResult = rebuildAcmContextPacket(sessionManager, leafId);
        if (!currentResult.ok) {
          return {
            content: [{ type: "text" as const, text: `Checkpoints (${listings.length} matching entries / ${checkpointsMatchingAliases} matched aliases / ${checkpointAliasesOnMatchingEntries} total aliases, 0 displayed). Current messages could not be built: ${currentResult.message}` }],
            details: { error: currentResult.error, message: currentResult.message },
          };
        }
        // Header grammar: entry counts only when they carry information.
        // An unfiltered list that fits needs one number, not five.
        const currentSummary = `Current position: ${currentResult.value.messages.length} msg(s) in context, ${formatContextUsage(usage)}, handoff layers ${activeSummaryDepth}.`;
        if (listings.length === 0 && !rootMatchesFilter) {
          lines.push(filter ? `No checkpoints match '${boundedTimelineValue(params.filter ?? "")}'. ${currentSummary}` : `No checkpoints yet. ${currentSummary}`);
        } else {
          const savePointCount = `${listings.length} save point${listings.length === 1 ? "" : "s"}`;
          const shownNote = displayedListings.length < listings.length
            ? `, showing ${displayedListings.length} (limit ${effectiveLimit})`
            : "";
          const filterNote = filter ? ` matching '${boundedTimelineValue(params.filter ?? "")}'` : "";
          lines.push(`Checkpoints: ${savePointCount}${filterNote}${shownNote}. ${currentSummary} Each line projects the state after folding to that target:`);
        }
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
              ? `~${rootMessages.length} msg(s) kept, ~${formatContextUsage(estimated)} est. (incl. the new handoff)`
              : `~${rootMessages.length} msg(s) kept`;
          }
          const rootTopology = tree.length > 1 ? `, first of ${tree.length} top-level roots` : "";
          const rootDepthNote = activeSummaryDepth > 0 && rootProjectedSummaryDepth === 1
            ? "; projected depth is 1 rather than 0 because travel appends one new handoff"
            : "";
          lines.push(`  root → ${rootEntry.id} (session start — not a named checkpoint, but a valid travel target${rootTopology}) ${estimateText}; handoff layers ${activeSummaryDepth} → ${rootProjectedSummaryDepth} projected${rootDepthNote}`);
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
              ? `~${cachedTarget.messages.length} msg(s) kept, ~${formatContextUsage(estimated)} est. (incl. the new handoff)`
              : `~${cachedTarget.messages.length} msg(s) kept`;
          let projectedSummaryDepth = projectedDepthCache.get(checkpoint.entryId);
          if (projectedSummaryDepth === undefined) {
            projectedSummaryDepth = projectSummaryDepthAfterTravel(sessionManager.getBranch(checkpoint.entryId));
            projectedDepthCache.set(checkpoint.entryId, projectedSummaryDepth);
          }
          const rawArchiveNote = checkpoint.isRawArchive
            ? "; raw archive — restores pre-fold history; fold targets are the entries before the folded material"
            : "";
          lines.push(`  ${checkpoint.entryId} (checkpoint: ${formatCheckpointLabel(checkpoint)}; ${checkpoint.onActivePath ? "on-path" : "off-path"}${checkpoint.isHead ? ", *HEAD*" : ""}${rawArchiveNote}) ${estimateText}; handoff layers ${activeSummaryDepth} → ${projectedSummaryDepth} projected`);
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
          const body = snippet(entryText(match.entry, true));
          const displayLabel = formatTimelineLabel(match.label, rawArchiveAliases);
          lines.push(`  ${match.entry.id}${displayLabel ? ` (checkpoint: ${displayLabel})` : ""} [${displayRole(match.entry)}] ${body}`);
        }
        if (search.truncated) lines.push("  ... additional matches truncated");
      } else if (params.view === "tree") {
        const treeVerbose = params.verbose ?? false;
        const rendered = renderTree(tree, labelMaps, rawArchiveAliases, leafId, activeIds, effectiveLimit, treeVerbose, signal);
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
        lines.push(`Active path: ${visible.length} visible entr${visible.length === 1 ? "y" : "ies"}, showing the latest ${Math.min(visible.length, effectiveLimit)}. Markers: * = current position (HEAD), • = user message, | = other entries.`);
        if (activeOmittedEntries > 0) lines.push(`  :  ... (${activeOmittedEntries} earlier visible entries omitted by limit) ...`);
        for (const entry of visible.slice(-effectiveLimit)) {
          const labels = formatTimelineLabel(getEntryLabel(labelMaps, entry.id), rawArchiveAliases);
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
      const providerTurnUsageAuthoritative = runtime.isProviderUsageAuthoritative(sessionManager);
      const authoritativePressure = runtime.authoritativeContextPressure(sessionManager, officialUsage);
      // Fold projections: what a fold at each structural reference point would
      // leave, on the same working-budget yardstick the pressure line uses.
      // Numerator and denominator both come from the authoritative pressure —
      // mixing the official numerator with the authoritative denominator reads
      // as a contradiction the moment the two sources diverge (same pattern as
      // the gauge adapter in runtime-lifecycle). Facts only — whether the
      // extraction is complete stays CORE's bar.
      let foldProjectionText = "unavailable";
      try {
        const foldBranch = branch as unknown as readonly FoldEstimateEntry[];
        const references = selectFoldReferences(foldBranch, labelMaps);
        const hudCurrent = rebuildAcmContextPacket(sessionManager);
        const estimates = authoritativePressure && hudCurrent.ok
          ? estimateFoldGains({
              usage: {
                tokens: authoritativePressure.tokens,
                contextWindow: authoritativePressure.contextWindow,
                percent: 0,
              },
              workingBudgetTokens: authoritativePressure.workingBudgetTokens,
              currentMessages: hudCurrent.value.messages,
              messagesAt: (id: string) => {
                const result = rebuildAcmContextPacket(sessionManager, id);
                return result.ok ? result.value.messages : undefined;
              },
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
        ? `• Context Usage:    ${formatContextUsagePressure(authoritativePressure)} (${providerTurnUsageAuthoritative ? "provider actual" : "native estimate"})`
        : `• Context Usage:    ${formatContextUsage(officialUsage)} (native estimate)`;
      const usageLines: string[] = [primaryUsageLine];
      if (authoritativePressure && officialUsage && Math.abs(officialUsage.tokens - authoritativePressure.tokens) > 1024) {
        usageLines.push(`• Native Estimate:  ${formatContextUsage(officialUsage)} (host estimate; may lag right after a travel)`);
      }
      if (lastUsage && authoritativePressure && Math.abs(lastUsage.tokens - authoritativePressure.tokens) > 1024) {
        usageLines.push(`• Last Turn End:    ${formatContextUsage(lastUsage)} (recorded at the end of the previous turn)`);
      }
      const offPathHandoffs = countOffPathSummaries(branch, tree, activeIds);
      const hudParts = [
        "[Context Dashboard]",
        ...(providerDelivery.persistentMutationApplied
          ? ["• Travel Mutation:  applied — the provider context was rewritten by a travel this session"]
          : []),
        ...usageLines,
        `• Active Path:      ${branch.length} node(s) — the LLM context follows this path`,
        `• Handoff Layers:   ${activeSummaryDepth} handoff layer(s) on the current path`,
        ...(offPathHandoffs > 0
          ? [`• Off-path Handoffs: ${offPathHandoffs} branch point(s) with archived handoffs`]
          : []),
        nearestCheckpoint
          ? `• Last Save Point:  '${boundedTimelineValue(nearestCheckpoint)}' — ${stepsSinceCheckpoint} node(s) back on this path`
          : `• Last Save Point:  none on this path yet (${stepsSinceCheckpoint} node(s) since the path began)`,
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
          ? `persisted provider context active (${packetDescription})`
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
