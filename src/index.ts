import {
    type ExtensionAPI,
    type SessionManager,
    type SessionEntry,
    type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
    ContextRefreshRegistry,
    buildLabelMaps,
    classifyStructuralMessageEffect,
    classifyTravelEffect,
    compareEntriesByTimestamp,
    entryMatchesLabelSearch,
    estimateUsageAfterMessageChange,
    estimateUsageAtTravelTarget,
    findCheckpointLabelOwner,
    findInTree,
    findLastMeaningfulEntry,
    formatBoundaryTravelCue,
    formatContextUsage,
    formatEntryLabels,
    formatFoldCandidatePreview,
    getBuildSessionMessages,
    getBuildSessionMessagesFromEntries,
    getEntryLabels,
    getMsgContent,
    isValidEntryId,
    pushTreeChildrenPreOrder,
    resolveTargetId,
    resolveTimelineMode,
    type LabelMaps,
    type MeaningfulResolveResult,
    HANDOFF_SLOT_HINT,
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
        if ((m.role as string) === "system") return "SYSTEM";
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
    pathOrder: number;
    timestamp: string;
}

function collectCheckpointListings(
    labelMaps: LabelMaps,
    backboneIds: Set<string>,
    currentLeafId: string | null,
    searchTerm: string,
    entriesById: Map<string, SessionEntry>,
    pathOrderById: Map<string, number>,
): CheckpointListing[] {
    const listings: CheckpointListing[] = [];
    for (const [label, entryId] of labelMaps.labelToEntryId) {
        if (searchTerm && !label.toLowerCase().includes(searchTerm) && !entryId.toLowerCase().includes(searchTerm)) continue;
        listings.push({
            entryId,
            label,
            onActivePath: backboneIds.has(entryId),
            isHead: entryId === currentLeafId,
            pathOrder: pathOrderById.get(entryId) ?? Number.MAX_SAFE_INTEGER,
            timestamp: entriesById.get(entryId)?.timestamp ?? "",
        });
    }
    listings.sort((a, b) => {
        if (a.onActivePath !== b.onActivePath) return a.onActivePath ? -1 : 1;
        if (a.onActivePath && a.pathOrder !== b.pathOrder) return a.pathOrder - b.pathOrder;
        const timeOrder = a.timestamp.localeCompare(b.timestamp);
        if (timeOrder !== 0) return timeOrder;
        const entryOrder = a.entryId.localeCompare(b.entryId);
        return entryOrder !== 0 ? entryOrder : a.label.localeCompare(b.label);
    });
    return listings;
}

interface TreeSearchMatch {
    node: SessionTreeNode;
    checkpointLabels: string;
    preview: string;
}

