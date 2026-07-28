import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  buildLabelMaps,
  ANCHOR_SEARCH_WINDOW,
  formatContextUsage,
  isReservedTargetName,
  optionalString,
  sanitizeTerminalText,
  isValidEntryId,
  resolveTargetId,
} from "./lib.js";
import { rebuildAcmContextPacket, type AcmProtocolNormalization } from "./context-packet.js";
import { calculateContextUsagePressure } from "./context-pressure.js";
import { estimateFoldGains, findNearestSavePoint, selectFoldReferences, type FoldEstimateEntry } from "./fold-estimate.js";
import {
  appendCheckpointLabel,
  type CheckpointLabelConflict,
  type CheckpointLabelDisplacement,
} from "./host-bridge.js";
import {
  describeEntrySnippet,
  findEntryInTree,
  getMessageRoleLabel,
  isCheckpointableMessage,
} from "./entry-resolution.js";
import { findContainingAssistantToolBatch, type ToolProtocolDefect, type ToolProtocolRepair } from "./tool-protocol.js";
import { GUIDANCE_CUES, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";

interface SkippedCheckpointAnchor {
  id: string;
  reason: "context_build_failed" | "protocol_repaired" | "protocol_invalid";
  message?: string;
  repairs?: ToolProtocolRepair[];
  defects?: ToolProtocolDefect[];
}

interface AutomaticCheckpointAnchor {
  entryId: string | null;
  role?: string;
  snippet?: string;
  protocolStatus?: "complete";
  normalizations: AcmProtocolNormalization[];
  skipped: SkippedCheckpointAnchor[];
  aborted?: boolean;
  searchExhausted?: boolean;
}

export function registerCheckpointTool(pi: ExtensionAPI): void {
  const schema = Type.Object({
    name: Type.String({
      minLength: 1,
      pattern: "^\\S+$",
      description: "存档名，例如 before-refactor、重构前。本会话内唯一（'root' 是保留字）。",
    }),
    target: Type.Optional(Type.String({
      minLength: 1,
      description: "要标记的节点 ID 或已有存档名。不传就标记当前位置（推荐）。",
    })),
  }); // 多余参数忽略，不拒绝。

  pi.registerTool({
    name: "acm_checkpoint",
    label: "ACM Checkpoint",
    description: TOOL_DESCRIPTIONS.checkpoint,
    parameters: schema,
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const target = sanitizeTerminalText(optionalString(args.target) ?? "最近的协议完整节点");
      const name = sanitizeTerminalText(args.name ?? "…");
      component.setText(
        theme.fg("toolTitle", theme.bold("◆ ACM CHECKPOINT  "))
          + theme.fg("accent", name)
          + theme.fg("dim", `  →  ${target}`),
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
        component.setText(theme.fg("warning", "◌ 正在存档…"));
        return component;
      }

      if (typeof details?.error === "string") {
        component.setText(
          theme.fg("error", "✕ 存档未创建")
            + (raw ? `\n${theme.fg("muted", raw.split("\n", 1)[0] ?? raw)}` : ""),
        );
        return component;
      }

      const status = details?.status === "already_present" ? "复用" : "已创建";
      const name = sanitizeTerminalText(typeof details?.name === "string" ? details.name : "checkpoint");
      const entryId = sanitizeTerminalText(typeof details?.entryId === "string" ? details.entryId : "unknown entry");
      const role = sanitizeTerminalText(typeof details?.role === "string" ? details.role : "node");
      const usage = details?.contextUsage && typeof details.contextUsage === "object"
        ? formatContextUsage(details.contextUsage as { tokens: number; contextWindow: number; percent: number }, true)
        : "unknown";
      const cue = sanitizeTerminalText(typeof details?.cue === "string" ? details.cue : "");
      const lines = [
        theme.fg("success", `✓ 存档${status}`) + theme.fg("accent", `  ${name}`),
        theme.fg("muted", `  ${role} · ${entryId} · context ${usage}`),
      ];
      if (cue) lines.push(theme.fg("dim", `  → ${cue}`));
      if (expanded && raw) {
        lines.push(theme.fg("dim", "  ─ 完整结果 ─"), theme.fg("toolOutput", raw));
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
      const params = { ...rawParams, target: optionalString(rawParams.target) };
      if (isReservedTargetName(params.name)) {
        return {
          content: [{ type: "text" as const, text: `错误：存档名 '${params.name}' 是保留字（root 是结构目标）。换一个有语义的名字。` }],
          details: { error: "reserved_name", name: params.name },
        };
      }
      const sessionManager = ctx.sessionManager;
      const tree = sessionManager.getTree();
      const labelMaps = buildLabelMaps(sessionManager.getEntries());
      const branch = sessionManager.getBranch();
      const branchIds = new Set(branch.map((entry: SessionEntry) => entry.id));

      let entryId: string;
      let autoResolved: AutomaticCheckpointAnchor | undefined;
      let targetEntry: SessionEntry | undefined;
      if (params.target) {
        const resolved = resolveTargetId(sessionManager, tree, params.target, branchIds, labelMaps);
        entryId = resolved.id;
        if (!isValidEntryId(entryId)) {
          return {
            content: [{ type: "text" as const, text: "错误：会话树是空的，无法在 root 上存档。" }],
            details: { error: "empty_session", requestedTarget: params.target },
          };
        }
        if (params.target.toLowerCase() === "root" && tree.length > 1) {
          ctx.ui.notify(
            `提示：'root' 解析为第一个顶层节点（${entryId}）；本会话有 ${tree.length} 个顶层根。`,
            "info",
          );
        }
        targetEntry = findEntryInTree(tree, entryId);
        if (!targetEntry) {
          const hint = " 用 acm_timeline 找到想标记的节点；原始节点 ID 也是合法目标。";
          return {
            content: [{ type: "text" as const, text: `错误：目标 '${params.target}' 在会话树里不存在。${hint}` }],
            details: { error: "target_not_found", requestedTarget: params.target },
          };
        }
        if (!isCheckpointableMessage(targetEntry)) {
          const role = getMessageRoleLabel(targetEntry) ?? targetEntry.type;
          ctx.ui.notify(
            `警告：显式目标 '${params.target}'（${entryId}）是 ${role} 节点而非 USER/AI。优先选对话轮次节点；否则 travel 语义可能不符合直觉。`,
            "warning",
          );
        }
        if (resolved.fromOffPath) {
          ctx.ui.notify(`提示：目标 '${params.target}' 解析自非活动分支，存档会落在非活动节点上。`, "warning");
        }
      } else {
        const containingBatch = findContainingAssistantToolBatch(branch, toolCallId);
        const startIndex = (containingBatch?.entryIndex ?? branch.length) - 1;
        const skipped: SkippedCheckpointAnchor[] = [];
        autoResolved = { entryId: null, normalizations: [], skipped };
        let index = startIndex;
        let inspected = 0;
        for (; index >= 0 && inspected < ANCHOR_SEARCH_WINDOW; index--, inspected++) {
          if (signal?.aborted) {
            autoResolved.aborted = true;
            break;
          }
          const candidate = branch[index]!;
          const packet = rebuildAcmContextPacket(sessionManager, candidate.id);
          if (!packet.ok) {
            skipped.push({ id: candidate.id, reason: "context_build_failed", message: packet.message });
            continue;
          }
          if (packet.value.protocol.status === "invalid") {
            skipped.push({
              id: candidate.id,
              reason: "protocol_invalid",
              defects: packet.value.protocol.defects,
            });
            continue;
          }
          if (packet.value.protocol.status === "repaired") {
            skipped.push({
              id: candidate.id,
              reason: "protocol_repaired",
              repairs: packet.value.protocol.repairs,
            });
            continue;
          }
          autoResolved = {
            entryId: candidate.id,
            role: getMessageRoleLabel(candidate) ?? candidate.type.toUpperCase(),
            snippet: describeEntrySnippet(candidate),
            protocolStatus: "complete",
            normalizations: packet.value.protocol.normalizations,
            skipped,
          };
          break;
        }
        if (!autoResolved.entryId && !autoResolved.aborted && inspected === ANCHOR_SEARCH_WINDOW && index >= 0) {
          autoResolved.searchExhausted = true;
        }
        entryId = autoResolved.entryId ?? "";
      }

      if (signal?.aborted || autoResolved?.aborted) {
        return { content: [{ type: "text" as const, text: "acm_checkpoint 已中止。" }], details: { error: "aborted" } };
      }
      if (!entryId) {
        const isEmpty = branch.length === 0;
        return {
          content: [{
            type: "text" as const,
            text: isEmpty
              ? "会话是空的，没有可存档的节点。"
              : autoResolved?.searchExhausted
                ? `本次调用前最近 ${ANCHOR_SEARCH_WINDOW} 个条目里找不到协议完整的前缀。先完成或显式恢复当前工具批次再重试；没有写入任何标签。`
                : "本次调用前找不到协议完整的前缀。先完成或显式恢复当前工具批次再重试；没有写入任何标签。",
          }],
          details: {
            error: isEmpty ? "empty_session" : "no_protocol_complete_checkpoint_target",
            skipped: autoResolved?.skipped ?? [],
            ...(autoResolved?.searchExhausted
              ? { searchWindow: ANCHOR_SEARCH_WINDOW, searchExhausted: true }
              : {}),
          },
        };
      }

      const append = appendCheckpointLabel(sessionManager, entryId, params.name);
      if (!append.ok) {
        if (append.error === "label_conflict") {
          const conflict = append.details as CheckpointLabelConflict;
          return {
            content: [{
              type: "text" as const,
              text: `存档名 '${params.name}' 已属于 ${conflict.entryId}（${conflict.onActivePath ? "活动路径上" : "非活动分支"}）。${RECOVERY_GUIDANCE.nameCollision}`,
            }],
            details: {
              error: "duplicate_name",
              label: params.name,
              name: params.name,
              entryId: conflict.entryId,
              existingEntryId: conflict.entryId,
              existingEntryOnActivePath: conflict.onActivePath,
            },
          };
        }
        if (append.error === "label_displaces_existing") {
          // 该节点已有存档——可恢复性已经存在，直接复用，不让模型换名重试。
          const displaced = append.details as CheckpointLabelDisplacement;
          return {
            content: [{
              type: "text" as const,
              text: `节点 ${displaced.targetId} 已有存档 '${displaced.existingLabel}'，直接用它即可（宿主每个节点只保留一个标签，没有新写）。`,
            }],
            details: {
              status: "existing_label_reused",
              label: displaced.existingLabel,
              requestedName: params.name,
              name: displaced.existingLabel,
              entryId: displaced.targetId,
              existingLabel: displaced.existingLabel,
            },
          };
        }
        return {
          content: [{ type: "text" as const, text: `${append.message}. ${RECOVERY_GUIDANCE.hostCapability}` }],
          details: {
            error: append.error,
            label: params.name,
            name: params.name,
            entryId,
            message: append.message,
            resolvedEntryId: entryId,
            hostBridgeMessage: append.message,
          },
        };
      }

      const { status, labelEntryId } = append.value;
      const resolvedEntry = targetEntry ?? findEntryInTree(tree, entryId);
      const role = autoResolved?.role ?? (resolvedEntry ? getMessageRoleLabel(resolvedEntry) : undefined) ?? resolvedEntry?.type.toUpperCase() ?? "NODE";
      const usage = ctx.getContextUsage();
      const usageLike = usage && usage.tokens != null && usage.percent != null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined;
      const usageText = usageLike ? formatContextUsage(usageLike, true) : "unknown";
      const cue = GUIDANCE_CUES.checkpoint;
      // 折叠投影与距离，只报事实：在各参照点折叠后剩多少、距上个存档几步。
      // 回执排除本次调用刚标记的条目，数字描述的是可折叠的材料，不是这个节点。
      let foldText = "";
      let foldDetails: { turn: string | null; task: string | null; stepsSinceSavePoint: number | null } = { turn: null, task: null, stepsSinceSavePoint: null };
      try {
        const foldBranch = branch as unknown as readonly FoldEstimateEntry[];
        const references = selectFoldReferences(foldBranch, labelMaps, entryId);
        const nearest = findNearestSavePoint(foldBranch, labelMaps);
        const pressure = calculateContextUsagePressure(usageLike?.tokens, usageLike?.contextWindow, usageLike?.percent);
        const currentPacket = rebuildAcmContextPacket(sessionManager);
        const estimates = pressure && currentPacket.ok
          ? estimateFoldGains({
              usage: usageLike,
              workingBudgetTokens: pressure.workingBudgetTokens,
              currentMessages: currentPacket.value.messages,
              messagesAt: (id) => {
                const result = rebuildAcmContextPacket(sessionManager, id);
                return result.ok ? result.value.messages : undefined;
              },
            }, references)
          : { turnPercent: null, taskPercent: null };
        const segments: string[] = [];
        if (estimates.turnPercent != null && references.turn) {
          const name = references.turn.label ?? references.turn.entryId;
          segments.push(`折回 '${name}' → 约剩 ${Math.floor(estimates.turnPercent)}%`);
          foldDetails.turn = name;
        }
        if (estimates.taskPercent != null && references.task) {
          const name = references.task.label ?? references.task.entryId;
          segments.push(`折回最早 '${name}' → 约剩 ${Math.floor(estimates.taskPercent)}%`);
          foldDetails.task = name;
        }
        foldDetails.stepsSinceSavePoint = nearest.stepsBack;
        const distance = nearest.name !== null && nearest.stepsBack !== null
          ? `距上个存档 '${nearest.name}' 已 ${nearest.stepsBack} 步。`
          : `当前路径上没有更早的存档。`;
        foldText = ` ${distance}${segments.length > 0 ? ` ${segments.join("; ")}.` : ""}`;
      } catch {
        foldText = "";
      }
      const skippedCount = autoResolved?.skipped.length;
      const placement = autoResolved
        ? `${role}；最近的协议完整节点${skippedCount ? `（跳过 ${skippedCount} 个更新但不安全/不可用的条目）` : ""}`
        : `${role}；显式目标 '${params.target}'`;
      const action = status === "already_present" ? "复用" : "已创建"; 
      return {
        content: [{
          type: "text" as const,
          text: `${action}存档 '${params.name}'，位于 ${entryId}（标签条目 ${labelEntryId}；${placement}）。当前用量：${usageText}。${foldText} ${cue}`,
        }],
        details: {
          foldReferences: foldDetails,
          status,
          alreadyPresent: status === "already_present",
          label: params.name,
          labelEntryId,
          entryId,
          resolvedEntryId: entryId,
          role,
          target: params.target ?? "auto",
          targetResolution: params.target ? "explicit" : "automatic_protocol_complete",
          protocolStatus: autoResolved?.protocolStatus ?? null,
          protocolNormalizations: autoResolved?.normalizations ?? [],
          contextUsage: usage ? { percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow } : null,
          contextUsageAvailable: usage !== undefined,
          skippedTransientCount: skippedCount ?? null,
          autoResolved: autoResolved
            ? {
                role: autoResolved.role,
                snippet: autoResolved.snippet,
                skippedCount: autoResolved.skipped.length,
                skipped: autoResolved.skipped,
              }
            : undefined,
          cue,
        },
      };
    },
  });
}
