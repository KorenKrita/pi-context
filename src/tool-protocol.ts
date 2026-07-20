import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ToolProtocolRepair =
  | { kind: "removed_orphan_result"; toolCallId: string; toolName: string }
  | { kind: "removed_duplicate_result"; toolCallId: string; toolName: string }
  | { kind: "synthesized_missing_result"; toolCallId: string; toolName: string }
  | { kind: "reordered_results"; assistantIndex: number; before: string[]; after: string[] };

export type ToolProtocolDefect =
  | { kind: "invalid_tool_call_id"; assistantIndex: number; contentIndex: number }
  | { kind: "invalid_tool_name"; assistantIndex: number; contentIndex: number; toolCallId?: string }
  | { kind: "duplicate_tool_call_id"; assistantIndex: number; toolCallId: string };

export interface ToolProtocolAnalysis {
  status: "complete" | "repaired" | "invalid";
  messages: AgentMessage[];
  repairs: ToolProtocolRepair[];
  defects: ToolProtocolDefect[];
}

export interface ContainingAssistantToolBatch {
  entryId: string;
  entryIndex: number;
  toolCallCount: number;
}

function assistantHasVisibleText(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  const content: unknown = entry.message.content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) =>
    typeof block === "object"
    && block !== null
    && "type" in block
    && block.type === "text"
    && "text" in block
    && typeof block.text === "string"
    && block.text.trim().length > 0);
}

/** Whether the latest user turn still lacks a visible assistant response at this tool batch. */
export function hasOpenLatestUserTurn(entries: readonly SessionEntry[]): boolean {
  let latestUserIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "message" && entry.message.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  return !entries.slice(latestUserIndex + 1).some(assistantHasVisibleText);
}

/** Whether the latest user turn still lacks a visible assistant response at this tool batch. */
export function hasOpenUserTurnAtAssistant(
  entries: readonly SessionEntry[],
  assistantEntryIndex: number,
): boolean {
  return hasOpenLatestUserTurn(entries.slice(0, assistantEntryIndex + 1));
}

function isToolCallBlock(block: unknown): block is ToolCall {
  return (
    typeof block === "object"
    && block !== null
    && "type" in block
    && block.type === "toolCall"
    && "id" in block
    && typeof block.id === "string"
    && block.id.trim().length > 0
    && "name" in block
    && typeof block.name === "string"
    && block.name.trim().length > 0
  );
}

function isToolCallLike(block: unknown): block is { type: "toolCall"; id?: unknown; name?: unknown } {
  return typeof block === "object" && block !== null && "type" in block && block.type === "toolCall";
}

function findToolCallDefects(messages: readonly AgentMessage[]): ToolProtocolDefect[] {
  const defects: ToolProtocolDefect[] = [];
  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex++) {
    const message = messages[assistantIndex]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const seenIds = new Set<string>();
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block = message.content[contentIndex];
      if (!isToolCallLike(block)) continue;
      const candidate = block as { id?: unknown; name?: unknown };
      const id = typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id
        : undefined;
      if (!id) {
        defects.push({ kind: "invalid_tool_call_id", assistantIndex, contentIndex });
      } else if (seenIds.has(id)) {
        defects.push({ kind: "duplicate_tool_call_id", assistantIndex, toolCallId: id });
      } else {
        seenIds.add(id);
      }
      if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
        defects.push({
          kind: "invalid_tool_name",
          assistantIndex,
          contentIndex,
          ...(id === undefined ? {} : { toolCallId: id }),
        });
      }
    }
  }
  return defects;
}