function createLiteralSearchPattern(searchTerm: string): RegExp {
    return new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** Match message content without first concatenating and lower-casing a large
 * tool result or assistant payload. Full display text is built only for hits. */
function entryContentMatchesSearch(entry: SessionEntry, pattern: RegExp): boolean {
    if (entry.type === "branch_summary" || entry.type === "compaction") {
        return pattern.test(entry.summary ?? "");
    }
    if (entry.type === "label") return pattern.test(`checkpoint: ${entry.label ?? ""}`);
    if (entry.type !== "message") return false;

    const message = entry.message as any;
    if (message.role === "toolResult") {
        if (pattern.test(message.toolName ?? "")) return true;
        const details = message.details as Record<string, unknown> | undefined;
        if (typeof details?.path === "string" && pattern.test(details.path)) return true;
        return Array.isArray(message.content) && message.content.some(
            (part: any) => part?.type === "text" && typeof part.text === "string" && pattern.test(part.text),
        );
    }
    if (message.role === "bashExecution") return pattern.test(`[Bash] ${message.command ?? ""}`);
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (typeof message.content === "string") return pattern.test(message.content);
    if (!Array.isArray(message.content)) return false;

    return message.content.some((part: any) => {
        if (part?.type === "text" && typeof part.text === "string") return pattern.test(part.text);
        if (message.role === "assistant" && (part?.type === "toolCall" || part?.type === "tool_use")) {
            const id = part.id ?? part.toolCallId;
            const serialized = JSON.stringify(part);
            const callText = `call: ${part.name ?? "unknown"}(${JSON.stringify(part.arguments ?? {})}) ${id ?? ""}`;
            return pattern.test(callText) || pattern.test(serialized);
        }
        return false;
    });
}

function searchFullSessionTree(
    tree: SessionTreeNode[],
    labelMaps: LabelMaps,
    searchTerm: string,
    searchLimit: number,
    signal?: AbortSignal,
): { matches: TreeSearchMatch[]; truncated: boolean } {
    const matched: TreeSearchMatch[] = [];
    const stack: SessionTreeNode[] = [...tree];
    const contentPattern = createLiteralSearchPattern(searchTerm);
    let visited = 0;
    while (stack.length > 0 && matched.length < searchLimit * 2 && visited < 10000) {
        if (signal?.aborted) break;
        visited++;
        const n = stack.pop()!;
        if (n.children?.length) pushTreeChildrenPreOrder(stack, n.children);
        const checkpointLabels = formatEntryLabels(labelMaps, n.entry.id) ?? "";
        const cheapMatch = checkpointLabels.toLowerCase().includes(searchTerm) ||
            entryMatchesLabelSearch(labelMaps, n.entry.id, searchTerm) ||
            n.entry.id.toLowerCase().includes(searchTerm);
        if (cheapMatch || entryContentMatchesSearch(n.entry, contentPattern)) {
            const normalized = getMsgContent(n.entry, false).replace(/\s+/g, " ");
            matched.push({
                node: n,
                checkpointLabels,
                preview: normalized.length > 80 ? normalized.slice(0, 80) + "..." : normalized,
            });
        }
    }
    matched.sort((a, b) => compareEntriesByTimestamp(a.node.entry, b.node.entry));
    return { matches: matched, truncated: matched.length >= searchLimit * 2 || visited >= 10000 };
}

function renderTreeNode(
    node: SessionTreeNode,
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
    const content = getMsgContent(entry, false).replace(/\s+/g, " ");
    const body = content.length > 50 ? content.slice(0, 50) + "..." : content;
    const connector = isLast ? "└─" : "├─";
    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
    lines.push(`${prefix}${connector} ${entry.id}${meta} [${role}] ${body}`);
    let truncated = false;
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
        if (lines.length >= 200) { truncated = true; break; }
        if (renderTreeNode(children[i], labelMaps, currentLeafId, backboneIds, depth + 1, maxDepth, childPrefix, i === children.length - 1, lines))
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
export function fixOrphanedToolUse(messages: any[]): boolean {
    let changed = false;

    // Pass 1: Remove tool results that are not attached to the immediately
    // preceding assistant tool-call batch. Walking past sibling tool results is
    // valid; walking past any other role is not.
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "toolResult") continue;
        const toolCallId = msg.toolCallId ?? msg.tool_use_id;
        let precedingIndex = i - 1;
        while (precedingIndex >= 0 && messages[precedingIndex].role === "toolResult") precedingIndex--;
        const preceding = precedingIndex >= 0 ? messages[precedingIndex] : undefined;
        const hasMatchingCall = Boolean(
            toolCallId &&
            preceding?.role === "assistant" &&
            preceding.stopReason !== "error" &&
            preceding.stopReason !== "aborted" &&
            Array.isArray(preceding.content) &&
            preceding.content.some((block: any) =>
                (block.type === "toolCall" || block.type === "tool_use") &&
                (block.id ?? block.toolCallId) === toolCallId
            ),
        );
        if (!hasMatchingCall) {
            messages.splice(i, 1);
            changed = true;
        }
    }

    // Pass 2: Inject synthetic toolResults for orphaned tool_use blocks
    // (assistant has tool_use but no subsequent toolResult with matching ID).
    // Skip error/aborted assistants — pi-ai's transformMessages strips them
    // entirely, so injecting a synthetic result here would create an orphaned
    // toolResult referencing a tool_use that never reaches the API.
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;

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
            isError: true,
            timestamp: Date.now(),
        }));

        let insertAt = i + 1;
        while (insertAt < messages.length && messages[insertAt].role === "toolResult") insertAt++;
        messages.splice(insertAt, 0, ...synthetics);
        changed = true;
        i = insertAt + synthetics.length - 1;
    }

    return changed;
}

/** Set or clear entry labels through the runtime SessionManager. Passing
 * label=undefined clears every alias on the node and is only safe when the
 * caller has verified that the node had no previous labels. */
function setEntryLabel(sm: SessionManager, entryId: string, label: string | undefined): void {
    const runtime = sm as unknown as {
        appendLabelChange?: (id: string, nextLabel: string | undefined) => string;
    };
    if (typeof runtime.appendLabelChange !== "function") {
        throw new Error("SessionManager does not support appendLabelChange — cannot update checkpoint labels");
    }
    const result = runtime.appendLabelChange(entryId, label);
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`appendLabelChange returned an invalid entry id: ${typeof result}`);
    }
}

