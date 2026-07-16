import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  buildLabelMaps,
  calculateUsageDelta,
  classifyStructuralMessageDirection,
  countActiveSummaryDepth,
  estimateUsageAfterMessageChange,
  estimateUsageAtTravelTarget,
  findInTree,
  formatContextUsage,
  formatEntryLabels,
  HANDOFF_SLOT_HINT,
  isReservedTargetName,
  isValidEntryId,
  resolveTargetId,
  sanitizeTerminalText,
  validateHandoffStructure,
} from "./lib.js";
import {
  buildSessionMessages,
  prevalidateBranchWithSummary,
  prevalidateCheckpointLabel,
  type CheckpointLabelConflict,
  type CheckpointLabelPrevalidation,
} from "./host-bridge.js";
import { findLastMeaningfulEntry } from "./entry-resolution.js";
import { executeTravelMutation } from "./travel-coordinator.js";
import {
  getLiveAgentSyncRecoveryGuidance,
  type AgentSessionSyncOutcome,
} from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";
import { attachAcmReceipt, readAcmReceipt } from "./tool-receipt.js";

interface TravelSummaryDetails {
  kind: "acm_travel";
  originId: string;
  originLabel?: string;
  target: string;
  targetId: string;
  backupCurrentHeadAs?: string | null;
}

function formatBackupText(name: string | undefined, entryId: string | undefined, resolvedFromHead: string | undefined): string {
  if (!name || !entryId) return "none";
  return resolvedFromHead
    ? `${name}@${entryId} (resolved from HEAD ${resolvedFromHead})`
    : `${name}@${entryId}`;
}

function countContainingToolBatch(branch: SessionEntry[], toolCallId: string): number | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const toolCalls = entry.message.content.filter((part) => part.type === "toolCall");
    if (toolCalls.some((part) => part.id === toolCallId)) return toolCalls.length;
  }
  return null;
}

function formatNumericValue(value: number | null, fractionDigits = 0): string {
  return value === null || !Number.isFinite(value) ? "unknown" : value.toFixed(fractionDigits);
}

function formatSignedDelta(value: number | null, fractionDigits = 0, suffix = ""): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return `${value > 0 ? "+" : ""}${value.toFixed(fractionDigits)}${suffix}`;
}

