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
  isReservedTargetName,
  optionalString,
  sanitizeTerminalText,
  isValidEntryId,
  resolveTargetId,
} from "./lib.js";
import { rebuildAcmContextPacket, type AcmProtocolNormalization } from "./context-packet.js";
import { calculateContextUsagePressure, foldProjectionScaleName, formatContextUsagePressure } from "./context-pressure.js";
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
import type { AcmSessionRuntime } from "./runtime.js";
import { GUIDANCE_CUES, PROMPT_GUIDELINES, PROMPT_SNIPPETS, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";

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
  protocolStatus?: "complete" | "repaired";
  protocolRepairs?: ToolProtocolRepair[];
  normalizations: AcmProtocolNormalization[];
  skipped: SkippedCheckpointAnchor[];
  aborted?: boolean;
  searchExhausted?: boolean;
}

export function registerCheckpointTool(pi: ExtensionAPI, runtime: AcmSessionRuntime): void {
  const schema = Type.Object({
    name: Type.String({
      minLength: 1,
      pattern: "^[A-Za-z0-9._-]+$",
      description: "Semantic name a future search should find, e.g. parser-fix-baseline or p99-before-db-scan. Unique in this session; 'root' is reserved.",
    }),
    target: Type.Optional(Type.String({
      minLength: 1,
      description: "OPTIONAL — omit this field entirely to mark the current position (recommended). Pass a node ID or existing checkpoint name only to label an earlier point; placeholder values like '.' or 'current' are invalid.",
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
      const target = sanitizeTerminalText(optionalString(args.target) ?? "current position");
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
      // The receipt records the authoritative pressure in details; the legacy
      // contextUsage detail (raw host usage) survives for compatibility but
      // can describe the pre-travel branch during a provider epoch. Fallback
      // is presence-based: a receipt without the contextPressure key is a
      // legacy replay and may use the raw detail, but a receipt that carries
      // the key with a malformed payload fails closed to unknown — degrading
      // to the raw detail there would re-attribute the number to the wrong
      // authority.
      const asRendererPressure = (value: unknown) => {
        if (!value || typeof value !== "object") return undefined;
        const candidate = value as { tokens?: unknown; contextWindow?: unknown };
        return calculateContextUsagePressure(
          typeof candidate.tokens === "number" ? candidate.tokens : null,
          typeof candidate.contextWindow === "number" ? candidate.contextWindow : null,
        );
      };
      const hasAuthoritativeDetail = details !== undefined && "contextPressure" in details && details.contextPressure !== null;
      const rendererPressure = hasAuthoritativeDetail
        ? asRendererPressure(details.contextPressure)
        : asRendererPressure(details?.contextUsage);
      const usage = rendererPressure ? formatContextUsagePressure(rendererPressure, 1) : "unknown";
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
          const hint = " Valid targets are node IDs and existing checkpoint names from acm_timeline. To mark the current position, call again without the target field.";
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
        // Two-tier fallback (invalid-only hard floor): prefer the latest
        // protocol-complete candidate; when a mid-span defect leaves every
        // candidate "repaired", anchor on the latest rebuildable repaired
        // one instead of failing — the label must not become unreachable
        // because of one dangling provider-error tool call upstream.
        let repairedFallback: { entry: SessionEntry; repairs?: ToolProtocolRepair[]; normalizations: AcmProtocolNormalization[] } | undefined;
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
            if (repairedFallback === undefined) {
              repairedFallback = {
                entry: candidate,
                repairs: packet.value.protocol.repairs,
                normalizations: packet.value.protocol.normalizations,
              };
            }
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
        if (!autoResolved.entryId && !autoResolved.aborted && repairedFallback) {
          const candidate = repairedFallback.entry;
          autoResolved = {
            entryId: candidate.id,
            role: getMessageRoleLabel(candidate) ?? candidate.type.toUpperCase(),
            snippet: describeEntrySnippet(candidate),
            protocolStatus: "repaired",
            ...(repairedFallback.repairs !== undefined ? { protocolRepairs: repairedFallback.repairs } : {}),
            normalizations: repairedFallback.normalizations,
            // The fallback anchor is no longer "skipped"; keep the other
            // skip evidence but drop its own entry from that list.
            skipped: skipped.filter((skip) => skip.id !== candidate.id),
          };
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
                ? `No entry that can rebuild a lawful context packet exists within the last ${ANCHOR_SEARCH_WINDOW} entries before this checkpoint call. Finish or explicitly recover the current tool batch, then retry; no label was written.`
              : "No entry that can rebuild a lawful context packet exists before this checkpoint call. Finish or explicitly recover the current tool batch, then retry; no label was written.",
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
              text: `Checkpoint '${params.name}' already belongs to ${conflict.entryId} (${conflict.onActivePath ? "on-path" : "off-path"}). ${RECOVERY_GUIDANCE.nameCollision}`,
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
              text: `Entry ${displaced.targetId} already carries checkpoint '${displaced.existingLabel}'; writing '${params.name}' would replace it, because the host keeps one label per entry. No label was written. Reuse '${displaced.existingLabel}' as the recovery pointer, or checkpoint a different node. ${RECOVERY_GUIDANCE.nameCollision}`,
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
      const resolvedEntry = targetEntry ?? findEntryInTree(tree, entryId);
      const role = autoResolved?.role ?? (resolvedEntry ? getMessageRoleLabel(resolvedEntry) : undefined) ?? resolvedEntry?.type.toUpperCase() ?? "NODE";
      const usage = ctx.getContextUsage();
      // One pressure authority for every perception surface: between a
      // travel's provider cutover and its native replacement the host
      // estimate still describes the pre-travel branch, so the receipt must
      // read the same authoritative pressure the gauge and HUD render.
      const pressure = runtime.authoritativeContextPressure(ctx.sessionManager, usage);
      const usageText = pressure ? formatContextUsagePressure(pressure) : "unknown";
      const cue = GUIDANCE_CUES.checkpoint;
      // Fold projections and segment distance, restored from the preview that
      // shipped until 7c3bdff7 (2026-07-12) dropped it in the single-file split.
      // Facts only: what a fold at each reference point would leave, and how far
      // back the nearest save point is. The receipt excludes the entry this call
      // just labeled, so the numbers describe folding material, not this node.
      let foldText = "";
      let foldDetails: { turn: string | null; task: string | null; stepsSinceSavePoint: number | null } = { turn: null, task: null, stepsSinceSavePoint: null };
      try {
        const foldBranch = branch as unknown as readonly FoldEstimateEntry[];
        const references = selectFoldReferences(foldBranch, labelMaps, entryId);
        const nearest = findNearestSavePoint(foldBranch, labelMaps);
        const currentPacket = rebuildAcmContextPacket(sessionManager);
        const estimates = pressure && currentPacket.ok
          ? estimateFoldGains({
              usage: { tokens: pressure.tokens, contextWindow: pressure.contextWindow, percent: 0 },
              workingBudgetTokens: pressure.workingBudgetTokens,
              currentMessages: currentPacket.value.messages,
              messagesAt: (id) => {
                const result = rebuildAcmContextPacket(sessionManager, id);
                return result.ok ? result.value.messages : undefined;
              },
            }, references)
          : { turnPercent: null, taskPercent: null };
        const scale = pressure ? foldProjectionScaleName(pressure.policy) : "budget";
        const segments: string[] = [];
        if (estimates.turnPercent != null && references.turn) {
          const name = references.turn.label ?? references.turn.entryId;
          segments.push(`fold@turn '${name}' → ~${Math.floor(estimates.turnPercent)}% ${scale}`);
          foldDetails.turn = name;
        }
        if (estimates.taskPercent != null && references.task) {
          const name = references.task.label ?? references.task.entryId;
          segments.push(`fold@task '${name}' → ~${Math.floor(estimates.taskPercent)}% ${scale}`);
          foldDetails.task = name;
        }
        foldDetails.stepsSinceSavePoint = nearest.stepsBack;
        const distance = nearest.name !== null && nearest.stepsBack !== null
          ? `Segment: ${nearest.stepsBack} node(s) since the previous save point '${nearest.name}'.`
          : `Segment: this is the first save point on this path.`;
        foldText = ` ${distance}${segments.length > 0 ? ` ${segments.join("; ")}.` : ""}`;
      } catch {
        foldText = "";
      }
      const skippedCount = autoResolved?.skipped.length;
      const placement = autoResolved
        ? `${role}; the latest safe anchor before this call${autoResolved.protocolStatus === "repaired" ? " (tool protocol repaired)" : ""}${skippedCount ? `, skipping ${skippedCount} newer unsafe/unavailable entr${skippedCount === 1 ? "y" : "ies"}` : ""}`
        : `${role}; explicit target '${params.target}'`;
      const action = status === "already_present" ? "Reused" : "Created";
      return {
        content: [{
          type: "text" as const,
          text: `${action} checkpoint '${params.name}' at node ${entryId} (${placement}). Context usage: ${usageText}.${foldText} ${cue}`,
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
          protocolRepairs: autoResolved?.protocolRepairs ?? [],
          protocolNormalizations: autoResolved?.normalizations ?? [],
          contextUsage: usage ? { percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow } : null,
          contextUsageAvailable: usage !== undefined,
          contextPressure: pressure ?? null,
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
