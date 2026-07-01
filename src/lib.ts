import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    estimateTokens,
    buildSessionContext,
    type SessionManager,
    type SessionEntry,
    type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ToolCall, ImageContent } from "@earendil-works/pi-ai";

export const ACM_INTERNAL_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);

const TRAVEL_EFFECT_MIN_TOKEN_DELTA = 500;
const TRAVEL_EFFECT_RELATIVE_THRESHOLD = 0.02;
const BRANCH_SUMMARY_ENTRY_OVERHEAD_TOKENS = 100;

export type TravelEffect = "shrunk" | "restored" | "unchanged" | "unknown";

export interface UsageLike {
    tokens: number;
    contextWindow: number;
    percent: number;
}

export interface LabelMaps {
    labelToEntryId: Map<string, string>;
    entryToLabels: Map<string, string[]>;
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

export type TimelineMode = "list_checkpoints" | "search" | "full_tree" | "active_path";

export function resolveTimelineMode(params: {
    list_checkpoints?: boolean;
    search?: string;
    full_tree?: boolean;
}): TimelineMode {
    if (params.list_checkpoints) return "list_checkpoints";
    if (params.search?.trim()) return "search";
    if (params.full_tree) return "full_tree";
    return "active_path";
}

/** One-shot context rebuild state keyed by session manager instance. */
export class ContextRefreshRegistry {
    static readonly MAX_ATTEMPTS = 3;

    private pending = new WeakSet<object>();
    private failures = new WeakMap<object, string>();
    private attempts = new WeakMap<object, number>();

