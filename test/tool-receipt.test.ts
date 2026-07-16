import { describe, expect, test } from "bun:test";
import {
  ACM_RECEIPT_PREFIX,
  attachAcmReceipt,
  readAcmReceipt,
  type AcmMutationState,
  type AcmReceiptOutcome,
  type AcmToolName,
  type AcmWorkingSetState,
} from "../src/tool-receipt.js";

function attach(tool: AcmToolName, details: Record<string, unknown>) {
  return attachAcmReceipt("call-123", tool, {
    content: [{ type: "text" as const, text: "result" }],
    details,
  });
}

describe("ACM tool receipts", () => {
  test.each([
    ["acm_checkpoint", { status: "created" }, "success", "applied", "unchanged"],
    ["acm_checkpoint", { status: "already_present" }, "success", "not_applied", "unchanged"],
    ["acm_checkpoint", { error: "duplicate_name" }, "failure", "not_applied", "unchanged"],
    ["acm_checkpoint", { error: "host_operation_failed", hostMutationState: "indeterminate" }, "indeterminate", "indeterminate", "unchanged"],
    ["acm_timeline", {}, "success", "not_applicable", "unchanged"],
    ["acm_timeline", { error: "build_messages_failed" }, "failure", "not_applicable", "unchanged"],
    ["acm_travel", {}, "success", "applied", "replaced"],
    ["acm_travel", { error: "invalid_handoff" }, "failure", "not_applied", "unchanged"],
    ["acm_travel", { error: "branch_failed", branchState: "indeterminate" }, "indeterminate", "indeterminate", "indeterminate"],
    ["acm_travel", { error: "build_messages_failed", summaryEntryId: "summary-1" }, "indeterminate", "applied", "replaced"],
  ] as Array<[AcmToolName, Record<string, unknown>, AcmReceiptOutcome, AcmMutationState, AcmWorkingSetState]>) (
    "%s maps observable details to %s/%s/%s",
    (tool, details, outcome, mutationState, workingSetState) => {
      const result = attach(tool, details);
      expect(result.details.receipt).toEqual({
        version: 1,
        toolCallId: "call-123",
        tool,
        outcome,
        mutationState,
        workingSetState,
      });
      const providerReceipt = result.content.at(-1)?.text ?? "";
      expect(providerReceipt).toStartWith(ACM_RECEIPT_PREFIX);
      expect(JSON.parse(providerReceipt.slice(ACM_RECEIPT_PREFIX.length))).toEqual(result.details.receipt);
    },
  );

  test("accepts only complete versioned receipts for rendering", () => {
    const result = attach("acm_travel", {});
    expect(readAcmReceipt(result.details)).toEqual(result.details.receipt);
    expect(readAcmReceipt({ receipt: { ...result.details.receipt, mutationState: "maybe" } })).toBeUndefined();
    expect(readAcmReceipt({ receipt: { ...result.details.receipt, toolCallId: 42 } })).toBeUndefined();
    expect(readAcmReceipt(undefined)).toBeUndefined();
  });
});
