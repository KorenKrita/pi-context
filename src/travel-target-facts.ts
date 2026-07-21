import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolProtocolAnalysis } from "./tool-protocol.js";
import { hasOpenLatestUserTurn } from "./tool-protocol.js";

export type TravelTargetWarning =
  | "target_packet_repaired"
  | "target_prefix_open_user_turn"
  | "target_is_assistant_tool_batch"
  | "target_is_branch_summary"
  | "target_from_off_path";

export interface TravelTargetFacts {
  targetId: string;
  targetEntryType: SessionEntry["type"] | "missing";
  targetRole: string | null;
  targetStopReason: string | null;
  targetAssistantHasToolCalls: boolean;
  targetAssistantHasVisibleText: boolean;
  targetIsBranchSummary: boolean;
  survivingLatestUserTurnOpen: boolean;
  protocolStatus: ToolProtocolAnalysis["status"];
  protocolRepairs: ToolProtocolAnalysis["repairs"];
  protocolDefects: ToolProtocolAnalysis["defects"];
  fromOffPath: boolean;
}

function assistantFacts(entry: SessionEntry | undefined) {
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    return { role: entry?.type === "message" ? entry.message.role : null, stopReason: null, hasToolCalls: false, hasVisibleText: false };
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  return {
    role: "assistant",
    stopReason: entry.message.stopReason ?? null,
    hasToolCalls: content.some((block) => block.type === "toolCall"),
    hasVisibleText: content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0),
  };
}

export function buildTravelTargetFacts(input: {
  targetId: string;
  targetEntry: SessionEntry | undefined;
  targetBranch: readonly SessionEntry[];
  protocol: ToolProtocolAnalysis;
  fromOffPath: boolean;
}): { facts: TravelTargetFacts; warnings: TravelTargetWarning[] } {
  const assistant = assistantFacts(input.targetEntry);
  const facts: TravelTargetFacts = {
    targetId: input.targetId,
    targetEntryType: input.targetEntry?.type ?? "missing",
    targetRole: assistant.role,
    targetStopReason: assistant.stopReason,
    targetAssistantHasToolCalls: assistant.hasToolCalls,
    targetAssistantHasVisibleText: assistant.hasVisibleText,
    targetIsBranchSummary: input.targetEntry?.type === "branch_summary",
    survivingLatestUserTurnOpen: hasOpenLatestUserTurn(input.targetBranch),
    protocolStatus: input.protocol.status,
    protocolRepairs: input.protocol.repairs,
    protocolDefects: input.protocol.defects,
    fromOffPath: input.fromOffPath,
  };
  const warnings: TravelTargetWarning[] = [];
  if (facts.protocolStatus === "repaired") warnings.push("target_packet_repaired");
  if (facts.survivingLatestUserTurnOpen) warnings.push("target_prefix_open_user_turn");
  if (facts.targetAssistantHasToolCalls) warnings.push("target_is_assistant_tool_batch");
  if (facts.targetIsBranchSummary) warnings.push("target_is_branch_summary");
  if (facts.fromOffPath) warnings.push("target_from_off_path");
  return { facts, warnings };
}
