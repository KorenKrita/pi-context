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
  formatEntryLabel,
  isReservedTargetName,
  isValidEntryId,
  optionalString,
  resolveTargetId,
  sanitizeTerminalText,
} from "./lib.js";
import { buildCanonicalHandoff, HandoffSchema, type HandoffWireInput } from "./handoff.js";
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
import { GUIDANCE_CUES, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";
import { appendLedgerRow, buildFoldRow, createLedgerState } from "./boundary-ledger.js";

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
    target: Type.String({ minLength: 1, description: "要回到的位置：存档名、节点 ID 或 'root'。选在待折内容【之前】的最后一个干净点。用 acm_timeline 的 checkpoints 或 search 视图找候选。" }),
    handoff: HandoffSchema,
    backupCurrentHeadAs: Type.Optional(Type.String({ minLength: 1, pattern: "^\\S+$", description: "可选：折叠前给当前位置起个新书签名，方便日后找回完整历史。必须是全新的唯一名字；不影响跳转目标。" })),
  }); // 多余参数忽略，不拒绝。

  pi.registerTool({
    name: "acm_travel",
    label: "ACM Travel",
    description: TOOL_DESCRIPTIONS.travel,
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
        component.setText(theme.fg("warning", "◌ 正在折叠…"));
        return component;
      }

      if (typeof details?.error === "string") {
        component.setText(
          theme.fg("warning", "⚠ 折叠需要关注")
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
        theme.fg(evidenceStatus === "verified" ? "success" : "warning", evidenceStatus === "verified" ? "✓ 折叠完成" : "⚠ 折叠已生效 — 证据待确认")
          + theme.fg("accent", `  ${target} → ${leaf}`),
        theme.fg("muted",
          `  context ${formatNumericValue(beforeTokens)} → ${formatNumericValue(afterTokens)} est.`
            + ` (${formatSignedDelta(tokenDelta)}) · messages ${formatNumericValue(beforeMessages)} → ${formatNumericValue(afterMessages)} (${direction})`,
        ),
        theme.fg("dim",
          `  summary depth ${formatNumericValue(depthBefore)} → ${formatNumericValue(depthAfter)}`
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
        && (backupCurrentHeadAs === undefined || !/^[^\s\p{Cc}]+$/u.test(backupCurrentHeadAs))
      ) {
        paramDefects.push("backupCurrentHeadAs:invalid_type_or_format");
      }
      // 多余顶层参数一律忽略：不给调用设门槛。
      if (paramDefects.length > 0) {
        return {
          content: [{ type: "text" as const, text: `错误：acm_travel 参数无效：${paramDefects.join(", ")}。没有做任何变更。` }],
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
          content: [{ type: "text" as const, text: `错误：书签名 '${params.backupCurrentHeadAs}' 是保留字（root 是结构目标）。折叠已在变更前中止。` }],
          details: { error: "reserved_backup_name", name: params.backupCurrentHeadAs },
        };
      }
      const handoffResult = buildCanonicalHandoff(params.handoff, {
        ...(params.backupCurrentHeadAs ? { rawArchiveAlias: params.backupCurrentHeadAs } : {}),
      });
      if (!handoffResult.ok) {
        return {
          content: [{ type: "text" as const, text: `错误：交接单无效：${handoffResult.defects.map((defect) => `${defect.field}:${defect.reason}`).join(", ")}。修复所列字段后重新调用 acm_travel；没有做任何变更。` }],
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
          content: [{ type: "text" as const, text: `错误：acm_travel 必须单独成批调用；当前 assistant 消息里有 ${containingToolCallCount} 个工具调用。折叠已在变更前中止。请在新的 assistant 消息里单独重发 acm_travel。` }],
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
          content: [{ type: "text" as const, text: "错误：会话树是空的，无法折叠到 root。" }],
          details: { error: "empty_session", requestedTarget: params.target },
        };
      }
      if (requestedRoot && tree.length > 1) {
        ctx.ui.notify(`Note: 'root' resolved to the first top-level node (${targetId}); this session has ${tree.length} top-level roots.`, "info");
      }
      const targetNode = findInTree(tree, (node) => node.entry.id === targetId);
      if (!targetNode) {
        const hint = " 用 acm_timeline 找待折内容之前最近的干净节点；节点 ID 也可以直接作目标。";
        return {
          content: [{ type: "text" as const, text: `错误：目标 '${params.target}' 在会话树里不存在。${hint}` }],
          details: { error: "target_not_found", requestedTarget: params.target, resolvedTargetId: targetId },
        };
      }

      const currentLeaf = sessionManager.getLeafId();
      if (!currentLeaf) return { content: [{ type: "text" as const, text: "错误：会话没有活动叶节点，无法折叠。" }], details: { error: "no_active_leaf" } };
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
      {
        // 交接单自动带回程票：Recover 写入折叠前叶节点（originId）。
        const withOrigin = buildCanonicalHandoff(params.handoff, {
          ...(params.backupCurrentHeadAs ? { rawArchiveAlias: params.backupCurrentHeadAs } : {}),
          originEntryId: originId,
        });
        if (withOrigin.ok) canonicalHandoff = withOrigin.value;
      }
      const usageBeforeRaw = ctx.getContextUsage();
      const usageBefore = usageBeforeRaw && usageBeforeRaw.tokens != null && usageBeforeRaw.percent != null
        ? { tokens: usageBeforeRaw.tokens, contextWindow: usageBeforeRaw.contextWindow, percent: usageBeforeRaw.percent }
        : undefined;
      const usageBeforeText = formatContextUsage(usageBefore, true);
      const currentPacketResult = rebuildAcmContextPacket(sessionManager);
      if (!currentPacketResult.ok) {
        return {
          content: [{ type: "text" as const, text: `错误：无法重建当前会话消息：${currentPacketResult.message}。折叠已中止。` }],
          details: { error: "build_messages_failed", message: currentPacketResult.message, target: params.target, targetId },
        };
      }
      const currentPacket = currentPacketResult.value;
      if (currentPacket.protocol.status === "invalid") {
        return {
          content: [{
            type: "text" as const,
            text: `错误：当前活动会话存在无效工具调用标识，无法安全折叠：${formatToolProtocolDefects(currentPacket.protocol.defects) || "无缺陷详情"}。先修复会话协议再重试；没有做任何变更。`,
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
          content: [{ type: "text" as const, text: `错误：无法重建目标会话消息：${targetPacketResult.message}。折叠已中止。` }],
          details: { error: "build_messages_failed", message: targetPacketResult.message, target: params.target, targetId },
        };
      }
      const targetBranch = sessionManager.getBranch(targetId);
      const replacedEntryCount = branch.length - targetBranch.length;
      const replacedEntries = replacedEntryCount > 0 ? branch.slice(targetBranch.length) : [];
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
            text: `错误：目标 '${params.target}' 存在无效工具调用标识，不能作为折叠基底。换一个存档/节点，或先修复持久化的会话协议；没有做任何变更。`,
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

      let backupEntryId: string | undefined;
      let backupResolvedFromHead: string | undefined;
      let backupPrevalidation: CheckpointLabelPrevalidation | undefined;
      let backupProtocolNormalizations: typeof currentPacket.protocol.normalizations = [];
      if (params.backupCurrentHeadAs) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "acm_travel aborted during backup target resolution." }],
            details: { error: "aborted", target: params.target, targetId },
          };
        }
        const backupCandidateIndex = (containingBatch?.entryIndex ?? branch.length) - 1;
        const backupCandidate = backupCandidateIndex >= 0 ? branch[backupCandidateIndex] : undefined;
        if (!backupCandidate) {
          return {
            content: [{ type: "text" as const, text: `错误：书签 backupCurrentHeadAs '${params.backupCurrentHeadAs}' 放不下——本次调用之前没有协议完整的会话前缀。折叠已中止。` }],
            details: { error: "no_protocol_complete_backup_target", name: params.backupCurrentHeadAs, headId: originId },
          };
        }
        const backupPacketResult = rebuildAcmContextPacket(sessionManager, backupCandidate.id);
        if (!backupPacketResult.ok) {
          return {
            content: [{ type: "text" as const, text: `错误：书签 backupCurrentHeadAs '${params.backupCurrentHeadAs}' 无法重建折叠前上下文：${backupPacketResult.message}。折叠已中止。` }],
            details: {
              error: "backup_context_build_failed",
              name: params.backupCurrentHeadAs,
              candidateId: backupCandidate.id,
              message: backupPacketResult.message,
            },
          };
        }
        const backupProtocol = backupPacketResult.value.protocol;
        backupProtocolNormalizations = backupProtocol.normalizations;
        if (backupProtocol.status === "invalid") {
          return {
            content: [{ type: "text" as const, text: `错误：书签 backupCurrentHeadAs '${params.backupCurrentHeadAs}' 在 ${backupCandidate.id} 处存在无效工具调用标识。先修复持久化会话协议再折叠。` }],
            details: {
              error: "backup_protocol_invalid",
              name: params.backupCurrentHeadAs,
              candidateId: backupCandidate.id,
              defects: backupProtocol.defects,
            },
          };
        }
        if (backupProtocol.status === "repaired") {
          return {
            content: [{ type: "text" as const, text: `错误：书签 backupCurrentHeadAs '${params.backupCurrentHeadAs}' 需要在 ${backupCandidate.id} 处做工具协议修复。先完成或显式恢复被打断的工具批次再折叠。` }],
            details: {
              error: "backup_protocol_incomplete",
              name: params.backupCurrentHeadAs,
              candidateId: backupCandidate.id,
              normalizations: backupProtocol.normalizations,
              repairs: backupProtocol.repairs,
            },
          };
        }
        backupEntryId = backupCandidate.id;
        if (backupEntryId !== originId) {
          backupResolvedFromHead = originId;
          ctx.ui.notify(`Note: backupCurrentHeadAs '${params.backupCurrentHeadAs}' placed on protocol-complete entry ${backupEntryId} instead of HEAD ${originId}.`, "info");
        }
      }

      const branchPrevalidation = prevalidateBranchWithSummary(sessionManager, targetId);
      if (!branchPrevalidation.ok) {
        return {
          content: [{ type: "text" as const, text: `错误：宿主预校验失败：${branchPrevalidation.message}。没有尝试任何变更。${RECOVERY_GUIDANCE.hostCapability}` }],
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
              content: [{ type: "text" as const, text: `错误：书签名 '${params.backupCurrentHeadAs}' 已存在于 ${existing}。${RECOVERY_GUIDANCE.nameCollision}` }],
              details: { error: "duplicate_backup_name", name: params.backupCurrentHeadAs, owner: conflict },
            };
          }
          if (backupCheck.error === "label_displaces_existing") {
            const displaced = backupCheck.details as CheckpointLabelDisplacement;
            return {
              content: [{
                type: "text" as const,
                text: `错误：宿主每个条目只保留一个标签，书签 '${params.backupCurrentHeadAs}' 会顶掉折叠前条目 ${displaced.targetId} 上的存档 '${displaced.existingLabel}'。没有尝试任何变更。换一个 backupCurrentHeadAs 目标，或先移走 '${displaced.existingLabel}'。`,
              }],
              details: {
                error: "backup_displaces_existing_label",
                name: params.backupCurrentHeadAs,
                candidateId: displaced.targetId,
                existingLabel: displaced.existingLabel,
              },
            };
          }
          return {
            content: [{ type: "text" as const, text: `错误：书签 '${params.backupCurrentHeadAs}' 预校验失败：${backupCheck.message}。没有尝试任何变更。${RECOVERY_GUIDANCE.hostCapability}` }],
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
        handoffVersion: 1,
        toolCallId,
        currentUserTurnOpen,
        originId,
        ...(originLabel === undefined ? {} : { originLabel }),
        target: params.target,
        targetId,
        backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
      };
      const mutation = executeTravelMutation({
        sessionManager,
        targetId,
        summary: canonicalHandoff.text,
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
            ? mutation.backupRollbackFailed ? RECOVERY_GUIDANCE.rollbackFailed : RECOVERY_GUIDANCE.rollbackSkipped
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
          ? `错误：书签 '${params.backupCurrentHeadAs}' 设置失败`
          : "错误：branchWithSummary 失败";
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
        postMutationDiagnosticWarning = `Active summary depth could not be read after the applied mutation: ${cause}`;
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
              warning: `变更生效后无法重建会话消息证据: ${afterPacketResult.message}`,
            }
          : afterPacketResult.value.protocol.status === "invalid"
            ? {
                status: "invalid_protocol" as const,
                warning: `会话消息证据存在无效工具协议: ${formatToolProtocolDefects(afterPacketResult.value.protocol.defects) || "无缺陷详情"}`,
                defects: afterPacketResult.value.protocol.defects,
              }
            : { status: "verified" as const };
      if (postMutationEvidence.status !== "verified") {
        return {
          content: [{
            type: "text" as const,
            text: [
              `折叠完成。target=${params.target} (${targetId})；新叶 ${resultingLeafId}。`,
              `变更后证据警告: ${postMutationEvidence.warning}.`,
              "树变更已生效；持久化 Context Packet 刷新仍在计划中，会在之后的 LLM turn 重试。",
              `交接单 NEXT: ${canonicalHandoff.fields.next}`,
              currentUserTurnOpen
                ? "本轮用户消息尚未答复：先交付用户要的可见结果，这轮才算完成；State 里记了答案不等于已交付。"
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
            nativeContextReplacementState: liveAgentSessionSync.status,
            nativeContextReplacement: liveAgentSessionSync,
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

      if (!afterPacketResult.ok) throw new Error("unreachable post-mutation evidence state");
      const afterPacket = afterPacketResult.value;
      const afterMessages = afterPacket.messages;
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
      try {
        appendLedgerRow("fold", buildFoldRow({
          state: createLedgerState(`${process.pid}-travel`),
          budgetBefore: usageBeforePercent,
          budgetAfter: estimatedUsageAfter?.percent,
          messageDelta: currentMessages.length - afterMessages.length,
          summaryDepth: activeSummaryDepthAfter,
        }));
      } catch {
      }
      const nextCue = GUIDANCE_CUES.travel;
      const summaryDepthNote = targetIsStructuralRoot
        && activeSummaryDepthBefore > targetSummaryDepth
        && activeSummaryDepthAfter === targetSummaryDepth + 1
        ? `Root rebase 用一份新交接单取代了之前的全部摘要层；摘要深度是 ${targetSummaryDepth + 1} 而不是 ${targetSummaryDepth}。`
        : null;

      return {
        content: [{
          type: "text" as const,
          text: [
            `折叠完成。target=${params.target} (${targetId})；上下文 ${formatNumericValue(usageBeforeTokens)} → ${formatNumericValue(estimatedUsageAfterTokens)} est.（${formatSignedDelta(usageDelta.tokenDelta)} tokens）；摘要深度 ${activeSummaryDepthBefore} → ${activeSummaryDepthAfter}；备份 ${backupText}（${backupOutcome}）。`,
            summaryDepthNote,
            liveAgentSessionSyncRecovery,
            resolved.fromOffPath ? RECOVERY_GUIDANCE.restoredHistory : null,
            targetAnalysis.warnings.length > 0
              ? `目标结构提示：${targetAnalysis.warnings.join(", ")}（结构事实，不是语义判定）。`
              : null,
            `交接单 NEXT: ${canonicalHandoff.fields.next}`,
            currentUserTurnOpen
              ? "本轮用户消息尚未答复：先交付用户要的可见结果，这轮才算完成；State 里记了答案不等于已交付。"
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
          hasBackup: !!params.backupCurrentHeadAs,
          backupCurrentHeadAs: params.backupCurrentHeadAs ?? null,
          backupEntryId,
          backupResolvedFromHead,
          backupOutcome,
          backupProtocolStatus: params.backupCurrentHeadAs ? "complete" : null,
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
          nativeContextReplacementState: liveAgentSessionSync.status,
          nativeContextReplacement: liveAgentSessionSync,
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
