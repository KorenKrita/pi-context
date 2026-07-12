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

    const existingResults = new Map<string, AgentMessage>();
    let followingIndex = index + 1;
    while (followingIndex < result.length && result[followingIndex].role === "toolResult") {
      const following = result[followingIndex];
      if (following.role === "toolResult" && following.toolCallId && !existingResults.has(following.toolCallId)) {
        existingResults.set(following.toolCallId, following);
      }
      followingIndex++;
    }

    const orphaned = toolUseIds.filter((toolUse) => !existingResults.has(toolUse.id));
    if (orphaned.length === 0) continue;
    const repairedResults: AgentMessage[] = toolUseIds.map((toolUse) => existingResults.get(toolUse.id) ?? ({
      role: "toolResult" as const,
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content: [{ type: "text" as const, text: "[Interrupted by context travel]" }],
      timestamp: Date.now(),
      isError: true,
    }));
    result.splice(index + 1, followingIndex - index - 1, ...repairedResults);
    index += repairedResults.length;
  }

  return result;
}
