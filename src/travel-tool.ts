import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
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
  isValidEntryId,
  resolveTargetId,
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
import { GUIDANCE_CUES, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";

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

function formatNumericValue(value: number | null, fractionDigits = 0): string {
  return value === null || !Number.isFinite(value) ? "unknown" : value.toFixed(fractionDigits);
}

function formatSignedDelta(value: number | null, fractionDigits = 0, suffix = ""): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return `${value > 0 ? "+" : ""}${value.toFixed(fractionDigits)}${suffix}`;
}

export function registerTravelTool(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const registerTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0] & { strict?: boolean }) => pi.registerTool(tool);
  const schema = Type.Object({
    target: Type.String({ minLength: 1, maxLength: 256, description: "Checkpoint name, history node ID, or 'root'. For a local fold, choose a target before the named boundary. For a rebase, evaluate candidate bases from earliest to latest and choose the first whose target retires an active summary without growing projected depth and whose snapshot passes cold start; root is a candidate, not a default. On large trees use acm_timeline with view checkpoints or search; use view tree only when topology matters." }),
    summary: Type.String({ minLength: 1, maxLength: 10000, description: `Handoff summary — the working state after travel. It must make the next action executable without rereading the folded trail. A rebase snapshot must pass cold start: a fresh agent can execute NEXT from this handoff and direct evidence pointers without reading archived summaries. Fill every slot, write 'none' rather than dropping one: ${HANDOFF_SLOT_HINT}. Include recovery pointers; pointers over dumps. Max 10000 chars.` }),
    backupCurrentHeadAs: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$", description: "Optional archive bookmark for the raw path being folded away. At task end, use '<task>-done' when the preview shows meaningful structural saving and the path does not already carry a suitable '-done' checkpoint. If the preview shows almost no saving, create a unique '-done' checkpoint and answer directly instead of calling travel merely to set this field. This is a recovery pointer, never the travel target or a substitute for a self-contained handoff." })),
  }, { additionalProperties: false });

  registerTool({
    name: "acm_travel",
    label: "ACM Travel",
    description: TOOL_DESCRIPTIONS.travel,
    parameters: schema,
    strict: false,
    async execute(
      toolCallId: string,
      rawParams: Static<typeof schema>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const params = rawParams;
      const handoffValidation = validateHandoffStructure(params.summary);
      if (!handoffValidation.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: handoff must contain each non-empty slot once and in order: ${HANDOFF_SLOT_HINT}. Travel aborted before mutation.` }],
          details: { error: "invalid_handoff", validation: handoffValidation },
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
        originLabel,
        target: params.target,
        targetId,
        backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
      };
      const mutation = executeTravelMutation({
        sessionManager,
        targetId,
        summary: params.summary,
        details: travelDetails,
        backup: params.backupCurrentHeadAs && backupEntryId && backupPrevalidation
          ? { targetId: backupEntryId, name: params.backupCurrentHeadAs, prevalidation: backupPrevalidation }
          : undefined,
      });

      if (!mutation.ok) {
        if (mutation.refreshRequired) runtime.scheduleRefresh(sessionManager, mutation.refreshLeafId);
        const recoveryAction = mutation.backupRollbackFailed
          ? RECOVERY_GUIDANCE.rollbackFailed
          : mutation.backupRollbackSkipped || mutation.branchState === "indeterminate"
            ? RECOVERY_GUIDANCE.rollbackSkipped
            : mutation.backupRolledBack
              ? RECOVERY_GUIDANCE.branchRolledBack
              : RECOVERY_GUIDANCE.hostCapability;
        const backupNote = mutation.backupRollbackFailed
          ? ` Backup label '${params.backupCurrentHeadAs}' remains at ${backupEntryId}; rollback failed.`
          : mutation.backupRollbackSkipped && mutation.backupRollbackSkipReason === "branch_mutation_observed"
            ? ` Backup label '${params.backupCurrentHeadAs}' remains because branch mutation was observed or cannot be excluded.`
            : mutation.backupRollbackSkipped
              ? ` Backup label '${params.backupCurrentHeadAs}' may remain because its mutation state is indeterminate.`
              : mutation.backupRolledBack
                ? ` Backup label '${params.backupCurrentHeadAs}' was rolled back.`
                : "";
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
      const nextCue = params.backupCurrentHeadAs?.endsWith("-done") ? GUIDANCE_CUES.travelTask : GUIDANCE_CUES.travelPhase;
      const summaryDepthNote = targetIsStructuralRoot
        && activeSummaryDepthBefore > targetSummaryDepth
        && activeSummaryDepthAfter === targetSummaryDepth + 1
        ? `Root rebase replaced prior active handoff layers with one new handoff; resulting summary depth is ${targetSummaryDepth + 1} rather than ${targetSummaryDepth}.`
        : null;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Travel complete. target=${params.target} (${targetId}); origin=${originLabel ? `${originLabel}@${originId}` : originId}; summaryEntryId=${summaryEntryId}; resultingLeafId=${resultingLeafId}; backup=${backupText} (${backupOutcome}); contextTokens=${formatNumericValue(usageBeforeTokens)} → ${formatNumericValue(estimatedUsageAfterTokens)} est. (delta=${formatSignedDelta(usageDelta.tokenDelta)}); contextPercent=${usageBeforePercentText} → ${estimatedUsageAfterPercentText} est. (delta=${formatSignedDelta(usageDelta.percentagePointDelta, 1, " pp")}); sessionMessages=${messageDelta}; summaryDepth=${activeSummaryDepthBefore} → ${activeSummaryDepthAfter} (delta=${formatSignedDelta(activeSummaryDepthDelta)}); contextRefresh=pending; liveAgentSessionSync=${liveAgentSessionSync.status}.`,
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
    },
  });
}
