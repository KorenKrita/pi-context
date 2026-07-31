import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  ANCHOR_SEARCH_WINDOW,
  buildLabelMaps,
  calculateUsageDelta,
  classifyStructuralMessageDirection,
  countActiveSummaryDepth,
  estimateUsageAfterMessageChange,
  estimateUsageAtTravelTarget,
  findInTree,
  formatContextUsage,
  formatEntryLabel,
  isReservedTargetName,
  isValidEntryId,
  optionalString,
  resolveTargetId,
  sanitizeTerminalText,
} from "./lib.js";
import { buildCanonicalHandoff, deriveReturnTicketName, HandoffSchema, type HandoffWireInput } from "./handoff.js";
import { rebuildAcmContextPacket } from "./context-packet.js";
import {
  prevalidateBranchWithSummary,
  prevalidateCheckpointLabel,
  type CheckpointLabelConflict,
  type CheckpointLabelDisplacement,
  type CheckpointLabelPrevalidation,
} from "./host-bridge.js";
import {
  findContainingAssistantToolBatch,
  formatToolProtocolDefects,
  hasOpenUserTurnAtAssistant,
} from "./tool-protocol.js";
import { executeTravelMutation } from "./travel-coordinator.js";
import { buildTravelTargetFacts } from "./travel-target-facts.js";
import { getLiveAgentSyncRecoveryGuidance } from "./live-agent-session-adapter.js";
import type { AcmSessionRuntime } from "./runtime.js";
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";
import { appendLedgerRow, buildFoldRow, createLedgerState } from "./boundary-ledger.js";

/**
 * Entry kinds a fold can legitimately compress. A replacement range containing
 * only ACM's own bookkeeping (label journal entries, and the receipts of the
 * save point that was just created) compresses nothing the model produced.
 *
 * The test is structural, not numeric: FM-15's shape is "checkpoint, then
 * travel to it", where everything between target and leaf is the checkpoint's
 * own trace. One real message in that range makes the fold small, not empty,
 * and small folds stay the model's judgment.
 */
function isAcmBookkeepingEntry(entry: { readonly type?: string } | undefined): boolean {
  return entry?.type === "label";
}

