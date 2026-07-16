import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  buildLabelMaps,
  formatContextUsage,
  isReservedTargetName,
  sanitizeTerminalText,
  isValidEntryId,
  resolveTargetId,
  type MeaningfulResolveResult,
} from "./lib.js";
import {
  appendCheckpointLabel,
  type CheckpointLabelConflict,
} from "./host-bridge.js";
import {
  findEntryInTree,
  findLastMeaningfulEntry,
  getMessageRoleLabel,
  isCheckpointableMessage,
} from "./entry-resolution.js";
import { GUIDANCE_CUES, RECOVERY_GUIDANCE, TOOL_DESCRIPTIONS } from "./generated-guidance.js";

export function registerCheckpointTool(pi: ExtensionAPI): void {
  const schema = Type.Object({
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9._-]+$",
      description: "Semantic anchor name; unique and case-sensitive across the session tree. The structural target keyword 'root' is reserved in every letter case. Use '<name>-start' for the beginning of a boundary you may later compress: task chain, phase, burst, or risky attempt. Use '<name>-paused' when work stops with a resumable next action. Use '<name>-done' for a milestone/archive pointer after results are in hand. E.g. parser-fix-start, timeout-investigation-start, migration-paused, root-cause-done. Avoid generic names like start or checkpoint-1. Only letters, digits, hyphens, underscores, and dots. Max 64 chars.",
    }),
    target: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 256,
      description: "History node ID or checkpoint name to label. Defaults to current meaningful position near HEAD.",
    })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "acm_checkpoint",
    label: "ACM Checkpoint",
    description: TOOL_DESCRIPTIONS.checkpoint,
    promptSnippet: "Label a recoverable session boundary without changing context",
    promptGuidelines: [
      "Use acm_checkpoint to preflight each distinct user goal before managed work makes rewind expensive, and to label later phase, burst, pause, milestone, or completion boundaries.",
    ],
    parameters: schema,
    renderShell: "self",
    renderCall(rawArgs, theme, context) {
      const args = rawArgs as Static<typeof schema>;
      const component = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const target = sanitizeTerminalText(args.target ?? "nearest meaningful turn");
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
      _id: string,
      rawParams: Static<typeof schema>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const params = rawParams;
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
      let autoResolved: MeaningfulResolveResult | undefined;
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
          const hint = " Use acm_timeline to choose the last clean node before the boundary you want to label; raw node IDs are valid targets.";
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
        autoResolved = findLastMeaningfulEntry(branch, signal);
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
              : "No meaningful entry to checkpoint. Recent HEAD traffic is tool/bash/custom/system-only or empty — specify a target explicitly.",
          }],
          details: { error: isEmpty ? "empty_session" : "no_meaningful_entry" },
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

      const { status, aliases, labelEntryId } = append.value;
      const resolvedEntry = targetEntry ?? findEntryInTree(tree, entryId);
      const role = autoResolved?.role ?? (resolvedEntry ? getMessageRoleLabel(resolvedEntry) : undefined) ?? resolvedEntry?.type.toUpperCase() ?? "NODE";
      const usage = ctx.getContextUsage();
      const usageLike = usage && usage.tokens != null && usage.percent != null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined;
      const usageText = usageLike ? formatContextUsage(usageLike, true) : "unknown";
      const cue = params.name.endsWith("-done") ? GUIDANCE_CUES.checkpointDone : GUIDANCE_CUES.checkpointStart;
      const skippedCount = autoResolved?.skipped.length;
      const placement = autoResolved
        ? `${role}${skippedCount ? `; skipped ${skippedCount} nearer transient/non-meaningful entr${skippedCount === 1 ? "y" : "ies"}` : ""}`
        : `${role}; explicit target '${params.target}'`;
      const action = status === "already_present" ? "Reused" : "Created";
      return {
        content: [{
          type: "text" as const,
          text: `${action} checkpoint '${params.name}' at ${entryId} via label entry ${labelEntryId} (${placement}). Aliases: ${aliases.join(", ")}. Context usage: ${usageText}. ${cue}`,
        }],
        details: {
          status,
          alreadyPresent: status === "already_present",
          label: params.name,
          labelEntryId,
          entryId,
          resolvedEntryId: entryId,
          role,
          aliases,
          target: params.target ?? "auto",
          targetResolution: params.target ? "explicit" : "automatic",
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
