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
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";
import { withAvailableAdvancedGuidance } from "./advanced-guidance.js";

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
      pattern: "^[A-Za-z0-9._-]+$",
      description: "存档点名称，起个有意义的名字方便以后找",
    }),
    target: Type.Optional(Type.String({
      minLength: 1,
      description: "要标记的节点 ID。省略则标记当前位置",
    })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "acm_checkpoint",
    label: "ACM Checkpoint",
    description: TOOL_DESCRIPTIONS.checkpoint,
    promptSnippet: PROMPT_SNIPPETS.checkpoint,
    promptGuidelines: PROMPT_GUIDELINES.checkpoint.split("\n"),
    parameters: schema,
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const target = sanitizeTerminalText(optionalString(args.target) ?? "latest protocol-complete pre-call leaf");
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
        component.setText(theme.fg("warning", "◌ Creating checkpoint…"));
        return component;
      }

      if (typeof details?.error === "string") {
        component.setText(
          theme.fg("error", "✕ CHECKPOINT NOT CREATED")
            + (raw ? `\n${theme.fg("muted", raw.split("\n", 1)[0] ?? raw)}` : ""),
        );
        return component;
      }

      const status = details?.status === "already_present" ? "REUSED" : "CREATED";
      const name = sanitizeTerminalText(typeof details?.name === "string" ? details.name : "checkpoint");
      const entryId = sanitizeTerminalText(typeof details?.entryId === "string" ? details.entryId : "unknown entry");
      const role = sanitizeTerminalText(typeof details?.role === "string" ? details.role : "node");
      const usage = details?.contextUsage && typeof details.contextUsage === "object"
        ? formatContextUsage(details.contextUsage as { tokens: number; contextWindow: number; percent: number }, true)
        : "unknown";
      const cue = sanitizeTerminalText(typeof details?.cue === "string" ? details.cue : "");
      const lines = [
        theme.fg("success", `✓ CHECKPOINT ${status}`) + theme.fg("accent", `  ${name}`),
        theme.fg("muted", `  ${role} · ${entryId} · context ${usage}`),
      ];
      if (cue) lines.push(theme.fg("dim", `  → ${cue}`));
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
      const params = { ...rawParams, target: optionalString(rawParams.target) };
      if (isReservedTargetName(params.name)) {
        return {
          content: [{ type: "text" as const, text: `Error: Checkpoint name '${params.name}' is reserved for the structural root target. Choose a different semantic name.` }],
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
            content: [{ type: "text" as const, text: "Error: Cannot checkpoint root — session tree is empty." }],
            details: { error: "empty_session", requestedTarget: params.target },
          };
        }
        if (params.target.toLowerCase() === "root" && tree.length > 1) {
          ctx.ui.notify(
            `Note: 'root' resolved to the first top-level node (${entryId}); this session has ${tree.length} top-level roots.`,
            "info",
          );
        }
        targetEntry = findEntryInTree(tree, entryId);
        if (!targetEntry) {
          const hint = " Use acm_timeline to locate the node you want to label; raw node IDs are valid targets.";
          return {
            content: [{ type: "text" as const, text: `Error: Target '${params.target}' not found in session tree.${hint}` }],
            details: { error: "target_not_found", requestedTarget: params.target },
          };
        }
        if (!isCheckpointableMessage(targetEntry)) {
          const role = getMessageRoleLabel(targetEntry) ?? targetEntry.type;
          ctx.ui.notify(
            `Warning: explicit checkpoint target '${params.target}' (${entryId}) is a ${role} node, not USER/AI. Prefer conversational turns; travel semantics may be unintuitive.`,
            "warning",
          );
        }
        if (resolved.fromOffPath) {
          ctx.ui.notify(`Note: target '${params.target}' resolved from an off-path branch. Checkpoint will be placed on a non-active node.`, "warning");
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
        return { content: [{ type: "text" as const, text: "acm_checkpoint aborted." }], details: { error: "aborted" } };
      }
      if (!entryId) {
        const isEmpty = branch.length === 0;
        return {
          content: [{
            type: "text" as const,
            text: isEmpty
              ? "No session entry to checkpoint. The conversation is empty."
              : autoResolved?.searchExhausted
                ? `No protocol-complete session prefix exists within the last ${ANCHOR_SEARCH_WINDOW} entries before this checkpoint call. Finish or explicitly recover the current tool batch, then retry; no label was written.`
                : "No protocol-complete session prefix exists before this checkpoint call. Finish or explicitly recover the current tool batch, then retry; no label was written.",
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
              text: `Checkpoint '${params.name}' already belongs to ${conflict.entryId} (${conflict.onActivePath ? "on-path" : "off-path"}). ${withAvailableAdvancedGuidance(pi, RECOVERY_GUIDANCE.nameCollision, GUIDANCE_CUES.advancedTargetPointer)}`,
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
          const displaced = append.details as CheckpointLabelDisplacement;
          return {
            content: [{
              type: "text" as const,
              text: `Entry ${displaced.targetId} already carries checkpoint '${displaced.existingLabel}'; writing '${params.name}' would replace it, because the host keeps one label per entry. No label was written. Reuse '${displaced.existingLabel}' as the recovery pointer, or checkpoint a different node. ${withAvailableAdvancedGuidance(pi, RECOVERY_GUIDANCE.nameCollision, GUIDANCE_CUES.advancedTargetPointer)}`,
            }],
            details: {
              error: "label_displaces_existing",
              label: params.name,
              name: params.name,
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
      const usage = ctx.getContextUsage();
      const usageLike = usage && usage.tokens != null && usage.percent != null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined;
      const usageText = usageLike ? formatContextUsage(usageLike, true) : "unknown";

      // 草根版 - 简化输出
      const action = status === "already_present" ? "已存在" : "创建成功";
      return {
        content: [{
          type: "text" as const,
          text: `存档点 '${params.name}' ${action}。位置: ${entryId}。Context 用量: ${usageText}。`,
        }],
        details: {
          status,
          name: params.name,
          entryId,
          labelEntryId,
          contextUsage: usage ? { percent: usage.percent, tokens: usage.tokens } : null,
        },
      };
    },
  });
}
