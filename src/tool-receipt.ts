export const ACM_RECEIPT_VERSION = 1 as const;

export type AcmToolName = "acm_checkpoint" | "acm_timeline" | "acm_travel";
export type AcmReceiptOutcome = "success" | "failure" | "indeterminate";
export type AcmMutationState = "applied" | "not_applied" | "indeterminate" | "not_applicable";
export type AcmWorkingSetState = "replaced" | "unchanged" | "indeterminate";

export interface AcmToolReceipt {
  version: typeof ACM_RECEIPT_VERSION;
  toolCallId: string;
  tool: AcmToolName;
  outcome: AcmReceiptOutcome;
  mutationState: AcmMutationState;
  workingSetState: AcmWorkingSetState;
}

interface ToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptState(tool: AcmToolName, details: Record<string, unknown>): Omit<AcmToolReceipt, "version" | "toolCallId" | "tool"> {
  const error = typeof details.error === "string" ? details.error : null;

  if (tool === "acm_timeline") {
    return {
      outcome: error ? "failure" : "success",
      mutationState: "not_applicable",
      workingSetState: "unchanged",
    };
  }

  if (tool === "acm_checkpoint") {
    const hostMutationState = details.hostMutationState;
    if (hostMutationState === "indeterminate") {
      return { outcome: "indeterminate", mutationState: "indeterminate", workingSetState: "unchanged" };
    }
    if (error) return { outcome: "failure", mutationState: "not_applied", workingSetState: "unchanged" };
    return {
      outcome: "success",
      mutationState: details.status === "created" ? "applied" : "not_applied",
      workingSetState: "unchanged",
    };
  }

  if (!error) return { outcome: "success", mutationState: "applied", workingSetState: "replaced" };
  if (error === "build_messages_failed" && typeof details.summaryEntryId === "string") {
    return { outcome: "indeterminate", mutationState: "applied", workingSetState: "replaced" };
  }
  if (details.branchState === "indeterminate") {
    return { outcome: "indeterminate", mutationState: "indeterminate", workingSetState: "indeterminate" };
  }
  return { outcome: "failure", mutationState: "not_applied", workingSetState: "unchanged" };
}

export const ACM_RECEIPT_PREFIX = "ACM_RECEIPT ";

export function attachAcmReceipt<T extends ToolResultLike>(
  toolCallId: string,
  tool: AcmToolName,
  result: T,
): T & { details: Record<string, unknown> & { receipt: AcmToolReceipt } } {
  const details = isRecord(result.details) ? result.details : {};
  const receipt: AcmToolReceipt = {
    version: ACM_RECEIPT_VERSION,
    toolCallId,
    tool,
    ...receiptState(tool, details),
  };
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text" as const, text: `${ACM_RECEIPT_PREFIX}${JSON.stringify(receipt)}` },
    ],
    details: {
      ...details,
      receipt,
    },
  } as T & { details: Record<string, unknown> & { receipt: AcmToolReceipt } };
}

export function readAcmReceipt(details: unknown): AcmToolReceipt | undefined {
  if (!isRecord(details) || !isRecord(details.receipt)) return undefined;
  const receipt = details.receipt;
  if (
    receipt.version !== ACM_RECEIPT_VERSION
    || typeof receipt.toolCallId !== "string"
    || !["acm_checkpoint", "acm_timeline", "acm_travel"].includes(String(receipt.tool))
    || !["success", "failure", "indeterminate"].includes(String(receipt.outcome))
    || !["applied", "not_applied", "indeterminate", "not_applicable"].includes(String(receipt.mutationState))
    || !["replaced", "unchanged", "indeterminate"].includes(String(receipt.workingSetState))
  ) return undefined;
  return receipt as unknown as AcmToolReceipt;
}
