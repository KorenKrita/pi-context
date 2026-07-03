import {
    type ExtensionAPI,
    type SessionManager,
    type SessionEntry,
    type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ContextUsage } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
    ACM_INTERNAL_TOOLS,
    buildLabelMaps,
    classifyStructuralMessageEffect,
    classifyTravelEffect,
    compareEntriesByTimestamp,
    entryMatchesLabelSearch,
    estimateUsageAfterMessageChange,
    estimateUsageAtTravelTarget,
    extractTextFromContent,
    findCheckpointLabelOwner,
    findInTree,
    findLastMeaningfulEntry,
    formatContextUsage,
    formatEntryLabels,
    getBuildSessionMessages,
    getEntryLabels,
    getMessageRoleLabel,
    getMeaningfulSkipReason,
    getMsgContent,
    isValidEntryId,
    pushTreeChildrenPreOrder,
    resolveTargetId,
    resolveTimelineMode,
    describeEntrySnippet,
    type LabelMaps,
    type MeaningfulResolveResult,
    type UsageLike,
} from "./lib.js";

// ── Helpers ───────────────────────────────────────────────────

function formatBackupText(
    name: string | undefined,
    entryId: string | undefined,
    resolvedFromHead: string | undefined,
): string {
    if (!name || !entryId) return "none";
    if (resolvedFromHead) return `${name}@${entryId} (resolved from HEAD ${resolvedFromHead})`;
    return `${name}@${entryId}`;
}

function isCheckpointableMessage(entry: SessionEntry): boolean {
    if (entry.type !== "message") return false;
    const role = entry.message.role;
    return role === "user" || role === "assistant";
}

function formatMeaningfulResolveSummary(result: MeaningfulResolveResult): string {
    if (!result.entryId) return "";
    const role = result.role ?? "NODE";
    const anchor = result.snippet ? `${role}: "${result.snippet}"` : role;
    if (result.skipped.length === 0) return anchor;
    const skipParts = result.skipped.slice(0, 3).map((s) => s.role ?? s.reason);
    const more = result.skipped.length > 3 ? ` +${result.skipped.length - 3} more` : "";
    return `${anchor}; skipped ${result.skipped.length} nearer HEAD (${skipParts.join(", ")}${more})`;
}

function getDisplayRole(entry: SessionEntry): string {
    if (entry.type === "message") {
        const m = entry.message;
        if (m.role === "assistant") return "AI";
        if (m.role === "user") return "USER";
        if (m.role === "bashExecution") return "BASH";
        if ((m as any).role === "custom") return "CUSTOM";
        if (m.role === "system") return "SYSTEM";
        return "TOOL";
    }
    if (entry.type === "branch_summary" || entry.type === "compaction") return "SUMMARY";
    if (entry.type === "label") return "LABEL";
    return entry.type.toUpperCase();
}

function getBranchSummaryMetaParts(entry: SessionEntry): string[] {
    if (entry.type !== "branch_summary") return [];
    return [`branchPoint: ${entry.fromId}`];
}

function buildChildIndex(tree: SessionTreeNode[]): Map<string, SessionTreeNode[]> {
    const childIndex = new Map<string, SessionTreeNode[]>();
    const stack: SessionTreeNode[] = [...tree];
    while (stack.length > 0) {
        const n = stack.pop()!;
        childIndex.set(n.entry.id, n.children ?? []);
        if (n.children?.length) for (const child of n.children) stack.push(child);
    }
    return childIndex;
}

function countOffPathForks(
    branch: SessionEntry[],
    childIndex: Map<string, SessionTreeNode[]>,
    backboneIds: Set<string>,
): number {
    let forks = 0;
    for (const entry of branch) {
        const children = childIndex.get(entry.id) ?? [];
        if (children.some(c =>
            (c.entry.type === "branch_summary" || c.entry.type === "compaction") &&
            !backboneIds.has(c.entry.id)
        )) forks++;
    }
    return forks;
}

function formatOffPathFootnotes(
    entry: SessionEntry,
    childIndex: Map<string, SessionTreeNode[]>,
    backboneIds: Set<string>,
): string[] {
    const children = childIndex.get(entry.id) ?? [];
    const offPath = children.filter(c =>
        (c.entry.type === "branch_summary" || c.entry.type === "compaction") &&
        !backboneIds.has(c.entry.id)
    );
    if (offPath.length === 0) return [];
    const footnotes: string[] = [];
    for (let i = 0; i < Math.min(offPath.length, 3); i++) {
        const e = offPath[i].entry;
        footnotes.push(`  :  [off-path] ${e.type} ${e.id}`);
    }
    if (offPath.length > 3) footnotes.push(`  :  [off-path] +${offPath.length - 3} more`);
    return footnotes;
}

interface CheckpointListing {
    entryId: string;
    label: string;
    onActivePath: boolean;
    isHead: boolean;
}

function collectCheckpointListings(
    labelMaps: LabelMaps,
    backboneIds: Set<string>,
    currentLeafId: string | null,
    searchTerm: string,
): CheckpointListing[] {
    const listings: CheckpointListing[] = [];
    for (const [label, entryId] of labelMaps.labelToEntryId) {
        if (searchTerm && !label.toLowerCase().includes(searchTerm) && !entryId.toLowerCase().includes(searchTerm)) continue;
        listings.push({
            entryId,
            label,
            onActivePath: backboneIds.has(entryId),
            isHead: entryId === currentLeafId,
        });
    }
    listings.sort((a, b) => {
        if (a.onActivePath !== b.onActivePath) return a.onActivePath ? -1 : 1;
        return a.entryId.localeCompare(b.entryId);
    });
    return listings;
}

interface TreeSearchMatch {
    node: SessionTreeNode;
    checkpointLabels: string;
    content: string;
}

