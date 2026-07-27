import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export type ReadonlySessionManager = Pick<
  SessionManager,
  "getLeafId" | "getEntry" | "getBranch" | "getEntries"
>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { buildLabelMaps, isReservedTargetName } from "./lib.js";

export type HostBridgeErrorCode =
  | "missing_capability"
  | "malformed_capability"
  | "host_operation_failed"
  | "branch_verification_failed"
  | "entry_not_found"
  | "label_conflict"
  | "label_displaces_existing"
  | "reserved_name"
  | "unsafe_rollback";

export interface HostFailure<Details> {
  ok: false;
  error: HostBridgeErrorCode;
  message: string;
  details: Details;
}

export type HostResult<Value, Details = Record<string, never>> =
  | { ok: true; value: Value }
  | HostFailure<Details>;

export type HostMutationResult<Value, Details> =
  | { ok: true; state: "not_applied" | "applied"; value: Value }
  | (HostFailure<Details> & { state: "not_applied" | "indeterminate" });

export interface HostBridgeCapabilities {
  appendLabelChange: boolean;
  branchWithSummary: boolean;
}

export interface CheckpointLabelPrevalidation {
  targetId: string;
  name: string;
  status: "would_create" | "already_present";
  /** The label the host currently reports for this entry, if any. */
  existingLabel: string | undefined;
  existingLabelEntryId?: string;
}

/** The target already carries a different label; writing this name would erase it. */
export interface CheckpointLabelDisplacement {
  targetId: string;
  name: string;
  existingLabel: string;
}

export interface CheckpointLabelConflict {
  entryId: string;
  onActivePath: boolean;
}

export interface HostObservationFailureDetails {
  cause: string;
}

export interface LabelRollbackToken {
  targetId: string;
  name: string;
  labelEntryId: string;
  priorLabel: string | undefined;
}

export interface AppendCheckpointLabelResult {
  labelEntryId: string;
  targetId: string;
  name: string;
  status: "created" | "already_present";
  label: string;
  rollback?: LabelRollbackToken;
  hostReturnedEntryId?: string;
}

export interface LabelMutationFailureDetails {
  targetId: string;
  name: string;
  priorLabel: string | undefined;
  labelAfter?: string | undefined;
  observedLabelEntryId?: string;
  hostReturnedEntryId?: string;
  hostError?: string;
  cause?: string;
}

export interface RollbackCheckpointLabelResult {
  targetId: string;
  label: string;
  restoredLabel: string | undefined;
}

export interface LabelRollbackFailureDetails {
  targetId: string;
  label: string;
  expectedLabel: string | undefined;
  labelBefore?: string | undefined;
  labelAfter?: string | undefined;
  hostError?: string;
  compensationError?: string;
  cause?: string;
}

export interface BranchWithSummaryPrevalidation {
  branchFromId: string;
  leafBefore: string | null;
}

export interface BranchWithSummaryResult {
  summaryEntryId: string;
  branchFromId: string;
  summary: string;
  leafBefore: string | null;
  leafAfter: string;
  hostReturnedEntryId?: string;
}

export interface BranchMutationFailureDetails {
  branchFromId: string;
  leafBefore: string | null;
  leafAfter?: string | null;
  actualSummaryEntryId?: string;
  hostReturnedEntryId?: string;
  hostError?: string;
  cause?: string;
}

function success<Value>(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

function failure<Details>(error: HostBridgeErrorCode, message: string, details: Details): HostFailure<Details> {
  return { ok: false, error, message, details };
}

function hasFunction(sm: unknown, name: string): boolean {
  if (sm === null || (typeof sm !== "object" && typeof sm !== "function")) return false;
  try {
    return typeof Reflect.get(sm as object, name) === "function";
  } catch {
    return false;
  }
}

function getHostMethod<Method>(sm: unknown, name: string): Method | undefined {
  if (sm === null || (typeof sm !== "object" && typeof sm !== "function")) return undefined;
  try {
    const method = Reflect.get(sm as object, name);
    return typeof method === "function"
      ? Function.prototype.bind.call(method, sm) as Method
      : undefined;
  } catch {
    return undefined;
  }
}

function isLabelEntry(entry: SessionEntry): entry is LabelEntry {
  return entry.type === "label";
}

function findLastEntry<Entry>(entries: Entry[], predicate: (entry: Entry) => boolean): Entry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (predicate(entry)) return entry;
  }
  return undefined;
}

function currentLabel(sm: ReadonlySessionManager, targetId: string): string | undefined {
  return buildLabelMaps(sm.getEntries()).entryToLabel.get(targetId);
}