/** Repair provider tool-call/result ordering and report every packet mutation. */
export function analyzeToolProtocol(messages: readonly AgentMessage[]): ToolProtocolAnalysis {
  const defects = findToolCallDefects(messages);
  if (defects.length > 0) {
    return { status: "invalid", messages: [...messages], repairs: [], defects };
  }
  const result = [...messages];
  const repairs: ToolProtocolRepair[] = [];

  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index]!;
    if (message.role !== "toolResult") continue;
    const toolCallId = message.toolCallId;
    let precedingIndex = index - 1;
    while (precedingIndex >= 0 && result[precedingIndex]!.role === "toolResult") precedingIndex--;
    const preceding = precedingIndex >= 0 ? result[precedingIndex]! : undefined;
    const hasMatchingCall = Boolean(
      toolCallId
      && preceding?.role === "assistant"
      && preceding.stopReason !== "error"
      && preceding.stopReason !== "aborted"
      && Array.isArray(preceding.content)
      && preceding.content.some((block: unknown) => isToolCallBlock(block) && block.id === toolCallId),
    );
    if (!hasMatchingCall) {
      repairs.push({
        kind: "removed_orphan_result",
        toolCallId,
        toolName: message.toolName,
      });
      result.splice(index, 1);
    }
  }

  for (let index = 0; index < result.length; index++) {
    const message = result[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;

    const toolUseIds: { id: string; name: string }[] = [];
    for (const block of message.content as unknown[]) {
      if (isToolCallBlock(block) && block.id) toolUseIds.push({ id: block.id, name: block.name });
    }
    if (toolUseIds.length === 0) continue;

    const existingResults = new Map<string, AgentMessage>();
    let followingIndex = index + 1;
    while (followingIndex < result.length && result[followingIndex]!.role === "toolResult") {
      const following = result[followingIndex]!;
      if (following.role !== "toolResult") break;
      if (following.toolCallId) {
        if (existingResults.has(following.toolCallId)) {
          repairs.push({
            kind: "removed_duplicate_result",
            toolCallId: following.toolCallId,
            toolName: following.toolName,
          });
        } else {
          existingResults.set(following.toolCallId, following);
        }
      }
      followingIndex++;
    }

    const beforeOrder = [...existingResults.keys()];
    const expectedPresentOrder = toolUseIds
      .map((toolUse) => toolUse.id)
      .filter((id) => existingResults.has(id));
    if (
      expectedPresentOrder.length === toolUseIds.length
      && beforeOrder.some((id, position) => id !== expectedPresentOrder[position])
    ) {
      repairs.push({
        kind: "reordered_results",
        assistantIndex: index,
        before: beforeOrder,
        after: expectedPresentOrder,
      });
    }

    const repairedResults: AgentMessage[] = toolUseIds.map((toolUse) => {
      const existing = existingResults.get(toolUse.id);
      if (existing) return existing;
      repairs.push({
        kind: "synthesized_missing_result",
        toolCallId: toolUse.id,
        toolName: toolUse.name,
      });
      return {
        role: "toolResult" as const,
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        content: [{ type: "text" as const, text: "[Interrupted by context travel]" }],
        timestamp: message.timestamp,
        isError: true,
      };
    });
    result.splice(index + 1, followingIndex - index - 1, ...repairedResults);
    index += repairedResults.length;
  }

  return {
    status: repairs.length === 0 ? "complete" : "repaired",
    messages: result,
    repairs,
    defects: [],
  };
}

/** Compatibility facade for consumers that only need the repaired packet. */
export function fixOrphanedToolUse(messages: readonly AgentMessage[]): AgentMessage[] {
  return analyzeToolProtocol(messages).messages;
}

/** Locate the assistant batch containing one tool call without interpreting session semantics. */
export function findContainingAssistantToolBatch(
  entries: readonly SessionEntry[],
  toolCallId: string,
): ContainingAssistantToolBatch | undefined {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = entries[entryIndex]!;
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      continue;
    }
    const toolCallBlocks = entry.message.content.filter(isToolCallLike);
    const validCalls = toolCallBlocks.filter(isToolCallBlock);
    if (validCalls.some((call) => call.id === toolCallId)) {
      return { entryId: entry.id, entryIndex, toolCallCount: toolCallBlocks.length };
    }
  }
  return undefined;
}
