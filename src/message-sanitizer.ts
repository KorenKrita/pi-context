import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";

function isToolCallBlock(block: unknown): block is ToolCall {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "toolCall" &&
    "id" in block &&
    "name" in block
  );
}

/** Remove orphan results and synthesize results for interrupted tool calls. */
export function fixOrphanedToolUse(messages: AgentMessage[]): AgentMessage[] {
  const result = [...messages];

  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index];
    if (message.role !== "toolResult") continue;
    const toolCallId = message.toolCallId;
    let precedingIndex = index - 1;
    while (precedingIndex >= 0 && result[precedingIndex].role === "toolResult") precedingIndex--;
    const preceding = precedingIndex >= 0 ? result[precedingIndex] : undefined;
    const hasMatchingCall = Boolean(
      toolCallId &&
      preceding?.role === "assistant" &&
      preceding.stopReason !== "error" &&
      preceding.stopReason !== "aborted" &&
      Array.isArray(preceding.content) &&
      preceding.content.some((block: unknown) => isToolCallBlock(block) && block.id === toolCallId),
    );
    if (!hasMatchingCall) result.splice(index, 1);
  }

  for (let index = 0; index < result.length; index++) {
    const message = result[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;

    const toolUseIds: { id: string; name: string }[] = [];
    for (const block of message.content as unknown[]) {
      if (isToolCallBlock(block) && block.id) toolUseIds.push({ id: block.id, name: block.name });
    }
    if (toolUseIds.length === 0) continue;

    const resolvedIds = new Set<string>();
    for (let followingIndex = index + 1; followingIndex < result.length; followingIndex++) {
      const following = result[followingIndex];
      if (following.role !== "toolResult") break;
      if (following.toolCallId) resolvedIds.add(following.toolCallId);
    }

    const orphaned = toolUseIds.filter((toolUse) => !resolvedIds.has(toolUse.id));
    if (orphaned.length === 0) continue;
    const synthetics: AgentMessage[] = orphaned.map((toolUse) => ({
      role: "toolResult" as const,
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content: [{ type: "text" as const, text: "[Interrupted by context travel]" }],
      timestamp: Date.now(),
      isError: true,
    }));
    result.splice(index + 1, 0, ...synthetics);
    index += synthetics.length;
  }

  return result;
}