function findNewLabelEntry(
  entries: SessionEntry[],
  beforeIds: Set<string>,
  targetId: string,
  name: string,
): LabelEntry | undefined {
  return findLastEntry(
    entries,
    (entry) => !beforeIds.has(entry.id) && isLabelEntry(entry) && entry.targetId === targetId && entry.label === name,
  ) as LabelEntry | undefined;
}

export function getHostCapabilities(sm: ReadonlySessionManager): HostBridgeCapabilities {
  return {
    appendLabelChange: hasFunction(sm, "appendLabelChange"),
    branchWithSummary: hasFunction(sm, "branchWithSummary"),
  };
}

export function buildSessionMessages(
  sm: ReadonlySessionManager,
  leafId?: string | null,
): HostResult<AgentMessage[], { leafId: string | null; cause: string }> {
  let effectiveLeaf: string | null = leafId ?? null;
  let entries: SessionEntry[];
  try {
    if (leafId === undefined) effectiveLeaf = sm.getLeafId();
    entries = sm.getEntries();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failure("host_operation_failed", `Failed to read session state: ${cause}`, { leafId: effectiveLeaf, cause });
  }
  try {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return success(buildSessionContext(entries, effectiveLeaf, byId).messages as AgentMessage[]);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failure("malformed_capability", `Failed to build session messages: ${cause}`, { leafId: effectiveLeaf, cause });
  }
}

export function prevalidateCheckpointLabel(
  sm: ReadonlySessionManager,
  targetId: string,
  name: string,
): HostResult<CheckpointLabelPrevalidation, { targetId: string; name: string } | ({ targetId: string; name: string } & HostObservationFailureDetails) | CheckpointLabelConflict | CheckpointLabelDisplacement> {
  if (isReservedTargetName(name)) {
    return failure("reserved_name", `Checkpoint name '${name}' is reserved for the structural root target`, { targetId, name });
  }
  if (!getHostCapabilities(sm).appendLabelChange) {
    return failure("missing_capability", "SessionManager does not support appendLabelChange — cannot create checkpoint label", { targetId, name });
  }
  try {
    if (!sm.getEntry(targetId)) return failure("entry_not_found", `Entry ${targetId} not found`, { targetId, name });

    const entries = sm.getEntries();
    const maps = buildLabelMaps(entries);
    const existingOwner = maps.labelToEntryId.get(name);
    if (existingOwner && existingOwner !== targetId) {
      const activeIds = new Set(sm.getBranch().map((entry) => entry.id));
      return failure("label_conflict", `Checkpoint name '${name}' already exists at ${existingOwner}`, {
        entryId: existingOwner,
        onActivePath: activeIds.has(existingOwner),
      });
    }

    const existingLabel = maps.entryToLabel.get(targetId);
    if (existingLabel === name) {
      const existing = findLastEntry(
        entries,
        (entry) => isLabelEntry(entry) && entry.targetId === targetId && entry.label === name,
      ) as LabelEntry | undefined;
      if (!existing) {
        return failure("malformed_capability", `Checkpoint '${name}' is the current label but has no label journal entry`, { targetId, name });
      }
      return success({ targetId, name, status: "already_present", existingLabel, existingLabelEntryId: existing.id });
    }
    // The host keeps one label per entry, so writing this name would erase the
    // existing one — and a save point that vanishes silently is worse than none.
    if (existingLabel !== undefined) {
      return failure(
        "label_displaces_existing",
        `Entry ${targetId} already carries checkpoint '${existingLabel}'; writing '${name}' would replace it because the host keeps one label per entry`,
        { targetId, name, existingLabel },
      );
    }
    return success({ targetId, name, status: "would_create", existingLabel: undefined });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failure("host_operation_failed", `Failed to inspect checkpoint label state: ${cause}`, { targetId, name, cause });
  }
}

