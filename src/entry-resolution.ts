import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import {
  extractTextFromContent,
  findInTree,
  findLastMeaningfulEntry as findLastMeaningfulEntryCore,
  getMeaningfulSkipReason,
  type MeaningfulResolveResult,
} from "./lib.js";

export function getMessageRoleLabel(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const role = entry.message.role;
  if (role === "assistant") return "AI";
  if (role === "user") return "USER";
  if (role === "toolResult") return `TOOL:${entry.message.toolName}`;
  if (role === "bashExecution") return "BASH";
  if (role === "custom") return "CUSTOM";
  if ((role as string) === "system") return "SYSTEM";
  return role.toUpperCase();
}

export function isCheckpointableMessage(entry: SessionEntry): boolean {
  return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

export function describeEntrySnippet(entry: SessionEntry, maxLength = 60): string {
  const raw = entry.type === "message"
    ? ("content" in entry.message ? extractTextFromContent(entry.message.content) : "")
    : entry.type === "branch_summary" || entry.type === "compaction"
      ? entry.summary
      : "";
  const content = raw.replace(/\s+/g, " ").trim();
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
}

export function findLastMeaningfulEntry(
  branch: SessionEntry[],
  signal?: AbortSignal,
): MeaningfulResolveResult {
  return findLastMeaningfulEntryCore(
    branch,
    getMeaningfulSkipReason,
    getMessageRoleLabel,
    (entry) => describeEntrySnippet(entry),
    signal,
  );
}

export function findEntryInTree(tree: SessionTreeNode[], id: string): SessionEntry | undefined {
  return findInTree(tree, (node) => node.entry.id === id)?.entry;
}
