import type { ReadonlySessionManager } from "./host-bridge.js";
import {
  appendCheckpointLabel,
  applyBranchWithSummary,
  rollbackCheckpointLabel,
  type BranchMutationFailureDetails,
  type CheckpointLabelPrevalidation,
  type LabelRollbackToken,
} from "./host-bridge.js";

export interface TravelBackupPlan {
  targetId: string;
  name: string;
  prevalidation: CheckpointLabelPrevalidation;
}

export interface TravelMutationRequest {
  sessionManager: ReadonlySessionManager;
  targetId: string;
  summary: string;
  details: unknown;
  backup?: TravelBackupPlan;
}

export interface TravelMutationSuccess {
  ok: true;
  summaryEntryId: string;
  resultingLeafId: string;
  backupOutcome: "none" | "already_present" | "created";
  backupLabelEntryId?: string;
  backupRollbackToken?: LabelRollbackToken;
  hostReturnedSummaryEntryId?: string;
}

export interface TravelMutationFailure {
  ok: false;
  error: "backup_label_failed" | "branch_failed";
  hostError: string;
  message: string;
  branchState: "not_attempted" | "not_applied" | "indeterminate";
  branchFailure: BranchMutationFailureDetails | null;
  backupOutcome: "none" | "already_present" | "created" | "indeterminate";
  backupLabelEntryId?: string;
  backupRolledBack: boolean;
  backupRollbackFailed: boolean;
  backupRollbackSkipped: boolean;
  backupRollbackSkipReason: "branch_mutation_observed" | "backup_mutation_indeterminate" | null;
  remainingBackupLabel: string | null;
  refreshRequired: boolean;
  refreshLeafId?: string;
}

export type TravelMutationOutcome = TravelMutationSuccess | TravelMutationFailure;

function labelRemains(
  sessionManager: ReadonlySessionManager,
  targetId: string,
  name: string,
): boolean {
  let aliases: string[] = [];
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "label" || entry.targetId !== targetId) continue;
    if (entry.label === undefined) {
      aliases = [];
      continue;
    }
    if (!aliases.includes(entry.label)) aliases.push(entry.label);
  }
  return aliases.includes(name);
}

/**
 * Owns the complete mutation transaction for one travel attempt.
 * Validation and result presentation stay in the tool module; host mutation,
 * compensation, and refresh obligations stay here.
 */
export function executeTravelMutation(request: TravelMutationRequest): TravelMutationOutcome {
  const { sessionManager, targetId, summary, details, backup } = request;
  let backupToken: LabelRollbackToken | undefined;
  let backupLabelEntryId: string | undefined;
  let backupOutcome: TravelMutationSuccess["backupOutcome"] = "none";

  if (backup) {
    if (backup.prevalidation.status === "already_present") {
      backupOutcome = "already_present";
      backupLabelEntryId = backup.prevalidation.existingLabelEntryId;
    } else {
      const append = appendCheckpointLabel(sessionManager, backup.targetId, backup.name);
      if (!append.ok) {
        return {
          ok: false,
          error: "backup_label_failed",
          hostError: append.error,
          message: append.message,
          branchState: "not_attempted",
          branchFailure: null,
          backupOutcome: append.state === "indeterminate" ? "indeterminate" : "none",
          backupRolledBack: false,
          backupRollbackFailed: false,
          backupRollbackSkipped: append.state === "indeterminate",
          backupRollbackSkipReason: append.state === "indeterminate" ? "backup_mutation_indeterminate" : null,
          remainingBackupLabel: labelRemains(sessionManager, backup.targetId, backup.name) ? backup.name : null,
          refreshRequired: false,
        };
      }
      backupOutcome = append.value.status === "already_present" ? "already_present" : "created";
      backupLabelEntryId = append.value.labelEntryId;
      backupToken = append.value.rollback;
    }
  }

  const branch = applyBranchWithSummary(sessionManager, targetId, summary, details);
  if (branch.ok) {
    return {
      ok: true,
      summaryEntryId: branch.value.summaryEntryId,
      resultingLeafId: branch.value.leafAfter,
      backupOutcome,
      backupLabelEntryId,
      backupRollbackToken: backupToken,
      hostReturnedSummaryEntryId: branch.value.hostReturnedEntryId,
    };
  }

  let backupRolledBack = false;
  let backupRollbackFailed = false;
  let backupRollbackSkipped = false;
  let backupRollbackSkipReason: TravelMutationFailure["backupRollbackSkipReason"] = null;
  const branchFailure = "leafBefore" in branch.details ? branch.details : null;

  if (backupToken) {
    if (branch.state === "indeterminate") {
      backupRollbackSkipped = true;
      backupRollbackSkipReason = "branch_mutation_observed";
    } else {
      const rollback = rollbackCheckpointLabel(sessionManager, backupToken);
      backupRolledBack = rollback.ok;
      backupRollbackFailed = !rollback.ok;
    }
  }

  const remainingBackupLabel = backup && labelRemains(sessionManager, backup.targetId, backup.name)
    ? backup.name
    : null;
  const refreshLeafId = branchFailure?.actualSummaryEntryId ?? branchFailure?.leafAfter ?? undefined;

  return {
    ok: false,
    error: "branch_failed",
    hostError: branch.error,
    message: branch.message,
    branchState: branch.state,
    branchFailure,
    backupOutcome,
    backupLabelEntryId,
    backupRolledBack,
    backupRollbackFailed,
    backupRollbackSkipped,
    backupRollbackSkipReason,
    remainingBackupLabel,
    refreshRequired: branch.state === "indeterminate",
    refreshLeafId,
  };
}