export function appendCheckpointLabel(
  sm: ReadonlySessionManager,
  targetId: string,
  name: string,
): HostMutationResult<AppendCheckpointLabelResult, LabelMutationFailureDetails | { targetId: string; name: string } | CheckpointLabelConflict | CheckpointLabelDisplacement> {
  const prevalidation = prevalidateCheckpointLabel(sm, targetId, name);
  if (!prevalidation.ok) return { ...prevalidation, state: "not_applied" };
  if (prevalidation.value.status === "already_present") {
    return {
      ok: true,
      state: "not_applied",
      value: {
        labelEntryId: prevalidation.value.existingLabelEntryId!,
        targetId,
        name,
        status: "already_present",
        label: name,
      },
    };
  }

  const append = getHostMethod<(id: string, label: string | undefined) => unknown>(sm, "appendLabelChange");
  if (!append) {
    return {
      ...failure("missing_capability", "SessionManager no longer exposes appendLabelChange — checkpoint label was not created", { targetId, name }),
      state: "not_applied",
    };
  }

  let entriesBefore: SessionEntry[];
  let beforeIds: Set<string>;
  try {
    entriesBefore = sm.getEntries();
    beforeIds = new Set(entriesBefore.map((entry) => entry.id));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ...failure("host_operation_failed", `Failed to snapshot label state before append: ${cause}`, {
        targetId,
        name,
        priorLabel: prevalidation.value.existingLabel,
        labelAfter: prevalidation.value.existingLabel,
        cause,
      }),
      state: "not_applied",
    };
  }
  let returned: unknown;
  let hostError: string | undefined;
  try {
    returned = append(targetId, name);
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }

  const hostReturnedEntryId = typeof returned === "string" && returned.length > 0 ? returned : undefined;
  let entriesAfter: SessionEntry[];
  let labelAfter: string | undefined;
  let observed: LabelEntry | undefined;
  let owner: string | undefined;
  try {
    entriesAfter = sm.getEntries();
    labelAfter = currentLabel(sm, targetId);
    observed = findNewLabelEntry(entriesAfter, beforeIds, targetId, name);
    owner = buildLabelMaps(entriesAfter).labelToEntryId.get(name);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ...failure("host_operation_failed", `Could not verify appendLabelChange after mutation attempt: ${cause}`, {
        targetId,
        name,
        priorLabel: prevalidation.value.existingLabel,
        ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
        ...(hostError === undefined ? {} : { hostError }),
        cause,
      }),
      state: "indeterminate",
    };
  }
  if (owner === targetId && observed) {
    const rollback: LabelRollbackToken = { targetId, name, labelEntryId: observed.id, priorLabel: prevalidation.value.existingLabel };
    return {
      ok: true,
      state: "applied",
      value: {
        labelEntryId: observed.id,
        targetId,
        name,
        status: "created",
        label: labelAfter ?? name,
        rollback,
        ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
      },
    };
  }

  const changed = entriesAfter.length !== entriesBefore.length || labelAfter !== prevalidation.value.existingLabel;
  return {
    ...failure(
      hostError ? "host_operation_failed" : "malformed_capability",
      hostError ? `appendLabelChange failed: ${hostError}` : "appendLabelChange did not create the expected label journal entry",
      {
        targetId,
        name,
        priorLabel: prevalidation.value.existingLabel,
        labelAfter,
        ...(observed === undefined ? {} : { observedLabelEntryId: observed.id }),
        ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
        ...(hostError === undefined ? {} : { hostError }),
      },
    ),
    state: changed ? "indeterminate" : "not_applied",
  };
}

export function rollbackCheckpointLabel(
  sm: ReadonlySessionManager,
  token: LabelRollbackToken,
): HostMutationResult<RollbackCheckpointLabelResult, LabelRollbackFailureDetails> {
  const append = getHostMethod<(id: string, label: string | undefined) => unknown>(sm, "appendLabelChange");
  if (!append) {
    return {
      ...failure(
        "missing_capability",
        "SessionManager does not support appendLabelChange — cannot roll back checkpoint label",
        { targetId: token.targetId, label: token.name, expectedLabel: token.priorLabel },
      ),
      state: "not_applied",
    };
  }

  let labelBefore: string | undefined;
  try {
    labelBefore = currentLabel(sm, token.targetId);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ...failure("host_operation_failed", `Failed to snapshot the label before checkpoint rollback: ${cause}`, {
        targetId: token.targetId,
        label: token.name,
        expectedLabel: token.priorLabel,
        cause,
      }),
      state: "not_applied",
    };
  }
  // Only undo what this token actually wrote. If the entry no longer carries
  // that label, something else moved it and a blind restore would clobber it.
  if (labelBefore !== token.name) {
    return {
      ...failure(
        "unsafe_rollback",
        "The checkpoint label changed after append; rollback would overwrite another operation",
        {
          targetId: token.targetId,
          label: token.name,
          expectedLabel: token.priorLabel,
          labelBefore,
          labelAfter: labelBefore,
        },
      ),
      state: "indeterminate",
    };
  }

  // The host keeps one label per entry, so restoring is a single write: the
  // prior label, or a clear when the entry carried none.
  let hostError: string | undefined;
  let compensationError: string | undefined;
  const restorePriorLabel = (): void => {
    append(token.targetId, token.priorLabel);
  };
  try {
    restorePriorLabel();
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
    try {
      restorePriorLabel();
    } catch (retryError) {
      compensationError = retryError instanceof Error ? retryError.message : String(retryError);
    }
  }
  let labelAfter: string | undefined;
  try {
    labelAfter = currentLabel(sm, token.targetId);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ...failure("host_operation_failed", `Could not verify checkpoint rollback after mutation attempt: ${cause}`, {
        targetId: token.targetId,
        label: token.name,
        expectedLabel: token.priorLabel,
        labelBefore,
        ...(hostError === undefined ? {} : { hostError }),
        ...(compensationError === undefined ? {} : { compensationError }),
        cause,
      }),
      state: "indeterminate",
    };
  }
  if (labelAfter === token.priorLabel) {
    return { ok: true, state: "applied", value: { targetId: token.targetId, label: token.name, restoredLabel: labelAfter } };
  }
  return {
    ...failure(
      hostError ? "host_operation_failed" : "malformed_capability",
      hostError ? `appendLabelChange rollback failed: ${hostError}` : "appendLabelChange rollback did not restore the previous label",
      {
        targetId: token.targetId,
        label: token.name,
        expectedLabel: token.priorLabel,
        labelBefore,
        labelAfter,
        ...(hostError === undefined ? {} : { hostError }),
        ...(compensationError === undefined ? {} : { compensationError }),
      },
    ),
    state: "indeterminate",
  };
}

