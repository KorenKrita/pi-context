import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { TextContent, ToolCall, ThinkingContent } from "@earendil-works/pi-ai";
import { buildLabelMaps, type LabelMaps } from "./label-journal.js";
import { ACM_INTERNAL_TOOLS } from "./conventions.js";

type AssistantContentPart = TextContent | ThinkingContent | ToolCall | { type: string; [key: string]: unknown };

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

export function isValidEntryId(id: string): boolean {
 return id.length > 0;
}

/** Push tree children left-to-right so stack.pop() visits in document order. */
export function pushTreeChildrenPreOrder(stack: SessionTreeNode[], children: SessionTreeNode[]): void {
 for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
}

/**
 * Source-bounded text extraction: accumulate content parts only until the
 * budget is spent, never building the full joined string - the join is the
 * cost this exists to bound, so a slice-after-join still pays it. String
 * content takes a bounded prefix directly. Reports whether text remained.
 */
export function extractTextFromContentBounded(content: unknown, maxChars: number): { text: string; truncated: boolean } {
  if (typeof content === "string") {
    return content.length > maxChars
      ? { text: content.slice(0, maxChars), truncated: true }
      : { text: content, truncated: false };
  }
  if (Array.isArray(content)) {
    let collected = "";
    let truncated = false;
    let first = true;
    for (const part of content) {
      const text = typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
        ? part.text
        : "";
      if (collected.length >= maxChars) {
        if (text.length > 0) truncated = true;
        break;
      }
      const piece = first ? text : ` ${text}`;
      first = false;
      if (collected.length + piece.length > maxChars) {
        collected += piece.slice(0, maxChars - collected.length);
        truncated = true;
        break;
      }
      collected += piece;
    }
    return { text: collected.trim(), truncated: truncated || collected.length > maxChars };
  }
  // Non-array shapes are single short parts; the bounded path falls through
  // to the full extraction with a bounded prefix.
  const full = extractTextFromContent(content);
  return full.length > maxChars
    ? { text: full.slice(0, maxChars), truncated: true }
    : { text: full, truncated: false };
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

export function getEntryLabel(labelMaps: LabelMaps, entryId: string): string | undefined {
 return labelMaps.entryToLabel.get(entryId);
}

export function formatEntryLabel(labelMaps: LabelMaps, entryId: string): string | undefined {
 return getEntryLabel(labelMaps, entryId);
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