interface TravelSummaryDetails {
  kind: "acm_travel";
  handoffVersion: 1;
  toolCallId: string;
  currentUserTurnOpen: boolean;
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
  const schema = Type.Object({
    target: Type.String({ minLength: 1, description: "Where to return to: checkpoint name, node ID, or 'root'. Pick the point immediately before the material being folded — the checkpoints view lists candidates with projected gains." }),
    handoff: HandoffSchema,
    backupCurrentHeadAs: Type.Optional(Type.String({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$", description: "Optional unique custom name for the automatic return ticket; 'root' is reserved. Omit to use the name derived from the handoff goal." })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "acm_travel",
    label: "ACM Travel",
    description: TOOL_DESCRIPTIONS.travel,
    promptSnippet: PROMPT_SNIPPETS.travel,
    promptGuidelines: PROMPT_GUIDELINES.travel.split("\n"),
    parameters: schema,
    executionMode: "sequential",
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const backupName = optionalString(args.backupCurrentHeadAs);
      const backup = backupName ? ` · backup ${sanitizeTerminalText(backupName)}` : "";
      const target = sanitizeTerminalText(optionalString(args.target) ?? "…");
      const handoffLength = typeof args.handoff === "string"
        ? args.handoff.length
        : args.handoff && typeof args.handoff === "object"
          ? Object.values(args.handoff).reduce((total, value) => total + (typeof value === "string" ? value.length : 0), 0)
          : 0;
      component.setText(
        theme.fg("toolTitle", theme.bold("◆ ACM TRAVEL  "))
          + theme.fg("accent", `→ ${target}`)
          + theme.fg("dim", `${backup} · field content ${handoffLength} chars`),
      );
      return component;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const raw = sanitizeTerminalText(result.content.find((item) => item.type === "text")?.text ?? "");
      const details = result.details as Record<string, unknown> | undefined;

      if (isPartial) {
        component.setText(theme.fg("warning", "◌ Applying recoverable context transition…"));
        return component;
      }

      if (typeof details?.error === "string") {
        component.setText(
          theme.fg("warning", "⚠ TRAVEL NEEDS ATTENTION")
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
      const delivery = sanitizeTerminalText(typeof details?.contextDeliveryPhase === "string" ? details.contextDeliveryPhase : "unknown");
      const evidenceStatus = sanitizeTerminalText(typeof details?.postMutationEvidenceStatus === "string" ? details.postMutationEvidenceStatus : "verified");
      const lines = [
        theme.fg(evidenceStatus === "verified" ? "success" : "warning", evidenceStatus === "verified" ? "✓ TRAVEL COMPLETE" : "⚠ TRAVEL APPLIED — EVIDENCE PENDING")
          + theme.fg("accent", `  ${target} → ${leaf}`),
        theme.fg("muted",
          `  context ${formatNumericValue(beforeTokens)} → ${formatNumericValue(afterTokens)} est.`
            + ` (${formatSignedDelta(tokenDelta)}) · messages ${formatNumericValue(beforeMessages)} → ${formatNumericValue(afterMessages)} (${direction})`,
        ),
        theme.fg("dim",
          `  handoff layers ${formatNumericValue(depthBefore)} → ${formatNumericValue(depthAfter)}`
            + ` · backup ${backup} · delivery ${delivery} · evidence ${evidenceStatus} · persisted refresh pending`,
        ),
      ];
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
      const rawRecord = typeof rawParams === "object" && rawParams !== null
        ? rawParams as unknown as Record<string, unknown>
        : {};
      const paramDefects: string[] = [];
      const rawTarget = rawRecord.target;
      const target = optionalString(rawTarget) ?? "";
      if (!target) paramDefects.push("target:invalid_type_or_empty");
      const rawBackup = rawRecord.backupCurrentHeadAs;
      const backupCurrentHeadAs = optionalString(rawBackup);
      if (
        rawBackup !== undefined
        && rawBackup !== null
        && (backupCurrentHeadAs === undefined || !/^[A-Za-z0-9._-]+$/.test(backupCurrentHeadAs))
      ) {
        paramDefects.push("backupCurrentHeadAs:invalid_type_or_format");
      }
      for (const name of Object.keys(rawRecord)) {
        if (name !== "target" && name !== "handoff" && name !== "backupCurrentHeadAs") {
          paramDefects.push(`unexpected:${name}`);
        }
      }
      if (paramDefects.length > 0) {
        return {
          content: [{ type: "text" as const, text: `Error: acm_travel parameters are invalid: ${paramDefects.join(", ")}. Nothing was mutated.` }],
          details: { error: "invalid_params", defects: paramDefects },
        };
      }
      const params = {
        target,
        handoff: rawRecord.handoff as HandoffWireInput,
        ...(backupCurrentHeadAs === undefined ? {} : { backupCurrentHeadAs }),
      };
      if (params.backupCurrentHeadAs && isReservedTargetName(params.backupCurrentHeadAs)) {
        return {
          content: [{ type: "text" as const, text: `Error: Archive bookmark name '${params.backupCurrentHeadAs}' is reserved for the structural root target. Travel aborted before mutation.` }],
          details: { error: "reserved_backup_name", name: params.backupCurrentHeadAs },
        };
      }
      // First pass validates fields and exposes the goal; the canonical text is
      // rebuilt below once the return-ticket name is known.
      const handoffResult = buildCanonicalHandoff(params.handoff);
      if (!handoffResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: structured handoff is invalid: ${handoffResult.defects.map((defect) => `${defect.field}:${defect.reason}`).join(", ")}. Fix the named fields and reissue acm_travel; nothing was mutated.` }],
          details: { error: "invalid_handoff", defects: handoffResult.defects },
        };
      }
      let canonicalHandoff = handoffResult.value;

      const preTravelBranch = ctx.sessionManager.getBranch();
      const containingBatch = findContainingAssistantToolBatch(
        preTravelBranch,
        toolCallId,
      );
      const containingToolCallCount = containingBatch?.toolCallCount ?? null;
      const currentUserTurnOpen = containingBatch
        ? hasOpenUserTurnAtAssistant(preTravelBranch, containingBatch.entryIndex)
        : false;
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
      const targetNode = findInTree(tree, (node) => node.entry.id === targetId);
      if (!targetNode) {
        const hint = " Use acm_timeline to choose the last clean node before the material being folded; raw node IDs are valid targets.";
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
      const originLabel = formatEntryLabel(labelMaps, originId);
      const usageBeforeRaw = ctx.getContextUsage();
      const usageBefore = usageBeforeRaw && usageBeforeRaw.tokens != null && usageBeforeRaw.percent != null
        ? { tokens: usageBeforeRaw.tokens, contextWindow: usageBeforeRaw.contextWindow, percent: usageBeforeRaw.percent }
        : undefined;
      const usageBeforeText = formatContextUsage(usageBefore, true);
      const currentPacketResult = rebuildAcmContextPacket(sessionManager);
      if (!currentPacketResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: cannot build current session messages: ${currentPacketResult.message}. Travel aborted.` }],
          details: { error: "build_messages_failed", message: currentPacketResult.message, target: params.target, targetId },
        };
      }
      const currentPacket = currentPacketResult.value;
      if (currentPacket.protocol.status === "invalid") {
        return {
          content: [{
            type: "text" as const,
            text: `Error: current active session has invalid tool-call identity and cannot be traveled safely: ${formatToolProtocolDefects(currentPacket.protocol.defects) || "no defect details were supplied"}. Repair the current session protocol before retrying; nothing was mutated.`,
          }],
          details: {
            error: "current_protocol_invalid",
            target: params.target,
            targetId,
            originId,
            currentProtocolStatus: "invalid",
            defects: currentPacket.protocol.defects,
            contextRefreshPending: false,
            contextRefreshState: "not_scheduled",
            contextDeliveryPhase: "active",
          },
        };
      }
      const currentMessages = currentPacket.messages;
      const targetPacketResult = rebuildAcmContextPacket(sessionManager, targetId);
      if (!targetPacketResult.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: cannot build target session messages: ${targetPacketResult.message}. Travel aborted.` }],
          details: { error: "build_messages_failed", message: targetPacketResult.message, target: params.target, targetId },
        };
      }
      const targetBranch = sessionManager.getBranch(targetId);
      // FM-15 structural guard: a target that precedes nothing cannot fold
      // anything. The `currentLeaf === targetId` check above misses the common
      // shape — checkpoint, then travel to it — because the checkpoint's own
      // receipt advances the leaf by one, so the target sits exactly one entry
      // back and the only replaced content is that receipt. Rejection is
      // structural, never numeric: projections measure, boundaries decide, so a
      // real but small replacement range stays the model's call.
      const replacedEntryCount = branch.length - targetBranch.length;
      const replacedEntries = replacedEntryCount > 0 ? branch.slice(targetBranch.length) : [];
      // Off-path restore and rehydrate legitimately grow history, so a target
      // that replaces nothing is expected there; the guard applies to folds.
      const foldsOnlyBookkeeping = !resolved.fromOffPath
        && (replacedEntries.length === 0
          || replacedEntries.every((entry) => isAcmBookkeepingEntry(entry as { readonly type?: string })));
      if (foldsOnlyBookkeeping) {
        return {
          content: [{
            type: "text" as const,
            text: `Zero-distance travel refused: target ${targetId} precedes nothing foldable (${replacedEntryCount} replaceable entr${replacedEntryCount === 1 ? "y" : "ies"} on this spine, all produced by this call). A fold target must sit before the material being folded; a save point created just now sits after it. Choose the last clean node before that material — acm_timeline view search or checkpoints locates it — or continue without folding.`,
          }],
          details: {
            error: "zero_distance_travel",
            targetId,
            leafId: currentLeaf,
            replacedEntryCount,
            activeBranchEntries: branch.length,
            targetBranchEntries: targetBranch.length,
          },
        };
      }
      const targetAnalysis = buildTravelTargetFacts({
        targetId,
        targetEntry: targetNode.entry,
        targetBranch,
        protocol: {
          ...targetPacketResult.value.protocol,
          messages: targetPacketResult.value.messages,
        },
        fromOffPath: resolved.fromOffPath,
      });
      if (targetAnalysis.facts.protocolStatus === "invalid") {
        return {
          content: [{
            type: "text" as const,
            text: `Error: target '${params.target}' has invalid tool-call identity and cannot become a travel base. Choose a different checkpoint/node or repair the persisted session protocol; nothing was mutated.`,
          }],
          details: {
            error: "target_protocol_invalid",
            target: params.target,
            targetId,
            targetFacts: targetAnalysis.facts,
            targetWarnings: targetAnalysis.warnings,
          },
        };
      }
      let backupEntryId: string | undefined;
      let backupResolvedFromHead: string | undefined;
      let backupPrevalidation: CheckpointLabelPrevalidation | undefined;
      let backupProtocolNormalizations: typeof currentPacket.protocol.normalizations = [];
      // Every fold records a return ticket: the pre-travel head is always
      // labeled, with the explicit name when supplied, the head's existing
      // label when one is already there, or a name derived from the goal.
      {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "acm_travel aborted during backup target resolution." }],
            details: { error: "aborted", target: params.target, targetId },
          };
        }
        // Same anchoring rule as acm_checkpoint's automatic placement: walk
        // backward for the latest protocol-complete entry, skipping candidates
        // that would need repair, bounded by the shared search window.
        const startIndex = (containingBatch?.entryIndex ?? branch.length) - 1;
        for (let index = startIndex, inspected = 0; index >= 0 && inspected < ANCHOR_SEARCH_WINDOW; index--, inspected++) {
          if (signal?.aborted) break;
          const candidate = branch[index]!;
          const packet = rebuildAcmContextPacket(sessionManager, candidate.id);
          if (!packet.ok || packet.value.protocol.status !== "complete") continue;
          backupProtocolNormalizations = packet.value.protocol.normalizations;
          backupEntryId = candidate.id;
          break;
        }
        if (!backupEntryId) {
          return {
            content: [{ type: "text" as const, text: "Error: the return ticket could not be placed — no protocol-complete session prefix exists before this travel call. Finish or explicitly recover the interrupted tool batch, then retry; nothing was mutated." }],
            details: { error: "no_protocol_complete_backup_target", name: params.backupCurrentHeadAs ?? null, headId: originId },
          };
        }
        if (backupEntryId !== originId) {
          backupResolvedFromHead = originId;
          ctx.ui.notify(`Note: the return ticket was placed on protocol-complete entry ${backupEntryId} instead of HEAD ${originId}.`, "info");
        }
      }

      // Resolve the return-ticket name: explicit override, the head's existing
      // label (reused rather than displaced), or a slug derived from the goal.
      const headExistingLabel = backupEntryId ? labelMaps.entryToLabel.get(backupEntryId) : undefined;
      const returnTicketName = params.backupCurrentHeadAs
        ?? headExistingLabel
        ?? deriveReturnTicketName(canonicalHandoff.fields.goal, (name) => labelMaps.labelToEntryId.has(name) || isReservedTargetName(name));
      {
        const rebuilt = buildCanonicalHandoff(params.handoff, { rawArchiveAlias: returnTicketName });
        if (!rebuilt.ok) {
          return {
            content: [{ type: "text" as const, text: `Error: return ticket name '${returnTicketName}' is not a valid alias: ${rebuilt.defects.map((defect) => `${defect.field}:${defect.reason}`).join(", ")}. Nothing was mutated.` }],
            details: { error: "invalid_return_ticket", name: returnTicketName, defects: rebuilt.defects },
          };
        }
        canonicalHandoff = rebuilt.value;
      }
      const estimatedUsagePreview = estimateUsageAtTravelTarget(
        usageBefore,
        currentMessages,
        targetPacketResult.value.messages,
        canonicalHandoff.text,
      );
      const estimatedPreviewText = formatContextUsage(estimatedUsagePreview, true);
      const messagesBefore = currentMessages.length;
      const activeSummaryDepthBefore = countActiveSummaryDepth(branch);
      const targetSummaryDepth = countActiveSummaryDepth(targetBranch);

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

      if (backupEntryId) {
        const backupCheck = prevalidateCheckpointLabel(sessionManager, backupEntryId, returnTicketName);
        if (!backupCheck.ok) {
          if (backupCheck.error === "label_conflict") {
            const conflict = backupCheck.details as CheckpointLabelConflict;
            const existing = `${conflict.entryId}${conflict.onActivePath ? " (on-path)" : " (off-path)"}`;
            return {
              content: [{ type: "text" as const, text: `Error: return ticket name '${returnTicketName}' already exists at ${existing}. ${RECOVERY_GUIDANCE.nameCollision}` }],
              details: { error: "duplicate_backup_name", name: returnTicketName, owner: conflict },
            };
          }
          if (backupCheck.error === "label_displaces_existing") {
            const displaced = backupCheck.details as CheckpointLabelDisplacement;
            return {
              content: [{
                type: "text" as const,
                text: `Error: return ticket '${returnTicketName}' would replace checkpoint '${displaced.existingLabel}' on the pre-travel entry ${displaced.targetId}, because the host keeps one label per entry. No mutation was attempted. Retry with backupCurrentHeadAs omitted to reuse '${displaced.existingLabel}', or move it first.`,
              }],
              details: {
                error: "backup_displaces_existing_label",
                name: returnTicketName,
                candidateId: displaced.targetId,
                existingLabel: displaced.existingLabel,
              },
            };
          }
          return {
            content: [{ type: "text" as const, text: `Error: return ticket '${returnTicketName}' failed prevalidation: ${backupCheck.message}. No mutation was attempted. ${RECOVERY_GUIDANCE.hostCapability}` }],
            details: { error: "backup_prevalidation_failed", name: returnTicketName, message: backupCheck.message, recoveryAction: RECOVERY_GUIDANCE.hostCapability },
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
        handoffVersion: 1,
        toolCallId,
        currentUserTurnOpen,
        originId,
        ...(originLabel === undefined ? {} : { originLabel }),
        target: params.target,
        targetId,
        backupCurrentHeadAs: returnTicketName,
      };
      const mutation = executeTravelMutation({
        sessionManager,
        targetId,
        summary: canonicalHandoff.text,
        details: travelDetails,
        ...(backupEntryId && backupPrevalidation
          ? { backup: { targetId: backupEntryId, name: returnTicketName, prevalidation: backupPrevalidation } }
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
            ? ` Backup label '${returnTicketName}' remains at ${backupEntryId}; rollback failed.`
            : mutation.remainingBackupLabelState === "unknown"
              ? ` Backup label '${returnTicketName}' may remain; rollback failed and label verification was unavailable.`
              : ` Rollback failed, but backup label '${returnTicketName}' is not currently present.`;
        } else if (mutation.backupRollbackSkipped && mutation.backupRollbackSkipReason === "branch_mutation_observed") {
          backupNote = mutation.remainingBackupLabelState === "present"
            ? ` Backup label '${returnTicketName}' remains because branch mutation was observed or cannot be excluded.`
            : mutation.remainingBackupLabelState === "unknown"
              ? ` Backup label '${returnTicketName}' may remain because branch mutation was observed and label verification was unavailable.`
              : ` Backup label '${returnTicketName}' is not currently present; preserve ${backupRecoveryNode} instead.`;
        } else if (mutation.backupRollbackSkipped) {
          backupNote = ` Backup label '${returnTicketName}' may remain because its mutation state is indeterminate.`;
        } else if (mutation.backupRolledBack) {
          backupNote = ` Backup label '${returnTicketName}' was rolled back.`;
        }
        const refreshNote = mutation.refreshRequired ? ` ${RECOVERY_GUIDANCE.refreshPending}` : "";
        const prefix = mutation.error === "backup_label_failed"
          ? `Error: return ticket '${returnTicketName}' could not be set`
          : "Error: branchWithSummary failed";
        return {
          content: [{ type: "text" as const, text: `${prefix}: ${mutation.message}.${backupNote} ${recoveryAction}${refreshNote}` }],
          details: {
            error: mutation.error,
            hostError: mutation.hostError,
            branchState: mutation.branchState,
            branchFailure: mutation.branchFailure,
            backupCurrentHeadAs: returnTicketName,
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
            contextDeliveryPhase: "active",
            recoveryAction,
            targetFacts: targetAnalysis.facts,
            targetWarnings: targetAnalysis.warnings,
          },
        };
      }

      runtime.resetGaugeCycle(sessionManager);
      const summaryEntryId = mutation.summaryEntryId;
      const resultingLeafId = mutation.resultingLeafId;
      // The mutation is already durable. Establish both refresh tickets before
      // any diagnostic read that may fail, so an applied travel can never fall
      // back into an untracked split-brain state.
      const liveAgentSessionSync = runtime.deferPostTravelRefresh(
        sessionManager,
        toolCallId,
        resultingLeafId,
      );
      const providerDelivery = runtime.getProviderDeliveryStatus(sessionManager);
      const liveAgentSessionSyncRecovery = getLiveAgentSyncRecoveryGuidance(liveAgentSessionSync);
      let activeSummaryDepthAfter = targetSummaryDepth + 1;
      let postMutationDiagnosticWarning: string | undefined;
      try {
        activeSummaryDepthAfter = countActiveSummaryDepth(sessionManager.getBranch());
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        postMutationDiagnosticWarning = `Handoff layer count could not be read after the applied mutation: ${cause}`;
      }
      const activeSummaryDepthDelta = activeSummaryDepthAfter - activeSummaryDepthBefore;
      const afterPacketResult = rebuildAcmContextPacket(sessionManager);
      const postMutationEvidence = postMutationDiagnosticWarning
        ? {
            status: "unavailable" as const,
            warning: postMutationDiagnosticWarning,
          }
        : !afterPacketResult.ok
          ? {
              status: "unavailable" as const,
              warning: `Session-message evidence could not be rebuilt after the applied mutation: ${afterPacketResult.message}`,
            }
          : afterPacketResult.value.protocol.status === "invalid"
            ? {
                status: "invalid_protocol" as const,
                warning: `Session-message evidence has invalid tool protocol: ${formatToolProtocolDefects(afterPacketResult.value.protocol.defects) || "no defect details were supplied"}`,
                defects: afterPacketResult.value.protocol.defects,
              }
            : { status: "verified" as const };
      if (postMutationEvidence.status !== "verified") {
        return {
          content: [{
            type: "text" as const,
            text: [
              `Travel complete. target=${params.target} (${targetId}); summaryEntryId=${summaryEntryId}; resultingLeafId=${resultingLeafId}; persistentMutation=applied; providerDelivery=${providerDelivery.phase}; providerPacket=none; nativeReplacement=${liveAgentSessionSync.status}.`,
              `Post-mutation evidence warning: ${postMutationEvidence.warning}.`,
              "The tree mutation is applied; persistent Context Packet refresh remains scheduled and will retry on a later LLM turn.",
              `Applied handoff NEXT: ${canonicalHandoff.fields.next}`,
              currentUserTurnOpen
                ? "Current user turn remains open: deliver the requested visible result before treating this turn as complete; State is not delivery."
                : null,
              liveAgentSessionSyncRecovery,
              GUIDANCE_CUES.travel,
            ].filter((line): line is string => line !== null).join("\n"),
          }],
          details: {
            mutationStatus: "applied",
            persistentMutationApplied: true,
            target: params.target,
            targetId,
            originId,
            summaryEntryId,
            resultingLeafId,
            activeSummaryDepthBefore,
            activeSummaryDepthAfter,
            activeSummaryDepthDelta,
            contextRefreshPending: true,
            contextRefreshState: "pending_tool_result",
            contextDeliveryPhase: "pending_tool_result",
            providerDeliveryPhase: providerDelivery.phase,
            providerPacketMessageCount: providerDelivery.packetMessageCount,
            providerPacketLeafId: providerDelivery.leafId,
            providerPacketError: providerDelivery.error,
            // Keep the raw adapter outcome available to callers that need to
            // distinguish native replacement capability from delivery phase.
            nativeContextReplacementState: liveAgentSessionSync.status,
            nativeContextReplacement: liveAgentSessionSync,
            // Compatibility aliases retained for existing integrations.
            liveAgentSessionSyncState: liveAgentSessionSync.status,
            liveAgentSessionSync,
            recoveryAction: RECOVERY_GUIDANCE.refreshPending,
            postMutationEvidenceStatus: postMutationEvidence.status,
            postMutationEvidenceWarning: postMutationEvidence.warning,
            ...(postMutationEvidence.status === "invalid_protocol"
              ? {
                  postMutationProtocolStatus: "invalid" as const,
                  postMutationProtocolDefects: postMutationEvidence.defects,
                }
              : {}),
            handoffFormat: "structured-v1",
            handoffNext: canonicalHandoff.fields.next,
            currentUserTurnOpen,
            targetFacts: targetAnalysis.facts,
            targetWarnings: targetAnalysis.warnings,
          },
        };
      }

      // The non-verified branches returned above. Keep this explicit guard so
      // future evidence variants cannot accidentally turn an applied receipt
      // back into a post-mutation tool error.
      if (!afterPacketResult.ok) throw new Error("unreachable post-mutation evidence state");
      const afterPacket = afterPacketResult.value;
      const afterMessages = afterPacket.messages;
      const messagesAfter = afterMessages.length;
      const estimatedUsageAfter = estimateUsageAfterMessageChange(usageBefore, currentMessages, afterMessages);
      const estimatedUsageAfterText = formatContextUsage(estimatedUsageAfter, true);
      const usageDelta = calculateUsageDelta(usageBefore, estimatedUsageAfter);
      const structuralMessageDelta = messagesAfter - messagesBefore;
      const structuralMessageDirection = classifyStructuralMessageDirection(messagesBefore, messagesAfter);
      const backupText = formatBackupText(returnTicketName, backupEntryId, backupResolvedFromHead);
      const backupOutcome = mutation.backupOutcome;
      const messageDelta = `${messagesBefore} → ${messagesAfter} (${formatSignedDelta(structuralMessageDelta)}, ${structuralMessageDirection})`;
      const usageBeforeTokens = usageBefore?.tokens ?? null;
      const usageBeforePercent = usageBefore?.percent ?? null;
      const usageContextWindow = usageBefore?.contextWindow ?? estimatedUsageAfter?.contextWindow ?? null;
      const estimatedUsageAfterTokens = estimatedUsageAfter?.tokens ?? null;
      const estimatedUsageAfterPercent = estimatedUsageAfter?.percent ?? null;
      const usageBeforePercentText = usageBeforePercent === null ? "unknown" : `${usageBeforePercent.toFixed(1)}%`;
      const estimatedUsageAfterPercentText = estimatedUsageAfterPercent === null ? "unknown" : `${estimatedUsageAfterPercent.toFixed(1)}%`;
      // Fold side of the passive ledger: one row per applied travel with the
      // delta the receipt already carries, so folds and boundaries accumulate
      // on the same yardstick. Swallowed on any failure.
      try {
        appendLedgerRow("fold", buildFoldRow({
          state: createLedgerState(`${process.pid}-travel`),
          budgetBefore: usageBeforePercent,
          budgetAfter: estimatedUsageAfter?.percent,
          messageDelta: currentMessages.length - afterMessages.length,
          summaryDepth: activeSummaryDepthAfter,
        }));
      } catch {
        // A diagnostic writer must never affect a travel receipt.
      }
      const nextCue = GUIDANCE_CUES.travel;
      const summaryDepthNote = targetIsStructuralRoot
        && activeSummaryDepthBefore > targetSummaryDepth
        && activeSummaryDepthAfter === targetSummaryDepth + 1
        ? `This fold to root replaced prior handoff layers with one new handoff; handoff layers are now ${targetSummaryDepth + 1} rather than ${targetSummaryDepth}.`
        : null;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Travel complete. target=${params.target} (${targetId}); origin=${originLabel ? `${originLabel}@${originId}` : originId}; summaryEntryId=${summaryEntryId}; resultingLeafId=${resultingLeafId}; backup=${backupText} (${backupOutcome}); contextTokens=${formatNumericValue(usageBeforeTokens)} → ${formatNumericValue(estimatedUsageAfterTokens)} est. (delta=${formatSignedDelta(usageDelta.tokenDelta)}); contextPercent=${usageBeforePercentText} → ${estimatedUsageAfterPercentText} est. (delta=${formatSignedDelta(usageDelta.percentagePointDelta, 1, " pp")}); sessionMessages=${messageDelta}; handoffLayers=${activeSummaryDepthBefore} → ${activeSummaryDepthAfter} (delta=${formatSignedDelta(activeSummaryDepthDelta)}); persistentMutation=applied; providerDelivery=${providerDelivery.phase}; providerPacket=none; nativeReplacement=${liveAgentSessionSync.status}.`,
            summaryDepthNote,
            liveAgentSessionSyncRecovery,
            resolved.fromOffPath ? RECOVERY_GUIDANCE.restoredHistory : null,
            targetAnalysis.warnings.length > 0
              ? `Target warnings: ${targetAnalysis.warnings.join(", ")}. These are structural facts, not an automatic semantic verdict.`
              : null,
            `Applied handoff NEXT: ${canonicalHandoff.fields.next}`,
            currentUserTurnOpen
              ? "Current user turn remains open: deliver the requested visible result before treating this turn as complete; State is not delivery."
              : null,
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
          hasBackup: true,
          backupCurrentHeadAs: returnTicketName,
          backupEntryId,
          backupResolvedFromHead,
          backupOutcome,
          backupProtocolStatus: "complete",
          backupProtocolNormalizations,
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
          contextRefreshState: "pending_tool_result",
          contextDeliveryPhase: "pending_tool_result",
          providerDeliveryPhase: providerDelivery.phase,
          providerPacketMessageCount: providerDelivery.packetMessageCount,
          providerPacketLeafId: providerDelivery.leafId,
          providerPacketError: providerDelivery.error,
          // Native replacement is scheduled independently from when the
          // persisted Context Packet becomes deliverable to the model.
          nativeContextReplacementState: liveAgentSessionSync.status,
          nativeContextReplacement: liveAgentSessionSync,
          // Compatibility aliases retained for existing integrations.
          liveAgentSessionSyncState: liveAgentSessionSync.status,
          liveAgentSessionSync,
          mutationStatus: "applied",
          persistentMutationApplied: true,
          postMutationEvidenceStatus: "verified",
          postMutationProtocolStatus: afterPacket.protocol.status,
          postMutationProtocolNormalizations: afterPacket.protocol.normalizations,
          postMutationProtocolRepairs: afterPacket.protocol.repairs,
          postMutationProtocolDefects: afterPacket.protocol.defects,
          fromOffPath: resolved.fromOffPath,
          targetFacts: targetAnalysis.facts,
          targetWarnings: targetAnalysis.warnings,
          handoffFormat: "structured-v1",
          canonicalHandoffLength: canonicalHandoff.text.length,
          handoffNext: canonicalHandoff.fields.next,
          currentUserTurnOpen,
        },
      };
    },
  });
}