export function registerTravelTool(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const schema = Type.Object({
    target: Type.String({ minLength: 1, maxLength: 256, description: "Checkpoint name, history node ID, or 'root'. Choose the last clean anchor before the named boundary, not the nearest or most conveniently named anchor. For a rebase, compare candidates from earliest to latest and choose the first that replaces obsolete active handoffs without growing projected summary depth and whose handoff passes cold start. Root is a candidate, not a default. Use acm_timeline checkpoints/search for comparison and tree only when ancestry or front ownership remains ambiguous." }),
    summary: Type.String({ minLength: 1, maxLength: 10000, description: `Authoritative handoff that becomes the working set after travel. A fresh agent must be able to execute NEXT from this handoff and direct evidence pointers without archived conversation. Fill every slot once and in order; write 'none' rather than omitting a category: ${HANDOFF_SLOT_HINT}. Preserve active and parked fronts, external effects, exclusions, and recovery pointers; pointers over process dumps. Max 10000 chars.` }),
    backupCurrentHeadAs: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$", description: "Optional semantic archive label for the raw path being folded away. The structural target keyword 'root' is reserved in every letter case. Use a unique name that makes the omitted boundary discoverable. This label creates recoverability; its spelling does not classify the travel, prove completion, select the target, or replace a cold-start handoff." })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "acm_travel",
    label: "ACM Travel",
    description: TOOL_DESCRIPTIONS.travel,
    promptSnippet: PROMPT_SNIPPETS.travel,
    promptGuidelines: [PROMPT_GUIDELINES.travel],
    parameters: schema,
    executionMode: "sequential",
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const backup = args.backupCurrentHeadAs ? ` · backup ${sanitizeTerminalText(args.backupCurrentHeadAs)}` : "";
      const target = sanitizeTerminalText(args.target ?? "…");
      const summaryLength = args.summary?.length ?? 0;
      component.setText(
        theme.fg("toolTitle", theme.bold("◆ ACM TRAVEL  "))
          + theme.fg("accent", `→ ${target}`)
          + theme.fg("dim", `${backup} · handoff ${summaryLength} chars`),
      );
      return component;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const raw = sanitizeTerminalText(result.content.find((item) => item.type === "text")?.text ?? "");
      const details = result.details as Record<string, unknown> | undefined;
      const receipt = readAcmReceipt(details);

      if (isPartial) {
        component.setText(theme.fg("warning", "◌ Applying recoverable context transition…"));
        return component;
      }

      if (receipt?.mutationState === "indeterminate") {
        component.setText(
          theme.fg("warning", "⚠ TRAVEL STATE INDETERMINATE")
            + (raw ? `\n${theme.fg("muted", raw.split("\n", 1)[0] ?? raw)}` : ""),
        );
        return component;
      }
      if (receipt?.mutationState === "not_applied" || (!receipt && typeof details?.error === "string")) {
        component.setText(
          theme.fg("error", "✕ TRAVEL NOT APPLIED")
            + (raw ? `\n${theme.fg("muted", raw.split("\n", 1)[0] ?? raw)}` : ""),
        );
        return component;
      }

      const target = sanitizeTerminalText(typeof details?.target === "string" ? details.target : "target");
      const leaf = sanitizeTerminalText(typeof details?.resultingLeafId === "string" ? details.resultingLeafId : "unknown leaf");
      const beforeTokens = typeof details?.usageBeforeTokens === "number" ? details.usageBeforeTokens : null;
      const afterTokens = typeof details?.estimatedUsageAfterTokens === "number" ? details.estimatedUsageAfterTokens : null;
      const tokenDelta = typeof details?.tokenDelta === "number" ? details.tokenDelta : null;
      const beforeMessages = typeof details?.structuralMessagesBefore === "number" ? details.structuralMessagesBefore : null;
      const afterMessages = typeof details?.structuralMessagesAfter === "number" ? details.structuralMessagesAfter : null;
      const direction = sanitizeTerminalText(typeof details?.structuralMessageDirection === "string" ? details.structuralMessageDirection : "unknown");
      const depthBefore = typeof details?.activeSummaryDepthBefore === "number" ? details.activeSummaryDepthBefore : null;
      const depthAfter = typeof details?.activeSummaryDepthAfter === "number" ? details.activeSummaryDepthAfter : null;
      const backup = sanitizeTerminalText(typeof details?.backupCurrentHeadAs === "string" ? details.backupCurrentHeadAs : "none");
      const liveSync = sanitizeTerminalText(typeof details?.liveAgentSessionSyncState === "string" ? details.liveAgentSessionSyncState : "unknown");
      const evidenceIncomplete = receipt?.outcome === "indeterminate";
      const title = evidenceIncomplete
        ? theme.fg("warning", "⚠ TRAVEL APPLIED · EVIDENCE INCOMPLETE")
        : theme.fg("success", "✓ TRAVEL APPLIED");
      const lines = [
        title + theme.fg("accent", `  ${target} → ${leaf}`),
        theme.fg("muted",
          `  context ${formatNumericValue(beforeTokens)} → ${formatNumericValue(afterTokens)} est.`
            + ` (${formatSignedDelta(tokenDelta)}) · messages ${formatNumericValue(beforeMessages)} → ${formatNumericValue(afterMessages)} (${direction})`,
        ),
        theme.fg("dim",
          `  summary depth ${formatNumericValue(depthBefore)} → ${formatNumericValue(depthAfter)}`
            + ` · backup ${backup} · working set ${receipt?.workingSetState ?? "replaced"} · live sync ${liveSync}`,
        ),
      ];
      if (evidenceIncomplete && raw) lines.push(theme.fg("warning", `  ${raw.split("\n", 1)[0] ?? raw}`));
      if (expanded && raw) {
        lines.push(theme.fg("dim", "  ─ full result ─"), theme.fg("toolOutput", raw));
      }
      component.setText(lines.join("\n"));
      return component;
    },
    async execute(
      toolCallId: string,
      rawParams: Static<typeof schema>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const result = (() => {
      const params = rawParams;
      if (params.backupCurrentHeadAs && isReservedTargetName(params.backupCurrentHeadAs)) {
        return {
          content: [{ type: "text" as const, text: `Error: Archive bookmark name '${params.backupCurrentHeadAs}' is reserved for the structural root target. Travel aborted before mutation.` }],
          details: { error: "reserved_backup_name", name: params.backupCurrentHeadAs },
        };
      }
      const handoffValidation = validateHandoffStructure(params.summary);
      if (!handoffValidation.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: handoff must contain each non-empty slot once and in order: ${HANDOFF_SLOT_HINT}. Travel aborted before mutation.` }],
          details: { error: "invalid_handoff", validation: handoffValidation },
        };
      }

      const containingToolCallCount = countContainingToolBatch(ctx.sessionManager.getBranch(), toolCallId);
      if (containingToolCallCount !== null && containingToolCallCount > 1) {
        return {
          content: [{ type: "text" as const, text: `Error: acm_travel must run alone in its assistant tool batch; found ${containingToolCallCount} tool calls in the containing assistant message. Travel aborted before mutation. Reissue acm_travel in a new assistant message without sibling tools.` }],
          details: { error: "mixed_tool_batch", toolCallId, toolCallCount: containingToolCallCount },
        };
      }

      const sessionManager = ctx.sessionManager;
      const tree = sessionManager.getTree();
      const branch = sessionManager.getBranch();
      const labelMaps = buildLabelMaps(sessionManager.getEntries());
      const branchIds = new Set(branch.map((entry: SessionEntry) => entry.id));
      const requestedRoot = params.target.toLowerCase() === "root";
      const resolvedBy = requestedRoot ? "root" : labelMaps.labelToEntryId.has(params.target) ? "checkpoint" : "entry_id";
      const resolved = resolveTargetId(sessionManager, tree, params.target, branchIds, labelMaps);
      const targetId = resolved.id;
      const targetIsStructuralRoot = tree[0]?.entry.id === targetId;
      if (requestedRoot && !isValidEntryId(targetId)) {
        return {
          content: [{ type: "text" as const, text: "Error: Cannot travel to root — session tree is empty." }],
          details: { error: "empty_session", requestedTarget: params.target },
        };
      }
      if (requestedRoot && tree.length > 1) {
        ctx.ui.notify(`Note: 'root' resolved to the first top-level node (${targetId}); this session has ${tree.length} top-level roots.`, "info");
      }
      if (!findInTree(tree, (node) => node.entry.id === targetId)) {
        const hint = " Use acm_timeline to choose the last clean node before the boundary you want to compress; raw node IDs are valid targets.";
        return {
          content: [{ type: "text" as const, text: `Error: Target '${params.target}' not found in session tree.${hint}` }],
          details: { error: "target_not_found", requestedTarget: params.target, resolvedTargetId: targetId },
        };
      }

      const currentLeaf = sessionManager.getLeafId();
      if (!currentLeaf) return { content: [{ type: "text" as const, text: "Error: No active leaf in session. Cannot travel." }], details: { error: "no_active_leaf" } };
      if (currentLeaf === targetId) {
        return {
          content: [{ type: "text" as const, text: `Already at target ${targetId}. Nothing to travel.` }],
          details: { error: "already_at_target", targetId, leafId: currentLeaf },
        };
      }
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "acm_travel aborted: signal was already aborted." }],
          details: { error: "aborted", target: params.target, targetId },
        };
      }
      if (resolved.fromOffPath) {
        ctx.ui.notify(`Note: '${params.target}' resolved from an off-path branch (not the active path). Traveling to off-path anchors may restore raw history and increase context.`, "info");
      }

      const originId = currentLeaf;
      const originLabel = formatEntryLabels(labelMaps, originId);
      const usageBeforeRaw = ctx.getContextUsage();
      const usageBefore = usageBeforeRaw && usageBeforeRaw.tokens != null && usageBeforeRaw.percent != null
        ? { tokens: usageBeforeRaw.tokens, contextWindow: usageBeforeRaw.contextWindow, percent: usageBeforeRaw.percent }
        : undefined;
      const usageBeforeText = formatContextUsage(usageBefore, true);
      const currentMessagesResult = buildSessionMessages(sessionManager);
      if (!currentMessagesResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: cannot build current session messages: ${currentMessagesResult.message}. Travel aborted.` }],
          details: { error: "build_messages_failed", message: currentMessagesResult.message, target: params.target, targetId },
        };
      }
      const currentMessages = currentMessagesResult.value;
      const targetMessagesResult = buildSessionMessages(sessionManager, targetId);
      if (!targetMessagesResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: cannot build target session messages: ${targetMessagesResult.message}. Travel aborted.` }],
          details: { error: "build_messages_failed", message: targetMessagesResult.message, target: params.target, targetId },
        };
      }
      const estimatedUsagePreview = estimateUsageAtTravelTarget(
        usageBefore,
        currentMessages,
        targetMessagesResult.value,
        params.summary,
      );
      const estimatedPreviewText = formatContextUsage(estimatedUsagePreview, true);
      const messagesBefore = currentMessages.length;
      const activeSummaryDepthBefore = countActiveSummaryDepth(branch);
      const targetSummaryDepth = countActiveSummaryDepth(sessionManager.getBranch(targetId));

      let backupEntryId: string | undefined;
      let backupResolvedFromHead: string | undefined;
      let backupPrevalidation: CheckpointLabelPrevalidation | undefined;
      if (params.backupCurrentHeadAs) {
        const headResolve = findLastMeaningfulEntry(branch, signal);
        if (headResolve.aborted) {
          return {
            content: [{ type: "text" as const, text: "acm_travel aborted during backup target resolution." }],
            details: { error: "aborted", target: params.target, targetId },
          };
        }
        backupEntryId = headResolve.entryId ?? undefined;
        if (!backupEntryId) {
          return {
            content: [{ type: "text" as const, text: `Error: archive bookmark backupCurrentHeadAs '${params.backupCurrentHeadAs}' could not be placed — no meaningful USER/AI message found near HEAD. Travel aborted.` }],
            details: { error: "no_meaningful_backup_target", name: params.backupCurrentHeadAs, headId: originId },
          };
        }
        if (backupEntryId !== originId) {
          backupResolvedFromHead = originId;
          ctx.ui.notify(`Note: backupCurrentHeadAs '${params.backupCurrentHeadAs}' placed on ${backupEntryId} (${headResolve.role ?? "message"}) instead of HEAD ${originId} (tool/internal traffic).`, "info");
        }
      }

      const branchPrevalidation = prevalidateBranchWithSummary(sessionManager, targetId);
      if (!branchPrevalidation.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: travel host prevalidation failed: ${branchPrevalidation.message}. No mutation was attempted. ${RECOVERY_GUIDANCE.hostCapability}` }],
          details: {
            error: "branch_prevalidation_failed",
            hostError: branchPrevalidation.error,
            message: branchPrevalidation.message,
            target: params.target,
            targetId,
          },
        };
      }

      if (params.backupCurrentHeadAs && backupEntryId) {
        const backupCheck = prevalidateCheckpointLabel(sessionManager, backupEntryId, params.backupCurrentHeadAs);
        if (!backupCheck.ok) {
          if (backupCheck.error === "label_conflict") {
            const conflict = backupCheck.details as CheckpointLabelConflict;
            const existing = `${conflict.entryId}${conflict.onActivePath ? " (on-path)" : " (off-path)"}`;
            return {
              content: [{ type: "text" as const, text: `Error: archive bookmark name '${params.backupCurrentHeadAs}' already exists at ${existing}. ${RECOVERY_GUIDANCE.nameCollision}` }],
              details: { error: "duplicate_backup_name", name: params.backupCurrentHeadAs, owner: conflict },
            };
          }
          return {
            content: [{ type: "text" as const, text: `Error: archive bookmark '${params.backupCurrentHeadAs}' failed prevalidation: ${backupCheck.message}. No mutation was attempted. ${RECOVERY_GUIDANCE.hostCapability}` }],
            details: { error: "backup_prevalidation_failed", name: params.backupCurrentHeadAs, message: backupCheck.message, recoveryAction: RECOVERY_GUIDANCE.hostCapability },
          };
        }
        backupPrevalidation = backupCheck.value;
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "acm_travel aborted after prevalidation and before mutation." }],
          details: { error: "aborted", target: params.target, targetId },
        };
      }

      const travelDetails: TravelSummaryDetails = {
        kind: "acm_travel",
        originId,
        ...(originLabel === undefined ? {} : { originLabel }),
        target: params.target,
        targetId,
        backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
      };
      const mutation = executeTravelMutation({
        sessionManager,
        targetId,
        summary: params.summary,
        details: travelDetails,
        ...(params.backupCurrentHeadAs && backupEntryId && backupPrevalidation
          ? { backup: { targetId: backupEntryId, name: params.backupCurrentHeadAs, prevalidation: backupPrevalidation } }
          : {}),
      });

      if (!mutation.ok) {
        if (mutation.refreshRequired) runtime.scheduleRefresh(sessionManager, mutation.refreshLeafId);
        const backupRecoveryNode = backupEntryId ? `history node ${backupEntryId}` : "the reported history node";
        let recoveryAction: string;
        if (mutation.backupRollbackFailed || mutation.backupRollbackSkipped) {
          recoveryAction = mutation.remainingBackupLabelState === "present"
            ? (mutation.backupRollbackFailed ? RECOVERY_GUIDANCE.rollbackFailed : RECOVERY_GUIDANCE.rollbackSkipped)
            : mutation.remainingBackupLabelState === "unknown"
              ? `Backup alias presence could not be verified. Use ${backupRecoveryNode} as the recovery pointer and inspect the active leaf before retrying.`
              : `The backup alias is absent. Use ${backupRecoveryNode} as the recovery pointer and inspect the active leaf before retrying.`;
        } else if (mutation.branchState === "indeterminate") {
          recoveryAction = "Branch mutation cannot be excluded. Inspect the active leaf and reported summary entry before retrying.";
        } else {
          recoveryAction = mutation.backupRolledBack
            ? RECOVERY_GUIDANCE.branchRolledBack
            : RECOVERY_GUIDANCE.hostCapability;
        }
        let backupNote = "";
        if (mutation.backupRollbackFailed) {
          backupNote = mutation.remainingBackupLabelState === "present"
            ? ` Backup label '${params.backupCurrentHeadAs}' remains at ${backupEntryId}; rollback failed.`
            : mutation.remainingBackupLabelState === "unknown"
              ? ` Backup label '${params.backupCurrentHeadAs}' may remain; rollback failed and label verification was unavailable.`
              : ` Rollback failed, but backup label '${params.backupCurrentHeadAs}' is not currently present.`;
        } else if (mutation.backupRollbackSkipped && mutation.backupRollbackSkipReason === "branch_mutation_observed") {
          backupNote = mutation.remainingBackupLabelState === "present"
            ? ` Backup label '${params.backupCurrentHeadAs}' remains because branch mutation was observed or cannot be excluded.`
            : mutation.remainingBackupLabelState === "unknown"
              ? ` Backup label '${params.backupCurrentHeadAs}' may remain because branch mutation was observed and label verification was unavailable.`
              : ` Backup label '${params.backupCurrentHeadAs}' is not currently present; preserve ${backupRecoveryNode} instead.`;
        } else if (mutation.backupRollbackSkipped) {
          backupNote = ` Backup label '${params.backupCurrentHeadAs}' may remain because its mutation state is indeterminate.`;
        } else if (mutation.backupRolledBack) {
          backupNote = ` Backup label '${params.backupCurrentHeadAs}' was rolled back.`;
        }
        const refreshNote = mutation.refreshRequired ? ` ${RECOVERY_GUIDANCE.refreshPending}` : "";
        const prefix = mutation.error === "backup_label_failed"
          ? `Error: archive bookmark '${params.backupCurrentHeadAs}' could not be set`
          : "Error: branchWithSummary failed";
        const liveAgentSessionSync: AgentSessionSyncOutcome = {
          status: "skipped",
          reason: "branch_not_applied",
          message: "Live AgentSession synchronization was not scheduled because travel did not definitively succeed",
        };
        return {
          content: [{ type: "text" as const, text: `${prefix}: ${mutation.message}.${backupNote} ${recoveryAction}${refreshNote}` }],
          details: {
            error: mutation.error,
            hostError: mutation.hostError,
            branchState: mutation.branchState,
            branchFailure: mutation.branchFailure,
            backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
            backupEntryId,
            backupOutcome: mutation.backupOutcome,
            backupLabelWritten: mutation.backupOutcome === "created",
            backupRolledBack: mutation.backupRolledBack,
            backupRollbackFailed: mutation.backupRollbackFailed,
            backupRollbackSkipped: mutation.backupRollbackSkipped,
            backupRollbackSkipReason: mutation.backupRollbackSkipReason,
            remainingBackupLabel: mutation.remainingBackupLabel,
            remainingBackupLabelState: mutation.remainingBackupLabelState,
            contextRefreshPending: mutation.refreshRequired,
            contextRefreshState: mutation.refreshRequired ? "pending" : "not_scheduled",
            liveAgentSessionSyncState: "skipped",
            liveAgentSessionSync,
            recoveryAction,
          },
        };
      }

      runtime.resetContextUsageNudgeCycle(sessionManager);
      const summaryEntryId = mutation.summaryEntryId;
      const resultingLeafId = mutation.resultingLeafId;
      const activeSummaryDepthAfter = countActiveSummaryDepth(sessionManager.getBranch());
      const activeSummaryDepthDelta = activeSummaryDepthAfter - activeSummaryDepthBefore;
      runtime.scheduleRefresh(sessionManager, summaryEntryId);
      const liveAgentSessionSync = runtime.scheduleLiveAgentSync(
        sessionManager,
        toolCallId,
        resultingLeafId,
      );
      const liveAgentSessionSyncRecovery = getLiveAgentSyncRecoveryGuidance(liveAgentSessionSync);
      const afterMessagesResult = buildSessionMessages(sessionManager);
      if (!afterMessagesResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Travel mutation completed, but session-message evidence is unavailable: ${afterMessagesResult.message}. ${RECOVERY_GUIDANCE.refreshPending}${liveAgentSessionSyncRecovery ? ` ${liveAgentSessionSyncRecovery}` : ""}` }],
          details: {
            error: "build_messages_failed",
            message: afterMessagesResult.message,
            target: params.target,
            targetId,
            originId,
            summaryEntryId,
            resultingLeafId,
            activeSummaryDepthBefore,
            activeSummaryDepthAfter,
            activeSummaryDepthDelta,
            contextRefreshPending: true,
            liveAgentSessionSyncState: liveAgentSessionSync.status,
            liveAgentSessionSync,
            recoveryAction: RECOVERY_GUIDANCE.refreshPending,
          },
        };
      }

      const afterMessages = afterMessagesResult.value;
      const messagesAfter = afterMessages.length;
      const estimatedUsageAfter = estimateUsageAfterMessageChange(usageBefore, currentMessages, afterMessages);
      const estimatedUsageAfterText = formatContextUsage(estimatedUsageAfter, true);
      const usageDelta = calculateUsageDelta(usageBefore, estimatedUsageAfter);
      const structuralMessageDelta = messagesAfter - messagesBefore;
      const structuralMessageDirection = classifyStructuralMessageDirection(messagesBefore, messagesAfter);
      const backupText = formatBackupText(params.backupCurrentHeadAs, backupEntryId, backupResolvedFromHead);
      const backupOutcome = mutation.backupOutcome;
      const messageDelta = `${messagesBefore} → ${messagesAfter} (${formatSignedDelta(structuralMessageDelta)}, ${structuralMessageDirection})`;
      const usageBeforeTokens = usageBefore?.tokens ?? null;
      const usageBeforePercent = usageBefore?.percent ?? null;
      const usageContextWindow = usageBefore?.contextWindow ?? estimatedUsageAfter?.contextWindow ?? null;
      const estimatedUsageAfterTokens = estimatedUsageAfter?.tokens ?? null;
      const estimatedUsageAfterPercent = estimatedUsageAfter?.percent ?? null;
      const usageBeforePercentText = usageBeforePercent === null ? "unknown" : `${usageBeforePercent.toFixed(1)}%`;
      const estimatedUsageAfterPercentText = estimatedUsageAfterPercent === null ? "unknown" : `${estimatedUsageAfterPercent.toFixed(1)}%`;
      const nextCue = GUIDANCE_CUES.travel;
      const summaryDepthNote = targetIsStructuralRoot
        && activeSummaryDepthBefore > targetSummaryDepth
        && activeSummaryDepthAfter === targetSummaryDepth + 1
        ? `Root rebase replaced prior active handoff layers with one new handoff; resulting summary depth is ${targetSummaryDepth + 1} rather than ${targetSummaryDepth}.`
        : null;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Travel applied. target=${params.target} (${targetId}); origin=${originLabel ? `${originLabel}@${originId}` : originId}; summaryEntryId=${summaryEntryId}; resultingLeafId=${resultingLeafId}; backup=${backupText} (${backupOutcome}); contextTokens=${formatNumericValue(usageBeforeTokens)} → ${formatNumericValue(estimatedUsageAfterTokens)} est. (delta=${formatSignedDelta(usageDelta.tokenDelta)}); contextPercent=${usageBeforePercentText} → ${estimatedUsageAfterPercentText} est. (delta=${formatSignedDelta(usageDelta.percentagePointDelta, 1, " pp")}); sessionMessages=${messageDelta}; summaryDepth=${activeSummaryDepthBefore} → ${activeSummaryDepthAfter} (delta=${formatSignedDelta(activeSummaryDepthDelta)}); contextRefresh=pending; liveAgentSessionSync=${liveAgentSessionSync.status}.`,
            summaryDepthNote,
            liveAgentSessionSyncRecovery,
            resolved.fromOffPath ? RECOVERY_GUIDANCE.restoredHistory : null,
            nextCue,
          ].filter((line): line is string => line !== null).join("\n"),
        }],
        details: {
          target: params.target,
          targetId,
          resolvedBy,
          resolvedEntryId: targetId,
          rootCount: requestedRoot ? tree.length : null,
          originId,
          originLabel,
          hasBackup: !!params.backupCurrentHeadAs,
          backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
          backupEntryId,
          backupResolvedFromHead,
          backupOutcome,
          usageBefore: usageBeforeText,
          usageAfter: "pending_next_context_event",
          estimatedUsagePreview: estimatedPreviewText,
          estimatedUsageAfter: estimatedUsageAfterText,
          usageBeforeTokens,
          usageBeforePercent,
          usageContextWindow,
          estimatedUsageAfterTokens,
          estimatedUsageAfterPercent,
          tokenDelta: usageDelta.tokenDelta,
          percentagePointDelta: usageDelta.percentagePointDelta,
          structuralMessagesBefore: messagesBefore,
          structuralMessagesAfter: messagesAfter,
          structuralMessageDelta,
          structuralMessageDirection,
          activeSummaryDepthBefore,
          activeSummaryDepthAfter,
          activeSummaryDepthDelta,
          targetSummaryDepth,
          targetIsStructuralRoot,
          summaryDepthNote,
          sessionMessages: messageDelta,
          messagesBefore,
          messagesAfter,
          summaryEntryId,
          resultingLeafId,
          contextRefreshPending: true,
          contextRefreshState: "pending",
          liveAgentSessionSyncState: liveAgentSessionSync.status,
          liveAgentSessionSync,
          fromOffPath: resolved.fromOffPath,
        },
      };
      })();
      return attachAcmReceipt(toolCallId, "acm_travel", result);
    },
  });
}
