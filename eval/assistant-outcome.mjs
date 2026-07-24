function terminalAssistantMessage(events) {
  return [...events]
    .reverse()
    .find((event) => event?.type === "message_end" && event.message?.role === "assistant")
    ?.message ?? null;
}

function zeroUsage(usage) {
  if (!usage || typeof usage !== "object") return false;
  return ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
    .every((field) => Number(usage[field] ?? 0) === 0);
}

export function isProviderEmptyLengthMessage(message) {
  return message?.role === "assistant"
    && message.stopReason === "length"
    && Array.isArray(message.content)
    && message.content.length === 0
    && zeroUsage(message.usage);
}

export function findProviderEmptyLengthResponses(events) {
  const responses = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event?.type !== "message_end" || !isProviderEmptyLengthMessage(event.message)) continue;
    responses.push({
      eventIndex,
      responseId: event.message.responseId ?? null,
      provider: event.message.provider ?? null,
      model: event.message.model ?? null,
    });
  }
  return responses;
}

export function finalAssistantOutcome(events) {
  const message = terminalAssistantMessage(events);
  return message
    ? { stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ?? null }
    : { stopReason: null, errorMessage: null };
}

export function assertTurnCompleted(events) {
  const message = terminalAssistantMessage(events);
  if (!message) throw new Error("assistant turn failed: no terminal assistant message");
  if (isProviderEmptyLengthMessage(message)) {
    throw new Error(`assistant turn failed: provider_empty_length_response${message.responseId ? ` (${message.responseId})` : ""}`);
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(`assistant turn failed: ${message.errorMessage ?? message.stopReason}`);
  }
  return { stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ?? null };
}