    markPending(sm: object): void {
        this.pending.add(sm);
        this.failures.delete(sm);
        this.attempts.set(sm, 0);
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

    getFailure(sm: object): string | undefined {
        return this.failures.get(sm);
    }

    recordFailedAttempt(sm: object, message: string): boolean {
        const next = (this.attempts.get(sm) ?? 0) + 1;
        this.attempts.set(sm, next);
        this.failures.set(sm, message);
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
    }
}

export function isValidEntryId(id: string): boolean {
    return id.length > 0;
}

export function pushTreeChildrenPreOrder(stack: SessionTreeNode[], children: SessionTreeNode[]): void {
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
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
    return "";
}

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

export function buildLabelMaps(entries: SessionEntry[]): LabelMaps {
    const labelToEntryId = new Map<string, string>();
    const entryToLabels = new Map<string, string[]>();

    for (const entry of entries) {
        if (entry.type !== "label") continue;
        const { targetId, label } = entry;
        if (label === null || label === undefined) {
            const existingLabels = entryToLabels.get(targetId);
            if (existingLabels) {
                for (const l of existingLabels) labelToEntryId.delete(l);
            }
            entryToLabels.delete(targetId);
            continue;
        }
        const previousOwner = labelToEntryId.get(label);
        if (previousOwner && previousOwner !== targetId) {
            const prevLabels = entryToLabels.get(previousOwner);
            if (prevLabels) {
                const filtered = prevLabels.filter((l) => l !== label);
                if (filtered.length === 0) entryToLabels.delete(previousOwner);
                else entryToLabels.set(previousOwner, filtered);
            }
        }
        labelToEntryId.set(label, targetId);
        const existing = entryToLabels.get(targetId) ?? [];
        if (!existing.includes(label)) {
            entryToLabels.set(targetId, [...existing, label]);
        }
    }
    return { labelToEntryId, entryToLabels };
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

export function resolveTargetId(
    sm: SessionManager,
    tree: SessionTreeNode[],
    target: string,
    branchIds?: Set<string>,
    labelMaps?: LabelMaps,
): ResolvedTarget {
    if (target.toLowerCase() === "root") {
        return { id: tree.length > 0 ? tree[0].entry.id : "", fromOffPath: false };
    }
    const ids = branchIds ?? new Set(sm.getBranch().map((e: SessionEntry) => e.id));
    const maps = labelMaps ?? buildLabelMaps(sm.getEntries());

    const owner = findCheckpointLabelOwner(maps, target, ids);
    if (owner) {
        return { id: owner.entryId, fromOffPath: !owner.onActivePath };
    }

    return { id: target, fromOffPath: !ids.has(target) };
}

export function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) return "N/A";
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

export function classifyTravelEffect(before: UsageLike | undefined, after: UsageLike | undefined): TravelEffect {
    if (!before || !after) return "unknown";
    const delta = after.tokens - before.tokens;
    const threshold = Math.max(
        TRAVEL_EFFECT_MIN_TOKEN_DELTA,
        before.tokens * TRAVEL_EFFECT_RELATIVE_THRESHOLD,
    );
    if (Math.abs(delta) <= threshold) return "unchanged";
    return delta < 0 ? "shrunk" : "restored";
}

export function classifyStructuralMessageEffect(before: number | undefined, after: number | undefined): TravelEffect {
    if (before === undefined || after === undefined) return "unknown";
    const delta = after - before;
    if (Math.abs(delta) <= 1) return "unchanged";
    return delta < 0 ? "shrunk" : "restored";
}

export function getBuildSessionMessages(sm: SessionManager, leafId?: string | null): AgentMessage[] {
    const entries = sm.getEntries();
    if (entries.length === 0) return [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const effectiveLeaf = leafId === undefined ? sm.getLeafId() : leafId;
    return buildSessionContext(entries, effectiveLeaf, byId).messages as AgentMessage[];
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
    // Simple char-based token estimate for the summary text
    const summaryTokens = summaryText.length > 0 ? Math.ceil(summaryText.length / 4) : 0;
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
    if ((msg as any).role === "custom") return "custom_message";
    if (msg.role === "system") return "system_message";
    if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
            const toolCalls = msg.content.filter(
                (c: any): c is ToolCall => c.type === "toolCall",
            );
            const hasVisibleText = msg.content.some(
                (c: any) => c.type === "text" && c.text.trim().length > 0,
            );
            const onlyInternalTools = toolCalls.length > 0 &&
                toolCalls.every((tc: ToolCall) => ACM_INTERNAL_TOOLS.has(tc.name));
            if (onlyInternalTools && !hasVisibleText) return "internal_tool_only_assistant";
            if (!hasVisibleText && toolCalls.length === 0) return "empty_assistant";
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
    sm: SessionManager,
    signal?: AbortSignal,
): MeaningfulResolveResult {
    const skipped: SkippedEntry[] = [];
    for (let i = branch.length - 1; i >= 0; i--) {
        if (signal?.aborted) {
            return { entryId: null, skipped, aborted: true };
        }
        const entry = branch[i];
        const skipReason = getMeaningfulSkipReason(entry);
        if (skipReason) {
            const role = entry.type === "message" ? getMessageRoleLabel(entry) : undefined;
            skipped.push({ id: entry.id, reason: skipReason, role });
            continue;
        }
        return {
            entryId: entry.id,
            role: getMessageRoleLabel(entry),
            snippet: describeEntrySnippet(entry, sm),
            skipped,
        };
    }
    return { entryId: null, skipped };
}

export function getMessageRoleLabel(entry: SessionEntry): string | undefined {
    if (entry.type !== "message") return undefined;
    const msg = entry.message;
    if (msg.role === "assistant") return "AI";
    if (msg.role === "user") return "USER";
    if (msg.role === "toolResult") return `TOOL:${msg.toolName}`;
    if (msg.role === "bashExecution") return "BASH";
    if ((msg as any).role === "custom") return "CUSTOM";
    if (msg.role === "system") return "SYSTEM";
    return (msg as any).role?.toUpperCase();
}

export function describeEntrySnippet(entry: SessionEntry, sm: SessionManager, maxLen = 60): string {
    const content = getMsgContent(entry, sm, false).replace(/\s+/g, " ").trim();
    if (!content) return "";
    return content.length > maxLen ? `${content.slice(0, maxLen)}...` : content;
}

export function getMsgContent(entry: SessionEntry, sm: SessionManager, verbose: boolean): string {
    if (entry.type === "branch_summary" || entry.type === "compaction") {
        return entry.summary || "[No summary provided]";
    }
    if (entry.type === "label") {
        return `checkpoint: ${entry.label}`;
    }
    if (entry.type !== "message") return "";

    const msg = entry.message;

    if (msg.role === "toolResult") {
        if (!verbose && ACM_INTERNAL_TOOLS.has(msg.toolName)) return "";
        let resText = (msg.content ?? [])
            .map((p: TextContent | ImageContent) => (p.type === "text" ? p.text : ""))
            .join(" ")
            .trim();
        const details = msg.details as Record<string, unknown> | undefined;
        if (details && "path" in details && typeof details.path === "string") {
            resText = `${details.path}: ${resText}`;
        }
        return `(${msg.toolName}) ${resText}`;
    }
    if (msg.role === "bashExecution") {
        return `[Bash] ${msg.command}`;
    }

    if (msg.role === "user" || msg.role === "assistant") {
        let text = extractTextFromContent(msg.content);
        let toolCallsText = "";
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const toolCalls = msg.content.filter(
                (c: any): c is ToolCall => c.type === "toolCall",
            );
            toolCallsText = toolCalls
                .filter((tc: ToolCall) => verbose || !ACM_INTERNAL_TOOLS.has(tc.name))
                .map((tc: ToolCall) => `call: ${tc.name}(${JSON.stringify(tc.arguments)})`)
                .join("; ");
        }
        return [text, toolCallsText].filter(Boolean).join(" ");
    }

    return "";
}