function searchFullSessionTree(
    sm: SessionManager,
    tree: SessionTreeNode[],
    labelMaps: LabelMaps,
    searchTerm: string,
    searchLimit: number,
    signal?: AbortSignal,
): { matches: TreeSearchMatch[]; truncated: boolean } {
    const matched: TreeSearchMatch[] = [];
    const stack: SessionTreeNode[] = [...tree];
    let visited = 0;
    while (stack.length > 0 && matched.length < searchLimit * 2 && visited < 10000) {
        if (signal?.aborted) break;
        visited++;
        const n = stack.pop()!;
        if (n.children?.length) pushTreeChildrenPreOrder(stack, n.children);
        const checkpointLabels = formatEntryLabels(labelMaps, n.entry.id) ?? "";
        const content = getMsgContent(n.entry, sm, false);
        if (
            checkpointLabels.toLowerCase().includes(searchTerm) ||
            entryMatchesLabelSearch(labelMaps, n.entry.id, searchTerm) ||
            content.toLowerCase().includes(searchTerm) ||
            n.entry.id.toLowerCase().includes(searchTerm)
        ) {
            matched.push({ node: n, checkpointLabels, content });
        }
    }
    matched.sort((a, b) => compareEntriesByTimestamp(a.node.entry, b.node.entry));
    return { matches: matched, truncated: matched.length >= searchLimit * 2 || visited >= 10000 };
}

function renderTreeNode(
    node: SessionTreeNode,
    sm: SessionManager,
    labelMaps: LabelMaps,
    currentLeafId: string | null,
    backboneIds: Set<string>,
    depth: number,
    maxDepth: number,
    prefix: string,
    isLast: boolean,
    lines: string[],
): boolean {
    if (depth > maxDepth || lines.length >= 200) return true;
    const entry = node.entry;
    const isHead = entry.id === currentLeafId;
    const checkpointLabels = formatEntryLabels(labelMaps, entry.id);
    const role = getDisplayRole(entry);
    const metaParts: string[] = [];
    if (!backboneIds.has(entry.id)) metaParts.push("off-path");
    if (checkpointLabels) metaParts.push(`checkpoint: ${checkpointLabels}`);
    if (isHead) metaParts.push("*HEAD*");
    const content = getMsgContent(entry, sm, false).replace(/\s+/g, " ");
    const body = content.length > 50 ? content.slice(0, 50) + "..." : content;
    const connector = isLast ? "└─" : "├─";
    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
    lines.push(`${prefix}${connector} ${entry.id}${meta} [${role}] ${body}`);
    let truncated = false;
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
        if (lines.length >= 200) { truncated = true; break; }
        if (renderTreeNode(children[i], sm, labelMaps, currentLeafId, backboneIds, depth + 1, maxDepth, childPrefix, i === children.length - 1, lines))
            truncated = true;
    }
    return truncated || (depth >= maxDepth && children.length > 0);
}

// ── Post-processing: fix orphaned tool_use after travel ────────

/**
 * After branchWithSummary, the rebuilt message array may have an assistant
 * message with tool_use blocks whose tool_results are on the abandoned branch.
 * The LLM API requires every tool_use to have a corresponding tool_result in
 * the immediately following message. This function injects synthetic tool_result
 * messages for any orphaned tool_use blocks.
 */
function fixOrphanedToolUse(messages: any[]): void {
    // Pass 1: Remove orphaned toolResult messages (toolResult references a
    // toolCallId not present in the preceding assistant message's tool_use blocks).
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "toolResult") continue;
        const toolCallId = msg.toolCallId ?? msg.tool_use_id;
        if (!toolCallId) continue;

        // Walk backward to find the preceding assistant message
        let foundAssistant = false;
        for (let j = i - 1; j >= 0; j--) {
            const prev = messages[j];
            if (prev.role === "assistant" && Array.isArray(prev.content)) {
                // Check if this assistant has the matching tool_use
                const hasMatch = prev.content.some((block: any) =>
                    (block.type === "toolCall" || block.type === "tool_use") &&
                    (block.id ?? block.toolCallId) === toolCallId
                );
                if (hasMatch) {
                    foundAssistant = true;
                } else {
                    // This toolResult's tool_use is not in the preceding assistant — orphaned
                    messages.splice(i, 1);
                }
                break;
            } else if (prev.role === "toolResult") {
                // Keep scanning backward past sibling toolResults
                continue;
            } else {
                // Hit a non-assistant, non-toolResult message — orphaned
                messages.splice(i, 1);
                break;
            }
        }
        if (!foundAssistant && i === 0) {
            // No preceding assistant found at all
            messages.splice(i, 1);
        }
    }

    // Pass 2: Inject synthetic toolResults for orphaned tool_use blocks
    // (assistant has tool_use but no subsequent toolResult with matching ID).
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

        const toolUseIds: { id: string; name: string }[] = [];
        for (const block of msg.content) {
            if (block.type === "toolCall" || block.type === "tool_use") {
                const id = block.id ?? block.toolCallId;
                if (id) toolUseIds.push({ id, name: block.name ?? "unknown" });
            }
        }
        if (toolUseIds.length === 0) continue;

        // Collect resolved IDs from subsequent toolResult messages
        const resolvedIds = new Set<string>();
        for (let j = i + 1; j < messages.length; j++) {
            const tr = messages[j];
            if (tr.role === "toolResult") {
                const id = tr.toolCallId ?? tr.tool_use_id;
                if (id) resolvedIds.add(id);
            } else {
                break;
            }
        }

        const orphaned = toolUseIds.filter(t => !resolvedIds.has(t.id));
        if (orphaned.length === 0) continue;

        const synthetics = orphaned.map(t => ({
            role: "toolResult" as const,
            toolCallId: t.id,
            toolName: t.name,
            content: [{ type: "text" as const, text: "[Interrupted by context travel]" }],
            timestamp: Date.now(),
        }));

        let insertAt = i + 1;
        while (insertAt < messages.length && messages[insertAt].role === "toolResult") insertAt++;
        messages.splice(insertAt, 0, ...synthetics);
        i = insertAt + synthetics.length - 1;
    }
}