function createBranchSummary(
    sm: SessionManager,
    branchFromId: string,
    summary: string,
    details: unknown,
): string {
    const runtime = sm as unknown as {
        branchWithSummary?: (id: string, text: string, metadata?: unknown, fromExtension?: boolean) => string;
    };
    if (typeof runtime.branchWithSummary !== "function") {
        throw new Error("SessionManager does not support branchWithSummary");
    }
    const result = runtime.branchWithSummary(branchFromId, summary, details, true);
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`branchWithSummary returned an invalid entry id: ${typeof result}`);
    }
    return result;
}

const CHECKPOINT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function validateCheckpointName(value: string, field: string): string | undefined {
    if (!CHECKPOINT_NAME_PATTERN.test(value)) {
        return `${field} must match [A-Za-z0-9._-]{1,64}.`;
    }
    return undefined;
}

function validateNonEmptyString(value: string, field: string, maxLength?: number): string | undefined {
    if (value.trim().length === 0) return `${field} must not be empty.`;
    if (maxLength !== undefined && value.length > maxLength) return `${field} must be at most ${maxLength} characters.`;
    return undefined;
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

    const contextRefresh = new ContextRefreshRegistry();
    const refreshTargetLeafIds = new WeakMap<object, string>();
    // ── Accurate token cache (fixes HUD lag after travel) ──────
    // Keep state isolated per SessionManager so multiple live sessions cannot
    // leak refresh/token state into one another.
    const cachedUsageMap = new WeakMap<object, UsageLike>();

    // ── Tool: acm_checkpoint ───────────────────────────────────
    const CheckpointParams = Type.Object({
        name: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9._-]+$",
            description: "Unique semantic anchor name. Use '<name>-start' for the beginning of a boundary you may later compress: task chain, phase, burst, or risky attempt. Use '<name>-done' for a milestone/archive pointer after results are in hand. E.g. parser-fix-start, timeout-investigation-start, root-cause-done. Avoid generic names like start, checkpoint-1. Only letters, digits, hyphens, underscores, and dots. Max 64 chars.",
        }),
        target: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "History node ID or checkpoint name to label. Defaults to current meaningful position near HEAD." })),
    });

    pi.registerTool({
        name: "acm_checkpoint",
        label: "ACM Checkpoint",
        description: "Create a recoverability anchor on a conversation node. Structurally lightweight: creates no branch or handoff and does not change the active context. Checkpoint before task chains, phase starts, bursts whose output cannot be bounded, risky steps, and milestones. A checkpoint does not fold context; it makes a future boundary fold possible. Names are unique across the session tree; one node may hold multiple aliases. The result reports context usage and fold candidates — choose by boundary, not proximity.",
        parameters: CheckpointParams,
        async execute(_id, rawParams: Static<typeof CheckpointParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            const nameError = validateCheckpointName(params.name, "name");
            if (nameError) return { content: [{ type: "text", text: `Error: ${nameError}` }], details: { error: "invalid_name" } };
            if (params.target !== undefined) {
                const targetError = validateNonEmptyString(params.target, "target", 256);
                if (targetError) return { content: [{ type: "text", text: `Error: ${targetError}` }], details: { error: "invalid_target" } };
            }

            const sm = ctx.sessionManager as SessionManager;
            const tree = sm.getTree();
            const entries = sm.getEntries();
            const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
            const labelMaps = buildLabelMaps(entries);
            const branch = sm.getBranch();
            const branchIds = new Set(branch.map((e: SessionEntry) => e.id));

            let id: string;
            let autoResolved: MeaningfulResolveResult | undefined;

            if (params.target) {
                const resolved = resolveTargetId(sm, tree, params.target, branchIds, labelMaps);
                if (params.target.toLowerCase() === "root" && tree.length > 1) {
                    ctx.ui.notify(`Note: 'root' resolved to the first top-level node (${resolved.id}); this session has ${tree.length} top-level roots.`, "info");
                }
                id = resolved.id;
                if (!isValidEntryId(id)) {
                    return { content: [{ type: "text", text: "Error: Cannot checkpoint — session tree is empty." }], details: {} };
                }
                const targetEntry = findInTree(tree, (n) => n.entry.id === id)?.entry;
                if (!targetEntry) {
                    return { content: [{ type: "text", text: `Error: Target '${params.target}' not found. Use acm_timeline to choose the last clean node before the boundary you want to label; raw node IDs are valid targets.` }], details: {} };
                }
                if (!isCheckpointableMessage(targetEntry)) {
                    ctx.ui.notify(`Warning: target '${params.target}' (${id}) is not a USER/AI node. Travel semantics may be unintuitive.`, "warning");
                }
            } else {
                autoResolved = findLastMeaningfulEntry(branch, signal);
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

            try {
                setEntryLabel(sm, id, params.name);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: Checkpoint '${params.name}' could not be created: ${message}.` }], details: { error: "label_failed", message } };
            }

            const aliasSuffix = priorLabels.length > 0 ? ` Added alias alongside: ${priorLabels.join(", ")}.` : "";

            // Push context usage plus fold candidates into every checkpoint result,
            // so the agent sees fill level and possible boundary targets during
            // normal work, without calling acm_timeline.
            const usage = ctx.getContextUsage();
            const usageLike: UsageLike | undefined = usage && usage.tokens != null && usage.percent != null
                ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
                : undefined;
            const usageText = formatContextUsage(usageLike, true);
            // Nearest previous anchor behind HEAD — the phase-fold target.
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
            // Earliest on-path '-start' anchor — the task-chain fold target.
            let earliestStartLabel: string | null = null;
            let earliestStartEntryId: string | null = null;
            for (let i = 0; i < branch.length; i++) {
                const eid = branch[i].id;
                if (eid === id) continue;
                const startLabel = getEntryLabels(labelMaps, eid).find((l) => l.endsWith("-start"));
                if (startLabel) {
                    earliestStartLabel = startLabel;
                    earliestStartEntryId = eid;
                    break;
                }
            }
            let foldPreview = "";
            let estimatedAtPrevAnchor: UsageLike | undefined;
            let estimatedAtEarliestStart: UsageLike | undefined;
            if (usageLike && (prevAnchorEntryId || earliestStartEntryId)) {
                const currentMessages = getBuildSessionMessagesFromEntries(entries, sm.getLeafId(), entriesById);
                const previewParts: string[] = [];
                if (prevAnchorEntryId && prevAnchorLabel) {
                    estimatedAtPrevAnchor = estimateUsageAfterMessageChange(
                        usageLike, currentMessages, getBuildSessionMessagesFromEntries(entries, prevAnchorEntryId, entriesById),
                    );
                    if (estimatedAtPrevAnchor) {
                        previewParts.push(`nearest anchor '${prevAnchorLabel}' → phase/burst candidate ~${formatContextUsage(estimatedAtPrevAnchor, true)} est.`);
                    }
                }
                if (earliestStartEntryId && earliestStartLabel && earliestStartEntryId !== prevAnchorEntryId) {
                    estimatedAtEarliestStart = estimateUsageAfterMessageChange(
                        usageLike, currentMessages, getBuildSessionMessagesFromEntries(entries, earliestStartEntryId, entriesById),
                    );
                    if (estimatedAtEarliestStart) {
                        previewParts.push(`earliest on-path -start '${earliestStartLabel}' → possible task-chain candidate ~${formatContextUsage(estimatedAtEarliestStart, true)} est.`);
                    }
                }
                if (previewParts.length > 0) {
                    foldPreview = formatFoldCandidatePreview(previewParts);
                }
            }
            // Name-triggered guidance: a '-done' checkpoint marks finished work and
            // task-end handling follows the preview rather than forcing a no-op fold.
            let doneDirective = "";
            if (params.name.endsWith("-done")) {
                const base = params.name.slice(0, -"-done".length);
                const siblingStart = `${base}-start`;
                const startRef = labelMaps.labelToEntryId.has(siblingStart) ? siblingStart : "<task>-start";
                doneDirective = ` '${params.name}' is a milestone/archive pointer. If later work moves past it, this is a recovery target. If this closes the task, use the preview to choose the close: when travel would produce meaningful structural saving, fold before the final answer and answer from the handoff with acm_travel({ target: "${startRef}", summary: <${HANDOFF_SLOT_HINT} handoff> }); when the preview shows almost no saving, keep this unique '-done' checkpoint and answer directly. Boundary decides whether folding is semantically appropriate; preview only measures savings.`;
            }
            const usageSuffix = ` Context usage: ${usageText}.${foldPreview}${doneDirective}`;
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
                    earliestStartAnchor: earliestStartLabel,
                    estimatedUsageAtEarliestStart: estimatedAtEarliestStart ? formatContextUsage(estimatedAtEarliestStart, true) : null,
                },
            };
        },
    });

    // ── Tool: acm_timeline ─────────────────────────────────────
    const TimelineParams = Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "In default active-path mode: maximum visible entries (default 50). In full_tree mode: maximum tree depth to render. With search or list_checkpoints: maximum results displayed. Range 1..50." })),
        verbose: Type.Optional(Type.Boolean({ description: "Show all messages including internal tool traffic, system/custom meta messages, and ACM tool calls. Applies only in default active-path mode; ignored when list_checkpoints, search, or full_tree is active." })),
        full_tree: Type.Optional(Type.Boolean({ description: "Show all branches including off-path nodes with IDs. Default false (active path only). Prefer list_checkpoints or search on large trees. Ignored when list_checkpoints or search is set." })),
        list_checkpoints: Type.Optional(Type.Boolean({ description: "List checkpoint labels across the full tree with node IDs and on-path/off-path tags. Display is capped by limit (maximum 50); use search to narrow. Ignores verbose and full_tree when set." })),
        search: Type.Optional(Type.String({ maxLength: 500, description: "Search the full session tree (active + off-path) for matching checkpoint labels, node IDs, or content. When set without list_checkpoints, returns matching nodes. With list_checkpoints, filters the checkpoint catalog. Mode precedence: list_checkpoints > search > full_tree > default active path." })),
    });

    pi.registerTool({
        name: "acm_timeline",
        label: "ACM Timeline",
        description: "Inspect the conversation tree: active path (default), full tree, checkpoint catalog, or global search. Call when choosing a travel target, when orientation is unclear, or to check context usage. list_checkpoints estimates post-fold usage for the displayed matching anchors when usage data is available; display limits still apply. On large trees prefer list_checkpoints or search over full_tree.",
        parameters: TimelineParams,
        async execute(_id, rawParams: Static<typeof TimelineParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)) {
                return { content: [{ type: "text", text: "Error: limit must be an integer from 1 to 50." }], details: { error: "invalid_limit" } };
            }
            if (params.search !== undefined && params.search.length > 500) {
                return { content: [{ type: "text", text: "Error: search must be at most 500 characters." }], details: { error: "invalid_search" } };
            }

            const sm = ctx.sessionManager as SessionManager;
            const tree = sm.getTree();
            const currentLeafId = sm.getLeafId();
            const verbose = params.verbose ?? false;
            const limit = params.limit ?? 50;
            const timelineMode = resolveTimelineMode(params);
            const searchTerm = params.search?.toLowerCase().trim() ?? "";

            const branch = sm.getBranch();
            const entries = sm.getEntries();
            const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
            const labelMaps = buildLabelMaps(entries);
            const backboneIds = new Set(branch.map((e: SessionEntry) => e.id));
            const pathOrderById = new Map(branch.map((entry, index) => [entry.id, index]));
            const childIndex = buildChildIndex(tree);
            const offPathForks = countOffPathForks(branch, childIndex, backboneIds);
            const lines: string[] = [];
            let treeTruncated = false;

            if (timelineMode === "list_checkpoints") {
                const listings = collectCheckpointListings(
                    labelMaps, backboneIds, currentLeafId, searchTerm, entriesById, pathOrderById,
                );
                const listLimit = limit;
                const usage = ctx.getContextUsage();
                const usageLike: UsageLike | undefined = usage && usage.tokens != null && usage.percent != null
                    ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
                    : undefined;
                const currentMessages = getBuildSessionMessagesFromEntries(entries, currentLeafId, entriesById);
                const targetCache = new Map<string, ReturnType<typeof getBuildSessionMessagesFromEntries>>();
                lines.push(`Checkpoints (${listings.length} total${searchTerm ? ` matching '${params.search}'` : ""}, showing up to ${listLimit}):`);
                for (const cp of listings.slice(0, listLimit)) {
                    const pathTag = cp.onActivePath ? "on-path" : "off-path";
                    const headTag = cp.isHead ? ", *HEAD*" : "";
                    let targetMessages = targetCache.get(cp.entryId);
                    if (!targetMessages) {
                        targetMessages = getBuildSessionMessagesFromEntries(entries, cp.entryId, entriesById);
                        targetCache.set(cp.entryId, targetMessages);
                    }
                    const estimated = estimateUsageAfterMessageChange(usageLike, currentMessages, targetMessages);
                    const estPart = estimated ? `~${targetMessages.length} msgs, ~${formatContextUsage(estimated, true)} est. (+summary)` : `~${targetMessages.length} msgs`;
                    lines.push(`  ${cp.label} → ${cp.entryId} (${pathTag}${headTag}) ${estPart}`);
                }
                if (listings.length > listLimit) lines.push(`  ... +${listings.length - listLimit} more`);
            } else if (searchTerm && timelineMode === "search") {
                const searchLimit = limit;
                const { matches, truncated } = searchFullSessionTree(tree, labelMaps, searchTerm, searchLimit, signal);
                lines.push(`Found ${matches.length}${truncated ? "+" : ""} node(s) matching '${params.search}':`);
                for (const m of matches.slice(0, searchLimit)) {
                    const isHead = m.node.entry.id === currentLeafId;
                    const role = getDisplayRole(m.node.entry);
                    const body = m.preview;
                    const metaParts = [
                        m.checkpointLabels ? `checkpoint: ${m.checkpointLabels}` : null,
                        isHead ? "*HEAD*" : null,
                    ].filter(Boolean);
                    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
                    lines.push(`${isHead ? "*" : " "} ${m.node.entry.id}${meta} [${role}] ${body}`);
                }
            } else if (timelineMode === "full_tree") {
                const maxDepth = limit;
                for (let i = 0; i < tree.length; i++) {
                    if (signal?.aborted) break;
                    if (renderTreeNode(tree[i], labelMaps, currentLeafId, backboneIds, 0, maxDepth, "", i === tree.length - 1, lines))
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
                    const content = getMsgContent(entry, verbose).replace(/\s+/g, " ");
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
            const cachedUsage = cachedUsageMap.get(sm);
            const lastLlmStr = cachedUsage ? formatContextUsage(cachedUsage, true) : "N/A";

            let stepsSinceCheckpoint = 0;
            let nearestCheckpointName: string | null = null;
            for (let i = branch.length - 1; i >= 0; i--) {
                const labels = getEntryLabels(labelMaps, branch[i].id);
                if (labels.length > 0) { nearestCheckpointName = labels[labels.length - 1]; break; }
                stepsSinceCheckpoint++;
            }

            const travelCue = formatBoundaryTravelCue(nearestCheckpointName);

            const refreshFailureMsg = contextRefresh.getFailure(sm);
            const isRefreshPending = contextRefresh.isPending(sm);
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
            else if (isRefreshPending) {
                const attempt = contextRefresh.getAttemptCount(sm);
                const retrySuffix = attempt > 0 ? ` (retry ${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS})` : "";
                const pendingSuffix = contextRefresh.hasRebuilt(sm) ? "" : " (travel pending)";
                hudParts.push(`• Context Sync:     persistent rebuild active${pendingSuffix}${retrySuffix}`);
            }
            hudParts.push(`---------------------------------------------------`);

            return {
                content: [{ type: "text", text: hudParts.join("\n") + "\n" + (lines.join("\n") || "(Root Path Only)") }],
                details: { leafId: currentLeafId, nearestCheckpoint: nearestCheckpointName, stepsSinceCheckpoint, activePathNodes: branch.length, offPathBranches: offPathForks },
            };
        },
    });

    // ── Tool: acm_travel ───────────────────────────────────────
    const TravelParams = Type.Object({
        target: Type.String({ minLength: 1, maxLength: 256, description: "Checkpoint name, history node ID, or 'root'. Name the boundary first, then choose a target before that boundary. On large trees use acm_timeline with list_checkpoints or search; use full_tree only when the surrounding branch structure is needed." }),
        summary: Type.String({ minLength: 1, maxLength: 10000, description: `Handoff summary — the working state after travel. It must make the next action executable without rereading the folded trail. Fill every slot, write 'none' rather than dropping one: ${HANDOFF_SLOT_HINT}. Include recovery pointers; pointers over dumps. Max 10000 chars.` }),
        backupCurrentHeadAs: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$", description: "Optional archive bookmark for the raw path being folded away. At task end, use '<task>-done' when the preview shows meaningful structural saving and the path does not already carry a suitable '-done' checkpoint. If the preview shows almost no saving, create a unique '-done' checkpoint and answer directly instead of calling travel merely to set this field. This is a recovery pointer, never the travel target or a substitute for a self-contained handoff." })),
    });

    pi.registerTool({
        name: "acm_travel",
        label: "ACM Travel",
        description: "Fold conversation history into a recoverable handoff by traveling to a checkpoint, node ID, or root. Use at stable boundaries: burst distilled, phase complete, direction failed, batch item done, task chain complete, or new request over finished work. Name the boundary first, choose a target before that boundary, and write a handoff with executable NEXT plus recovery pointers. Fold by boundary, not proximity. At task end, travel to the semantic task-chain start and set backupCurrentHeadAs to '<task>-done' only when the preview shows meaningful structural saving; if it shows almost no saving, create a unique '-done' checkpoint and answer directly. Boundary decides whether folding is semantically appropriate; preview only measures savings. Travel changes conversation history only, not disk files or external systems.",
        parameters: TravelParams,
        async execute(_id, rawParams: Static<typeof TravelParams>, signal, _onUpdate, ctx) {
            const params = rawParams;
            const targetError = validateNonEmptyString(params.target, "target", 256);
            if (targetError) return { content: [{ type: "text", text: `Error: ${targetError}` }], details: { error: "invalid_target" } };
            const summaryError = validateNonEmptyString(params.summary, "summary", 10000);
            if (summaryError) return { content: [{ type: "text", text: `Error: ${summaryError}` }], details: { error: "invalid_summary" } };
            if (params.backupCurrentHeadAs !== undefined) {
                const backupError = validateCheckpointName(params.backupCurrentHeadAs, "backupCurrentHeadAs");
                if (backupError) return { content: [{ type: "text", text: `Error: ${backupError}` }], details: { error: "invalid_backup_name" } };
            }

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
            if (params.target.toLowerCase() === "root" && tree.length > 1) {
                ctx.ui.notify(`Note: 'root' resolved to the first top-level node (${tid}); this session has ${tree.length} top-level roots.`, "info");
            }
            if (!findInTree(tree, (n) => n.entry.id === tid)) {
                return { content: [{ type: "text", text: `Error: Target '${params.target}' not found. Use acm_timeline to choose the last clean node before the boundary you want to compress; raw node IDs are valid targets.` }], details: {} };
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
                const headResolve = findLastMeaningfulEntry(branch, signal);
                if (headResolve.aborted) {
                    return { content: [{ type: "text", text: "acm_travel aborted during backup target resolution." }], details: { error: "aborted", target: params.target, targetId: tid } };
                }
                backupEntryId = headResolve.entryId ?? undefined;
                if (!backupEntryId) {
                    return { content: [{ type: "text", text: `Error: archive bookmark backupCurrentHeadAs '${params.backupCurrentHeadAs}' could not be placed — no meaningful USER/AI message found near HEAD. Travel aborted.` }], details: { error: "no_meaningful_backup_target", name: params.backupCurrentHeadAs, headId: originId } };
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
                    return { content: [{ type: "text", text: `Error: archive bookmark name '${params.backupCurrentHeadAs}' already exists at ${existing}. Use a different backupCurrentHeadAs name; the handoff must still carry the executable state.` }], details: { error: "duplicate_backup_name", name: params.backupCurrentHeadAs, owner: backupOwner } };
                }
                const backupPriorLabels = getEntryLabels(labelMaps, backupEntryId);
                if (!backupPriorLabels.includes(params.backupCurrentHeadAs)) {
                    backupHadNoPriorLabels = backupPriorLabels.length === 0;
                    try {
                        setEntryLabel(sm, backupEntryId, params.backupCurrentHeadAs);
                        backupLabelWrittenThisCall = true;
                    } catch (e) {
                        return {
                            content: [{ type: "text", text: `Error: archive bookmark '${params.backupCurrentHeadAs}' could not be set: ${e instanceof Error ? e.message : String(e)}. Travel aborted.` }],
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
                summaryEntryId = createBranchSummary(sm, tid, params.summary, travelDetails);
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
            contextRefresh.markPending(sm);
            refreshTargetLeafIds.set(sm, summaryEntryId);

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
                        `Travel complete. You are now on the handoff branch. target=${params.target} (${tid}); archive=${backupText}; context ${usageBeforeText} → ${estimatedUsageAfterText} est. (estimatedEffect=${estimatedEffect}, structuralEffect=${structuralEffect}); sessionMessages=${messageDelta}; summaryEntryId=${summaryEntryId}.`,
                        "Treat the handoff as the working state: execute its NEXT. Raw trail is archived off-path; recover it via the archive pointer or timeline search.",
                        "Context rebuild is now persistent: every subsequent LLM turn is rebuilt from the handoff branch until the next travel or session reload. Run acm_timeline if official token % or sync status is unclear.",
                        estimatedUsagePreview
                            ? `Pre-travel preview was ${estimatedPreviewText} est. — compare with post-travel estimate above.`
                            : null,
                        "Estimates use buildSessionContext + token model; official % confirms on the next LLM context event or acm_timeline.",
                        "Note: the branch summary entry is appended synchronously and may appear before this tool call in the session log.",
                        "If this was a task-end fold, give the final answer from the handoff. Otherwise checkpoint the next phase ('<phase>-start') before its first action.",
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

    // ── Event: context → request sanitation + persistent travel override ──
    // Sanitize every outbound request, including the first request after a
    // session restore. The travel-pending registry is intentionally in-memory
    // and is cleared by session_start, but branchWithSummary can persist a
    // toolResult immediately after a branch summary. On reload that result has
    // no matching assistant tool call on the active branch, so OpenAI rejects
    // the request unless we remove it even when no travel refresh is pending.
    //
    // Pi's context event return value only affects ONE LLM call. When a travel
    // is pending, keep rebuilding while this SessionManager has an active
    // travel, with bounded retries and visible failure state instead of silently
    // passing through stale messages.
    pi.on("context", (event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        if (!contextRefresh.isPending(sm)) {
            return fixOrphanedToolUse(event.messages)
                ? { messages: event.messages }
                : undefined;
        }

        const reportFailure = (message: string) => {
            const willRetry = contextRefresh.recordFailedAttempt(sm, message);
            const attempt = contextRefresh.getAttemptCount(sm);
            ctx.ui.notify(
                willRetry
                    ? `Context refresh after travel failed (${attempt}/${ContextRefreshRegistry.MAX_ATTEMPTS}): ${message}. Will retry on the next LLM turn.`
                    : `Context refresh after travel failed after ${attempt} attempts: ${message}. Reload the session to sync messages.`,
                "warning",
            );
            return { messages: event.messages };
        };

        try {
            let messages = getBuildSessionMessages(sm);
            if (messages.length === 0) {
                const fallbackLeafId = refreshTargetLeafIds.get(sm);
                messages = fallbackLeafId ? getBuildSessionMessages(sm, fallbackLeafId) : [];
            }
            if (messages.length === 0) return reportFailure("rebuilt messages array is empty");

            fixOrphanedToolUse(messages);
            contextRefresh.markRebuilt(sm);
            return { messages: messages as typeof event.messages };
        } catch (error) {
            return reportFailure(error instanceof Error ? error.message : String(error));
        }
    });

    // ── Event: turn_end → cache accurate token usage ─────────────
    // getContextUsage() reads stale agent.state.messages after travel.
    // turn_end gives us the real promptTokens from each LLM response,
    // so the timeline HUD shows accurate numbers immediately.
    pi.on("turn_end", (event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        const msg = event.message;
        if (msg.role !== "assistant") return;
        const usage = msg.usage;
        if (!usage) return;
        const promptTokens = usage.input + usage.cacheRead;
        const officialUsage = ctx.getContextUsage();
        const contextWindow = officialUsage?.contextWindow;
        if (typeof contextWindow === "number" && contextWindow > 0) {
            cachedUsageMap.set(sm, { tokens: promptTokens, contextWindow, percent: (promptTokens / contextWindow) * 100 });
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
        const resolve = findLastMeaningfulEntry(branch, event.signal);
        if (!resolve.entryId) return;
        const priorLabels = getEntryLabels(labelMaps, resolve.entryId);
        if (priorLabels.includes(checkpointName)) return;
        try {
            setEntryLabel(sm, resolve.entryId, checkpointName);
        } catch (error) {
            ctx.ui.notify(`Could not create pre-compaction checkpoint: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
    });

    // ── Event: session_compact → sync refresh state ──────────────
    // Compaction triggers replaceMessages internally, which syncs
    // agent.state.messages to the current branch. Clear this session's refresh
    // registry state since the override is no longer needed, and drop cached usage.
    pi.on("session_compact", (_event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        contextRefresh.clear(sm);
        refreshTargetLeafIds.delete(sm);
        cachedUsageMap.delete(sm);
    });

    // ── Session lifecycle: clear stale state ───────────────────
    pi.on("session_start", (_event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        contextRefresh.clear(sm);
        refreshTargetLeafIds.delete(sm);
        cachedUsageMap.delete(sm);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        const sm = ctx.sessionManager as SessionManager;
        contextRefresh.clear(sm);
        refreshTargetLeafIds.delete(sm);
        cachedUsageMap.delete(sm);
    });
}
