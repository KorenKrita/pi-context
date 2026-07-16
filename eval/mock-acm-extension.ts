import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { TOOL_DESCRIPTIONS } from "../src/generated-guidance.js";
import { HANDOFF_SLOT_HINT } from "../src/lib.js";
import { attachAcmReceipt } from "../src/tool-receipt.js";

export default function registerMockAcmExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "acm_checkpoint",
    label: "ACM Eval Checkpoint",
    description: TOOL_DESCRIPTIONS.checkpoint,
    parameters: Type.Object({
      name: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9._-]+$",
        description: "Semantic recovery label for the boundary or return state; unique and case-sensitive. The label is a recovery cue, not a state classifier.",
      }),
      target: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Optional checkpoint name or node ID to label; omit for the nearest meaningful USER/AI turn.",
      })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      return attachAcmReceipt(toolCallId, "acm_checkpoint", {
        content: [{ type: "text" as const, text: `Evaluation checkpoint created: ${params.name}. Recoverability improved; working set unchanged.` }],
        details: { status: "created", name: params.name, target: params.target ?? "nearest meaningful turn" },
      });
    },
  });

  pi.registerTool({
    name: "acm_timeline",
    label: "ACM Eval Timeline",
    description: TOOL_DESCRIPTIONS.timeline,
    parameters: Type.Object({
      view: Type.Optional(Type.Union([
        Type.Literal("active"),
        Type.Literal("checkpoints"),
        Type.Literal("search"),
        Type.Literal("tree"),
      ])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      filter: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      verbose: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      return attachAcmReceipt(toolCallId, "acm_timeline", {
        content: [{ type: "text" as const, text: `Evaluation timeline evidence available for ${params.view ?? "active"}. Use the scenario facts as authoritative topology evidence.` }],
        details: { view: params.view ?? "active", simulated: true },
      });
    },
  });

  pi.registerTool({
    name: "eval_observe_external",
    label: "ACM Eval External Observation",
    description: "Read-only evaluation probe for external state before travel. Use it instead of shell commands; it returns deterministic observed file effects and performs no mutation.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 300,
        description: "Why the external observation is needed before the handoff is finalized.",
      })),
    }, { additionalProperties: false }),
    async execute() {
      return {
        content: [{ type: "text" as const, text: "Observed external state: formatter completed; modified file src/formatter.ts; untracked evidence artifacts/formatter.log; no process is running." }],
        details: { simulated: true, modified: ["src/formatter.ts"], untracked: ["artifacts/formatter.log"], processes: [] },
      };
    },
  });

  pi.registerTool({
    name: "acm_travel",
    label: "ACM Eval Travel",
    description: TOOL_DESCRIPTIONS.travel,
    parameters: Type.Object({
      target: Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Last clean checkpoint, node ID, or root before the boundary. A rebase target must precede every handoff layer it retires; newest authoritative state belongs in the summary, not at the target.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: 10000,
        description: `Cold-start handoff. Fill every slot exactly once and in order, using none for empty categories: ${HANDOFF_SLOT_HINT}.`,
      }),
      backupCurrentHeadAs: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9._-]+$",
        description: "Optional semantic recovery label for the raw path folded away; spelling does not classify the travel.",
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(toolCallId, params) {
      return attachAcmReceipt(toolCallId, "acm_travel", {
        content: [{ type: "text" as const, text: `Evaluation travel applied to ${params.target}. Handoff accepted; verify external state before NEXT.` }],
        details: { status: "applied", target: params.target, backupCurrentHeadAs: params.backupCurrentHeadAs ?? null },
      });
    },
  });
}