/** Append a label change to a SessionManager. ctx.sessionManager is typed
 *  as ReadonlySessionManager but is a full SessionManager at runtime;
 *  callers cast before calling. */
function appendLabel(sm: SessionManager, entryId: string, label: string): void {
    sm.appendLabelChange(entryId, label);
}

/** Set or clear entry labels via appendLabelChange. label=undefined clears
 *  all aliases on the node — only safe when that entry had no prior labels. */
function setEntryLabel(sm: SessionManager, entryId: string, label: string | undefined): void {
    sm.appendLabelChange(entryId, label);
}

// ── Extension factory ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const acmToolNames = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);
    pi.on("before_provider_request", (event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== "object") return undefined;
        const record = payload as Record<string, unknown>;
        if (!Array.isArray(record.tools)) return undefined;

        let changed = false;
        const tools = record.tools.map((tool) => {
            if (!tool || typeof tool !== "object") return tool;
            const toolRecord = tool as Record<string, unknown>;

            if (toolRecord.type === "function" && typeof toolRecord.name === "string" && acmToolNames.has(toolRecord.name)) {
                changed = true;
                return { ...toolRecord, strict: false };
            }

            const fn = toolRecord.function;
            if (toolRecord.type === "function" && fn && typeof fn === "object") {
                const fnRecord = fn as Record<string, unknown>;
                if (typeof fnRecord.name === "string" && acmToolNames.has(fnRecord.name)) {
                    changed = true;
                    return { ...toolRecord, function: { ...fnRecord, strict: false } };
                }
            }

            return tool;
        });

        if (!changed) return undefined;
        return { ...record, tools };
    });

    // Simple module-level flag — WeakSet/WeakMap doesn't work because
    // ctx.sessionManager may be a different object reference across events/tools.
    let refreshPending = false;
    let refreshAttempts = 0;
    let refreshFailure: string | null = null;
    let refreshTargetLeafId: string | null = null;
    const MAX_REFRESH_ATTEMPTS = 3;
    // ── Accurate token cache (fixes HUD lag after travel) ──────
    // getContextUsage() reads agent.state.messages (stale after travel).
    // turn_end gives us the real promptTokens from each LLM response.
    // We cache it and use it in the timeline HUD instead of the stale value.
    let cachedUsage: UsageLike | null = null;
    let hasRebuilt = false;

    // ── Tool: acm_checkpoint ───────────────────────────────────
    const CheckpointParams = Type.Object({
        name: Type.String({ description: "Unique semantic anchor name encoding task+phase. Suffix carries meaning: '<name>-start' = future fold target (you will travel back here when the phase ends), '<name>-done' = recovery bookmark on finished work (never a fold target). E.g. parser-fix-start, timeout-investigation-start, cache-migration-done. Avoid generic names like start, checkpoint-1. Only letters, digits, hyphens, underscores, and dots. Max 64 chars." }),
        target: Type.Optional(Type.String({ description: "History node ID or checkpoint name to label. Defaults to current meaningful position near HEAD." })),
    });

    pi.registerTool({
        name: "acm_checkpoint",
        label: "ACM Checkpoint",
        description: "Create a named anchor on a conversation history node. Zero cost: no branch, no summary, no context change — just a label you can travel back to later. Call at every one of these events, without being asked: task start, each new user request, before each phase's first action ('<phase>-start' — a promise to fold back there when the phase ends), before risky steps, after milestones ('<milestone>-done' — a recovery bookmark, never a fold target). When unsure, checkpoint — it is free. Names must be unique across the session tree; the same node may hold multiple aliases. The result reports current context usage and a fold preview showing what traveling back to the previous anchor would leave — react to it.",
        parameters: CheckpointParams,
        async execute(_id, rawParams: Static<typeof CheckpointParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            const sm = ctx.sessionManager as SessionManager;
            const tree = sm.getTree();
            const labelMaps = buildLabelMaps(sm.getEntries());
            const branch = sm.getBranch();
            const branchIds = new Set(branch.map((e: SessionEntry) => e.id));

            let id: string;
            let autoResolved: MeaningfulResolveResult | undefined;

            if (params.target) {
                const resolved = resolveTargetId(sm, tree, params.target, branchIds, labelMaps);
                id = resolved.id;
                if (!isValidEntryId(id)) {
                    return { content: [{ type: "text", text: "Error: Cannot checkpoint — session tree is empty." }], details: {} };
                }
                const targetEntry = findInTree(tree, (n) => n.entry.id === id)?.entry;
                if (!targetEntry) {
                    return { content: [{ type: "text", text: `Error: Target '${params.target}' not found. Use acm_timeline to see available labels and node IDs.` }], details: {} };
                }
                if (!isCheckpointableMessage(targetEntry)) {
                    ctx.ui.notify(`Warning: target '${params.target}' (${id}) is not a USER/AI node. Travel semantics may be unintuitive.`, "warning");
                }
            } else {
                autoResolved = findLastMeaningfulEntry(branch, sm, signal);
                id = autoResolved.entryId ?? "";
            }

            if (signal?.aborted || autoResolved?.aborted) {
                return { content: [{ type: "text", text: "acm_checkpoint aborted." }], details: {} };
            }
            if (!id) {
                return { content: [{ type: "text", text: "No meaningful entry to checkpoint. Specify a target explicitly." }], details: {} };
            }

            const existingOwner = labelMaps.labelToEntryId.get(params.name);
            if (existingOwner && existingOwner !== id) {
                const onPath = branchIds.has(existingOwner) ? "on-path" : "off-path";
                return { content: [{ type: "text", text: `Error: Checkpoint '${params.name}' already exists at ${existingOwner} (${onPath}). Use a different name.` }], details: {} };
            }

            const priorLabels = getEntryLabels(labelMaps, id);
            if (priorLabels.includes(params.name)) {
                return { content: [{ type: "text", text: `Checkpoint '${params.name}' already exists at ${id}.` }], details: {} };
            }

            (sm as any).appendLabelChange(id, params.name);

            const aliasSuffix = priorLabels.length > 0 ? ` Added alias alongside: ${priorLabels.join(", ")}.` : "";

            // Push context usage plus a fold preview into every checkpoint result,
            // so the agent sees its fill level and the concrete benefit of folding
            // to the previous anchor during normal work, without calling acm_timeline.
            const usage = ctx.getContextUsage();
            const usageLike: UsageLike | undefined = usage && usage.tokens != null && usage.percent != null
                ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
                : undefined;
            const usageText = formatContextUsage(usageLike, true);
            let prevAnchorLabel: string | null = null;
            let prevAnchorEntryId: string | null = null;
            for (let i = branch.length - 1; i >= 0; i--) {
                const eid = branch[i].id;
                if (eid === id) continue;
                const labels = getEntryLabels(labelMaps, eid);
                if (labels.length > 0) {
                    prevAnchorLabel = labels[labels.length - 1];
                    prevAnchorEntryId = eid;
                    break;
                }
            }
            let foldPreview = "";
            let estimatedAtPrevAnchor: UsageLike | undefined;
            if (prevAnchorEntryId && prevAnchorLabel && usageLike) {
                const currentMessages = getBuildSessionMessages(sm);
                const targetMessages = getBuildSessionMessages(sm, prevAnchorEntryId);
                estimatedAtPrevAnchor = estimateUsageAfterMessageChange(usageLike, currentMessages, targetMessages);
                if (estimatedAtPrevAnchor) {
                    foldPreview = ` Fold preview: traveling to previous anchor '${prevAnchorLabel}' would leave ~${formatContextUsage(estimatedAtPrevAnchor, true)} est. (+summary). If the work since '${prevAnchorLabel}' is finished — conclusion written, attempt judged, item done — fold now: acm_travel({ target: "${prevAnchorLabel}", summary: <filled template> }). Skip only if the preview shows almost no saving.`;
                }
            }
            const usageSuffix = ` Context usage: ${usageText}.${foldPreview}`;
            return {
                content: [{
                    type: "text",
                    text: (autoResolved
                        ? `Created checkpoint '${params.name}' at ${id} (${formatMeaningfulResolveSummary(autoResolved)}).${aliasSuffix}`
                        : `Created checkpoint '${params.name}' at ${id}.${aliasSuffix}`) + usageSuffix,
                }],
                details: {
                    entryId: id,
                    label: params.name,
                    contextUsage: usageLike ?? null,
                    previousAnchor: prevAnchorLabel,
                    estimatedUsageAtPreviousAnchor: estimatedAtPrevAnchor ? formatContextUsage(estimatedAtPrevAnchor, true) : null,
                },
            };
        },
    });

    // ── Tool: acm_timeline ─────────────────────────────────────
    const TimelineParams = Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum visible entries (default 50). In full_tree mode: max depth." })),
        verbose: Type.Optional(Type.Boolean({ description: "Show all messages including internal tool traffic." })),
        full_tree: Type.Optional(Type.Boolean({ description: "Show all branches including off-path nodes. Default false." })),
        list_checkpoints: Type.Optional(Type.Boolean({ description: "List checkpoint labels with node IDs and on-path/off-path tags." })),
        search: Type.Optional(Type.String({ description: "Search the full session tree for matching checkpoint labels, node IDs, or content." })),
    });

    pi.registerTool({
        name: "acm_timeline",
        label: "ACM Timeline",
        description: "Inspect the conversation tree: active path (default), full tree, checkpoint catalog, or global search. Call when choosing a travel target, when orientation is unclear, or to check context usage — list_checkpoints estimates what every anchor would leave after a fold. On large trees prefer list_checkpoints or search over full_tree.",
        parameters: TimelineParams,
        async execute(_id, rawParams: Static<typeof TimelineParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            const sm = ctx.sessionManager as SessionManager;
            const tree = sm.getTree();
            const currentLeafId = sm.getLeafId();
            const verbose = params.verbose ?? false;
            const limit = params.limit ?? 50;
            const timelineMode = resolveTimelineMode(params);
            const searchTerm = params.search?.toLowerCase().trim() ?? "";

            const branch = sm.getBranch();
            const labelMaps = buildLabelMaps(sm.getEntries());
            const backboneIds = new Set(branch.map((e: SessionEntry) => e.id));
            const childIndex = buildChildIndex(tree);
            const offPathForks = countOffPathForks(branch, childIndex, backboneIds);
            const lines: string[] = [];
            let treeTruncated = false;

            if (timelineMode === "list_checkpoints") {
                const listings = collectCheckpointListings(labelMaps, backboneIds, currentLeafId, searchTerm);
                const listLimit = Math.min(limit > 0 ? limit : 50, 50);
                const usage = ctx.getContextUsage();
                const currentMessages = getBuildSessionMessages(sm);
                lines.push(`Checkpoints (${listings.length} total${searchTerm ? ` matching '${params.search}'` : ""}, showing up to ${listLimit}):`);
                for (const cp of listings.slice(0, listLimit)) {
                    const pathTag = cp.onActivePath ? "on-path" : "off-path";
                    const headTag = cp.isHead ? ", *HEAD*" : "";
                    const targetMessages = getBuildSessionMessages(sm, cp.entryId);
                    const estimated = usage ? estimateUsageAfterMessageChange(
                        { tokens: usage.tokens ?? 0, contextWindow: usage.contextWindow, percent: usage.percent ?? 0 },
                        currentMessages, targetMessages
                    ) : undefined;
                    const estPart = estimated ? `~${targetMessages.length} msgs, ~${formatContextUsage(estimated, true)} est. (+summary)` : `~${targetMessages.length} msgs`;
                    lines.push(`  ${cp.label} → ${cp.entryId} (${pathTag}${headTag}) ${estPart}`);
                }
                if (listings.length > listLimit) lines.push(`  ... +${listings.length - listLimit} more`);
            } else if (searchTerm && timelineMode === "search") {
                const searchLimit = Math.min(limit > 0 ? limit : 50, 50);
                const { matches, truncated } = searchFullSessionTree(sm, tree, labelMaps, searchTerm, searchLimit, signal);
                lines.push(`Found ${matches.length}${truncated ? "+" : ""} node(s) matching '${params.search}':`);
                for (const m of matches.slice(0, searchLimit)) {
                    const isHead = m.node.entry.id === currentLeafId;
                    const role = getDisplayRole(m.node.entry);
                    const normalized = m.content.replace(/\s+/g, " ");
                    const body = normalized.length > 80 ? normalized.slice(0, 80) + "..." : normalized;
                    const metaParts = [
                        m.checkpointLabels ? `checkpoint: ${m.checkpointLabels}` : null,
                        isHead ? "*HEAD*" : null,
                    ].filter(Boolean);
                    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
                    lines.push(`${isHead ? "*" : " "} ${m.node.entry.id}${meta} [${role}] ${body}`);
                }
            } else if (timelineMode === "full_tree") {
                const maxDepth = Math.min(limit > 0 ? limit : 50, 50);
                for (let i = 0; i < tree.length; i++) {
                    if (renderTreeNode(tree[i], sm, labelMaps, currentLeafId, backboneIds, 0, maxDepth, "", i === tree.length - 1, lines))
                        treeTruncated = true;
                }
                if (treeTruncated) lines.unshift("⚠ tree truncated by depth/line limit — use list_checkpoints or search to see hidden nodes");
            } else {
                // Default: active path
                if (params.search !== undefined && searchTerm === "") lines.push("query is empty; showing active path");
                const sequence: SessionEntry[] = [...branch];
                const isInteresting = (entry: SessionEntry): boolean => {
                    if (entry.id === currentLeafId) return true;
                    if (branch.length > 0 && entry.id === branch[0].id) return true;
                    if (getEntryLabels(labelMaps, entry.id).length > 0) return true;
                    if (entry.type === "label") return false;
                    if (entry.type === "branch_summary" || entry.type === "compaction") return backboneIds.has(entry.id);
                    if ((childIndex.get(entry.id) ?? []).length > 1) return true;
                    if (entry.type === "message" && entry.message.role === "user") return true;
                    return false;
                };

                const visibleIds = new Set<string>();
                for (const e of sequence) {
                    if (verbose || isInteresting(e)) visibleIds.add(e.id);
                }
                const visibleEntries = sequence.filter(e => visibleIds.has(e.id));
                if (visibleEntries.length > limit) {
                    const allowedIds = new Set(visibleEntries.slice(-limit).map(e => e.id));
                    visibleIds.clear();
                    allowedIds.forEach(id => visibleIds.add(id));
                }

                let hiddenCount = 0;
                for (const entry of sequence) {
                    if (!visibleIds.has(entry.id)) { hiddenCount++; continue; }
                    if (hiddenCount > 0) { lines.push(`  :  ... (${hiddenCount} hidden messages) ...`); hiddenCount = 0; }
                    const isHead = entry.id === currentLeafId;
                    const checkpointLabels = formatEntryLabels(labelMaps, entry.id);
                    const content = getMsgContent(entry, sm, verbose).replace(/\s+/g, " ");
                    const role = getDisplayRole(entry);
                    if (!verbose && (role === "CUSTOM" || role === "SYSTEM")) { hiddenCount++; continue; }
                    const isRoot = branch.length > 0 && entry.id === branch[0].id;
                    const metaParts = [
                        isRoot ? "ROOT" : null,
                        isHead ? "HEAD" : null,
                        checkpointLabels ? `checkpoint: ${checkpointLabels}` : null,
                        ...getBranchSummaryMetaParts(entry),
                    ].filter(Boolean);
                    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
                    const body = content.length > 100 ? content.slice(0, 100) + "..." : content;
                    const marker = isHead ? "*" : (role === "USER" ? "•" : "|");
                    lines.push(`${marker} ${entry.id}${meta} [${role}] ${body}`);
                    for (const footnote of formatOffPathFootnotes(entry, childIndex, backboneIds)) lines.push(footnote);
                }
                if (hiddenCount > 0) lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
            }

            // ── Context Dashboard HUD ──
            // Show both official (from getContextUsage, may lag after travel)
            // and last LLM prompt tokens (from turn_end, accurate but only
            // reflects the most recent API call, not the live context).
            const officialUsage = ctx.getContextUsage();
            const officialStr = officialUsage
                ? formatContextUsage({ tokens: officialUsage.tokens ?? 0, contextWindow: officialUsage.contextWindow, percent: officialUsage.percent ?? 0 }, true)
                : "Unknown";
            const lastLlmStr = cachedUsage ? formatContextUsage(cachedUsage, true) : "N/A";

            let stepsSinceCheckpoint = 0;
            let nearestCheckpointName: string | null = null;
            for (let i = branch.length - 1; i >= 0; i--) {
                const labels = getEntryLabels(labelMaps, branch[i].id);
                if (labels.length > 0) { nearestCheckpointName = labels[labels.length - 1]; break; }
                stepsSinceCheckpoint++;
            }

            const travelCue = nearestCheckpointName === null
                ? "no anchor on this path yet — checkpoint before the next phase's first action"
                : `if the work since '${nearestCheckpointName}' is finished (conclusion written, attempt judged, item done), fold now: acm_travel({ target: "${nearestCheckpointName}", summary: <filled template> })`;

            const refreshFailureMsg = refreshFailure;
            const isRefreshPending = refreshPending;
            const hudParts = [
                `[Context Dashboard]`,
                `• Context Usage:    ${officialStr} (official)`,
                `• Last LLM Prompt:  ${lastLlmStr} (turn_end)`,
                `• Active Path:      ${branch.length} node(s)`,
                `• Off-path Branches: ${offPathForks}`,
                `• Segment Size:     ${stepsSinceCheckpoint} steps since last checkpoint '${nearestCheckpointName ?? "None"}'`,
                `• Travel Cue:       ${travelCue}`,
            ];
            if (refreshFailureMsg) hudParts.push(`• Context Sync:     last travel refresh failed — ${refreshFailureMsg}`);
            else if (isRefreshPending) hudParts.push(`• Context Sync:     persistent rebuild active${hasRebuilt ? "" : " (travel pending)"}`);
            hudParts.push(`---------------------------------------------------`);

            return {
                content: [{ type: "text", text: hudParts.join("\n") + "\n" + (lines.join("\n") || "(Root Path Only)") }],
                details: { leafId: currentLeafId, nearestCheckpoint: nearestCheckpointName, stepsSinceCheckpoint, activePathNodes: branch.length, offPathBranches: offPathForks },
            };
        },
    });

    // ── Tool: acm_travel ───────────────────────────────────────
    const TravelParams = Type.Object({
        target: Type.String({ description: "Checkpoint name, history node ID, or 'root'. Use acm_timeline with full_tree or search to see all available targets." }),
        summary: Type.String({ description: "Handoff summary — your only memory after the travel. Fill every slot, write 'none' rather than dropping one: Task (goal; quote a triggering new user request verbatim), Done (conclusions with key numbers/errors/IDs), Files/External (disk/process/remote side effects — travel does NOT undo them), Do not repeat (judged dead ends), Recover raw via (backup or checkpoint name on the path being left), NEXT (the single action to take after landing). Pointers over dumps. Max 10000 chars." }),
        backupCurrentHeadAs: Type.Optional(Type.String({ description: "Optional checkpoint name for the current HEAD before traveling. Recovery pointer only; summary must still be self-contained. Not the travel target." })),
    });

    pi.registerTool({
        name: "acm_travel",
        label: "ACM Travel",
        description: "Travel on the conversation timeline to any checkpoint or node (name, node ID, or 'root'). The target becomes the branch point; your summary replaces only the path after it. Folding is the DEFAULT action at these moments — call without being asked: (1) a phase produced its conclusion and the next step acts on it (fold before the next phase's first action, do not wait for a new user message); (2) an attempt failed and you switch approach; (3) a batch item finished and more remain; (4) a new user message starts work unrelated to a finished task (fold first, quote the new request verbatim in the summary). Skip only when the fold preview shows almost no saving. Folding is safe: the old path is preserved off-path forever and forward travel recovers it. Context may shrink (earlier anchor) or grow (later/off-path anchor restoring raw history). Changes conversation history only — not disk files or external systems.",
        parameters: TravelParams,
        async execute(_id, rawParams: Static<typeof TravelParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            const sm = ctx.sessionManager as SessionManager;
            const tree = sm.getTree();
            const branch = sm.getBranch();
            const labelMaps = buildLabelMaps(sm.getEntries());
            const branchIds = new Set(branch.map((e: SessionEntry) => e.id));
            const resolved = resolveTargetId(sm, tree, params.target, branchIds, labelMaps);
            const tid = resolved.id;

            if (params.target.toLowerCase() === "root" && !isValidEntryId(tid)) {
                return { content: [{ type: "text", text: "Error: Cannot travel to root — session tree is empty." }], details: {} };
            }
            if (!findInTree(tree, (n) => n.entry.id === tid)) {
                return { content: [{ type: "text", text: `Error: Target '${params.target}' not found. Use acm_timeline to see available targets.` }], details: {} };
            }
            const currentLeaf = sm.getLeafId();
            if (!currentLeaf) {
                return { content: [{ type: "text", text: "Error: No active leaf. Cannot travel." }], details: {} };
            }
            if (currentLeaf === tid) {
                return { content: [{ type: "text", text: `Already at target ${tid}.` }], details: {} };
            }
            if (signal?.aborted) {
                return { content: [{ type: "text", text: "acm_travel aborted." }], details: {} };
            }

            const originId = currentLeaf;
            const originLabel = formatEntryLabels(labelMaps, originId);
            const usage = ctx.getContextUsage();
            const usageLike: UsageLike | undefined = usage && usage.tokens != null && usage.percent != null
                ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
                : undefined;
            const usageBeforeText = formatContextUsage(usageLike, true);
            const currentMessages = getBuildSessionMessages(sm);
            const targetMessages = getBuildSessionMessages(sm, tid);
            const estimatedUsagePreview = estimateUsageAtTravelTarget(
                usageLike,
                currentMessages,
                targetMessages,
                params.summary,
            );
            const estimatedPreviewText = formatContextUsage(estimatedUsagePreview, true);
            const messagesBefore = currentMessages.length;

            // Backup current HEAD
            let backupEntryId: string | undefined;
            let backupResolvedFromHead: string | undefined;
            let backupLabelWrittenThisCall = false;
            let backupHadNoPriorLabels = false;
            if (params.backupCurrentHeadAs) {
                const headResolve = findLastMeaningfulEntry(branch, sm, signal);
                if (headResolve.aborted) {
                    return { content: [{ type: "text", text: "acm_travel aborted during backup target resolution." }], details: { error: "aborted", target: params.target, targetId: tid } };
                }
                backupEntryId = headResolve.entryId ?? undefined;
                if (!backupEntryId) {
                    return { content: [{ type: "text", text: `Error: backupCurrentHeadAs '${params.backupCurrentHeadAs}' could not be placed — no meaningful USER/AI message found near HEAD. Travel aborted.` }], details: { error: "no_meaningful_backup_target", name: params.backupCurrentHeadAs, headId: originId } };
                }
                if (backupEntryId !== originId) {
                    backupResolvedFromHead = originId;
                    ctx.ui.notify(
                        `Note: backupCurrentHeadAs '${params.backupCurrentHeadAs}' placed on ${backupEntryId} (${headResolve.role ?? "message"}) instead of HEAD ${originId} (tool/internal traffic).`,
                        "info",
                    );
                }
                const backupOwner = findCheckpointLabelOwner(labelMaps, params.backupCurrentHeadAs, branchIds);
                if (backupOwner && backupOwner.entryId !== backupEntryId) {
                    const existing = `${backupOwner.entryId}${backupOwner.onActivePath ? " (on-path)" : " (off-path)"}`;
                    return { content: [{ type: "text", text: `Error: backupCurrentHeadAs name '${params.backupCurrentHeadAs}' already exists at ${existing}. Use a different name.` }], details: { error: "duplicate_backup_name", name: params.backupCurrentHeadAs, owner: backupOwner } };
                }
                const backupPriorLabels = getEntryLabels(labelMaps, backupEntryId);
                if (!backupPriorLabels.includes(params.backupCurrentHeadAs)) {
                    backupHadNoPriorLabels = backupPriorLabels.length === 0;
                    try {
                        setEntryLabel(sm, backupEntryId, params.backupCurrentHeadAs);
                        backupLabelWrittenThisCall = true;
                    } catch (e) {
                        return {
                            content: [{ type: "text", text: `Error: backup label '${params.backupCurrentHeadAs}' could not be set: ${e instanceof Error ? e.message : String(e)}. Travel aborted.` }],
                            details: { error: "backup_label_failed", name: params.backupCurrentHeadAs, message: e instanceof Error ? e.message : String(e) },
                        };
                    }
                }
            }

            const travelDetails = {
                originId,
                originLabel,
                target: params.target,
                targetId: tid,
                backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
            };
            let summaryEntryId: string;
            try {
                summaryEntryId = sm.branchWithSummary(tid, params.summary, travelDetails, true);
            } catch (e) {
                const errText = e instanceof Error ? e.message : String(e);
                let backupRolledBack = false;
                let backupRollbackFailed = false;
                let backupRollbackSkipped = false;
                if (backupLabelWrittenThisCall && backupEntryId) {
                    if (backupHadNoPriorLabels) {
                        try {
                            setEntryLabel(sm, backupEntryId, undefined);
                            backupRolledBack = true;
                        } catch {
                            backupRollbackFailed = true;
                        }
                    } else {
                        backupRollbackSkipped = true;
                    }
                }
                let backupNote = "";
                if (params.backupCurrentHeadAs) {
                    if (backupRollbackSkipped) {
                        backupNote = ` Backup label '${params.backupCurrentHeadAs}' remains on the tree (rollback skipped — entry had other checkpoint aliases).`;
                    } else if (backupRollbackFailed) {
                        backupNote = ` Backup label '${params.backupCurrentHeadAs}' was written but could not be rolled back.`;
                    } else if (backupRolledBack) {
                        backupNote = ` Backup label '${params.backupCurrentHeadAs}' was rolled back.`;
                    } else if (backupLabelWrittenThisCall) {
                        backupNote = ` Backup label '${params.backupCurrentHeadAs}' remains on the tree.`;
                    }
                }
                return {
                    content: [{ type: "text", text: `Error: branchWithSummary failed: ${errText}.${backupNote}` }],
                    details: {
                        error: "branch_failed",
                        backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
                        backupEntryId,
                        backupLabelWritten: backupLabelWrittenThisCall,
                        backupRolledBack,
                        backupRollbackFailed,
                        backupRollbackSkipped,
                    },
                };
            }

            // Mark context refresh pending — store the new leaf ID so the
            // context event can rebuild from it (pi moves SM leaf back to old branch
            // after appending tool results).
            refreshPending = true; refreshAttempts = 0; refreshFailure = null; hasRebuilt = false;
            refreshTargetLeafId = summaryEntryId;

            // Estimate post-travel usage
            const afterMessages = getBuildSessionMessages(sm);
            const estimatedUsageAfter = estimateUsageAfterMessageChange(usageLike, currentMessages, afterMessages);
            const estimatedUsageAfterText = formatContextUsage(estimatedUsageAfter, true);
            const estimatedEffect = classifyTravelEffect(usageLike, estimatedUsageAfter);
            const messagesAfter = afterMessages.length;
            const structuralEffect = classifyStructuralMessageEffect(messagesBefore, messagesAfter);
            const backupText = formatBackupText(params.backupCurrentHeadAs, backupEntryId, backupResolvedFromHead);
            const messageDelta = `${messagesBefore} → ${messagesAfter} (${structuralEffect})`;

            if (resolved.fromOffPath) {
                ctx.ui.notify(`Note: '${params.target}' resolved from an off-path branch.`, "info");
            }

            return {
                content: [{
                    type: "text",
                    text: [
                        `Travel complete. target=${params.target} (${tid}); backupCurrentHeadAs=${backupText}; context ${usageBeforeText} → ${estimatedUsageAfterText} est. (estimatedEffect=${estimatedEffect}, structuralEffect=${structuralEffect}); sessionMessages=${messageDelta}; summaryEntryId=${summaryEntryId}.`,
                        "Context rebuild is now persistent: every subsequent LLM turn is rebuilt from the new branch until the next travel or session reload. Run acm_timeline if official token % or sync status is unclear.",
                        estimatedUsagePreview
                            ? `Pre-travel preview was ${estimatedPreviewText} est. — compare with post-travel estimate above.`
                            : null,
                        "Estimates use buildSessionContext + token model; official % confirms on the next LLM context event or acm_timeline.",
                        "Note: the branch summary entry is appended synchronously and may appear before this tool call in the session log.",
                        "Execute the summary's NEXT step and checkpoint the new phase ('<phase>-start') as you proceed.",
                    ].filter((line): line is string => line !== null).join("\n"),
                }],
                details: {
                    target: params.target, targetId: tid, originId, originLabel,
                    hasBackup: !!params.backupCurrentHeadAs,
                    backupCurrentHeadAs: params.backupCurrentHeadAs ?? null, backupEntryId,
                    backupResolvedFromHead,
                    usageBefore: usageBeforeText,
                    usageAfter: "pending_next_context_event",
                    estimatedUsagePreview: estimatedPreviewText,
                    estimatedUsageAfter: estimatedUsageAfterText,
                    estimatedEffect,
                    structuralMessagesBefore: messagesBefore,
                    structuralMessagesAfter: messagesAfter,
                    structuralEffect,
                    sessionMessages: messageDelta,
                    messagesBefore,
                    messagesAfter,
                    summaryEntryId,
                    contextRefreshPending: true, fromOffPath: resolved.fromOffPath,
                },
            };
        },
    });

    // ── Event: context → persistent message override after travel ──
    // Pi's context event return value only affects ONE LLM call. On next turn,
    // pi rebuilds from its internal state. So we keep overriding every turn
    // until a new session or reload resets the flag.
    pi.on("context", (event, ctx) => {
        if (!refreshPending) return;

        const sm = ctx.sessionManager as SessionManager;
        try {
            // Use sm.getLeafId() (current leaf, includes post-travel messages)
            // not refreshTargetLeafId (just the summary entry)
            const messages = getBuildSessionMessages(sm);
            if (messages.length === 0) {
                // Fallback: use the fixed target leaf
                const fallback = getBuildSessionMessages(sm, refreshTargetLeafId);
                if (fallback.length > 0) {
                    fixOrphanedToolUse(fallback);
                    hasRebuilt = true;
                    return { messages: fallback as typeof event.messages };
                }
                return { messages: event.messages };
            }

            fixOrphanedToolUse(messages);
            hasRebuilt = true;
            return { messages: messages as typeof event.messages };
        } catch (err) {
            // On error, pass through original messages
            return { messages: event.messages };
        }
    });

    // ── Event: turn_end → cache accurate token usage ─────────────
    // getContextUsage() reads stale agent.state.messages after travel.
    // turn_end gives us the real promptTokens from each LLM response,
    // so the timeline HUD shows accurate numbers immediately.
    pi.on("turn_end", (event, ctx) => {
        const msg = event.message;
        if (msg.role !== "assistant") return;
        const usage = msg.usage;
        if (!usage) return;
        const promptTokens = usage.input + usage.cacheRead;
        const officialUsage = ctx.getContextUsage();
        const contextWindow = officialUsage?.contextWindow;
        if (typeof contextWindow === "number" && contextWindow > 0) {
            cachedUsage = { tokens: promptTokens, contextWindow, percent: (promptTokens / contextWindow) * 100 };
        }
    });

    // ── Event: session_before_compact → auto checkpoint ──────────
    // Before compaction discards detail, checkpoint the current branch
    // so the agent can travel back to recover pre-compaction context.
    pi.on("session_before_compact", (event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        const branch = sm.getBranch();
        if (branch.length === 0) return;
        const labelMaps = buildLabelMaps(sm.getEntries());
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const checkpointName = `pre-compact-${ts}`;
        const resolve = findLastMeaningfulEntry(branch, sm, event.signal);
        if (!resolve.entryId) return;
        const priorLabels = getEntryLabels(labelMaps, resolve.entryId);
        if (priorLabels.includes(checkpointName)) return;
        appendLabel(sm, resolve.entryId, checkpointName);
    });

    // ── Event: session_compact → sync refresh state ──────────────
    // Compaction triggers replaceMessages internally, which syncs
    // agent.state.messages to the current branch. Clear refreshPending
    // since the override is no longer needed, and invalidate cachedUsage.
    pi.on("session_compact", () => {
        refreshPending = false;
        refreshAttempts = 0;
        refreshFailure = null;
        refreshTargetLeafId = null;
        cachedUsage = null;
        hasRebuilt = false;
    });

    // ── Session lifecycle: clear stale state ───────────────────
    pi.on("session_start", (_event, ctx) => {
        refreshPending = false; refreshAttempts = 0; refreshFailure = null; refreshTargetLeafId = null; cachedUsage = null; hasRebuilt = false;
    });

    pi.on("session_shutdown", (_event, ctx) => {
        refreshPending = false; refreshAttempts = 0; refreshFailure = null; refreshTargetLeafId = null; cachedUsage = null; hasRebuilt = false;
    });
}