export function prevalidateBranchWithSummary(
  sm: ReadonlySessionManager,
  branchFromId: string,
): HostResult<BranchWithSummaryPrevalidation, { branchFromId: string } | ({ branchFromId: string } & HostObservationFailureDetails)> {
  if (!getHostCapabilities(sm).branchWithSummary) {
    return failure("missing_capability", "SessionManager does not support branchWithSummary — cannot travel", { branchFromId });
  }
  try {
    if (!sm.getEntry(branchFromId)) return failure("entry_not_found", `Entry ${branchFromId} not found`, { branchFromId });
    return success({ branchFromId, leafBefore: sm.getLeafId() });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failure("host_operation_failed", `Failed to inspect branch state before travel: ${cause}`, { branchFromId, cause });
  }
}

export function applyBranchWithSummary(
  sm: ReadonlySessionManager,
  branchFromId: string,
  summary: string,
  details?: unknown,
): HostMutationResult<BranchWithSummaryResult, BranchMutationFailureDetails | { branchFromId: string }> {
  const prevalidation = prevalidateBranchWithSummary(sm, branchFromId);
  if (!prevalidation.ok) return { ...prevalidation, state: "not_applied" };
  const { leafBefore } = prevalidation.value;
  const branch = getHostMethod<(id: string | null, summary: string, details?: unknown, fromExtension?: boolean) => unknown>(sm, "branchWithSummary");
  if (!branch) {
    return {
      ...failure("missing_capability", "SessionManager no longer exposes branchWithSummary — travel was not applied", { branchFromId }),
      state: "not_applied",
    };
  }

  let returned: unknown;
  let hostError: string | undefined;
  try {
    returned = branch(branchFromId, summary, details, true);
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }

  const hostReturnedEntryId = typeof returned === "string" && returned.length > 0 ? returned : undefined;
  let leafAfter: string | null;
  let exactSummary = false;
  let actualSummaryEntryId: string | undefined;
  try {
    leafAfter = sm.getLeafId();
    const leafEntry = leafAfter ? sm.getEntry(leafAfter) : undefined;
    if (leafEntry?.type === "branch_summary") {
      actualSummaryEntryId = leafAfter ?? undefined;
      exactSummary = leafEntry.parentId === branchFromId && leafEntry.summary === summary;
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ...failure("host_operation_failed", `Could not verify branchWithSummary after mutation attempt: ${cause}`, {
        branchFromId,
        leafBefore,
        ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
        ...(hostError === undefined ? {} : { hostError }),
        cause,
      }),
      state: "indeterminate",
    };
  }
  if (exactSummary && leafAfter && leafAfter !== leafBefore) {
    return {
      ok: true,
      state: "applied",
      value: {
        summaryEntryId: leafAfter,
        branchFromId,
        summary,
        leafBefore,
        leafAfter,
        ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
      },
    };
  }

  const failureDetails: BranchMutationFailureDetails = {
    branchFromId,
    leafBefore,
    leafAfter,
    ...(actualSummaryEntryId === undefined ? {} : { actualSummaryEntryId }),
    ...(hostReturnedEntryId === undefined ? {} : { hostReturnedEntryId }),
    ...(hostError === undefined ? {} : { hostError }),
  };
  return {
    ...failure(
      hostError ? "host_operation_failed" : "branch_verification_failed",
      hostError
        ? `branchWithSummary failed: ${hostError}`
        : exactSummary && leafAfter === leafBefore
          ? "branchWithSummary left the active leaf unchanged; the matching summary predates this mutation attempt"
          : "branchWithSummary did not create the expected summary entry at the resulting leaf",
      failureDetails,
    ),
    state: leafAfter === leafBefore ? "not_applied" : "indeterminate",
  };
}
