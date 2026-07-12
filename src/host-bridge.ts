import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export type ReadonlySessionManager = Pick<
  SessionManager,
  "getLeafId" | "getEntry" | "getBranch" | "getEntries"
>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { buildLabelMaps } from "./lib.js";

export type HostBridgeErrorCode =
  | "missing_capability"
  | "malformed_capability"
  | "host_operation_failed"
  | "branch_verification_failed"
  | "entry_not_found"
  | "label_conflict"
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
  aliases: string[];
  existingLabelEntryId?: string;
}

export interface CheckpointLabelConflict {
  entryId: string;
  onActivePath: boolean;
}

export interface LabelRollbackToken {
  targetId: string;
  name: string;
  labelEntryId: string;
  priorAliases: string[];
}

export interface AppendCheckpointLabelResult {
  labelEntryId: string;
  targetId: string;
  name: string;
  status: "created" | "already_present";
  aliases: string[];
  rollback?: LabelRollbackToken;
  hostReturnedEntryId?: string;
}

export interface LabelMutationFailureDetails {
  targetId: string;
  name: string;
  priorAliases: string[];
  aliasesAfter: string[];
  observedLabelEntryId?: string;
  hostReturnedEntryId?: string;
  hostError?: string;
}

export interface RollbackCheckpointLabelResult {
  targetId: string;
  label: string;
  restoredAliases: string[];
}

export interface LabelRollbackFailureDetails {
  targetId: string;
  label: string;
  expectedAliases: string[];
  aliasesBefore: string[];
  aliasesAfter: string[];
  hostError?: string;
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
  leafAfter: string | null;
  actualSummaryEntryId?: string;
  hostReturnedEntryId?: string;
  hostError?: string;
}

function success<Value>(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

function failure<Details>(error: HostBridgeErrorCode, message: string, details: Details): HostFailure<Details> {
  return { ok: false, error, message, details };
}

function hasFunction(sm: unknown, name: string): boolean {
  if (sm === null || typeof sm !== "object") return false;
  const record = sm as Record<string, unknown>;
  return name in record && typeof record[name] === "function";
}

function getHostMethod<Method>(sm: unknown, name: string): Method | undefined {
  if (!hasFunction(sm, name)) return undefined;
  const record = sm as Record<string, unknown>;
  return Function.prototype.bind.call(record[name] as Function, sm) as Method;
}

function isLabelEntry(entry: SessionEntry): entry is LabelEntry {
  return entry.type === "label";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findLastEntry<Entry>(entries: Entry[], predicate: (entry: Entry) => boolean): Entry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (predicate(entry)) return entry;
  }
  return undefined;
}

function currentAliases(sm: ReadonlySessionManager, targetId: string): string[] {
  return buildLabelMaps(sm.getEntries()).entryToLabels.get(targetId) ?? [];
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
  const effectiveLeaf = leafId === undefined ? sm.getLeafId() : leafId;
  try {
    const entries = sm.getEntries();
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
): HostResult<CheckpointLabelPrevalidation, { targetId: string; name: string } | CheckpointLabelConflict> {
  if (!getHostCapabilities(sm).appendLabelChange) {
    return failure("missing_capability", "SessionManager does not support appendLabelChange — cannot create checkpoint label", { targetId, name });
  }
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

  const aliases = maps.entryToLabels.get(targetId) ?? [];
  if (aliases.includes(name)) {
    const existing = findLastEntry(
      entries,
      (entry) => isLabelEntry(entry) && entry.targetId === targetId && entry.label === name,
    ) as LabelEntry | undefined;
    if (!existing) {
      return failure("malformed_capability", `Checkpoint '${name}' is present in the alias map but has no label journal entry`, { targetId, name });
    }
    return success({ targetId, name, status: "already_present", aliases, existingLabelEntryId: existing.id });
  }
  return success({ targetId, name, status: "would_create", aliases });
}

export function appendCheckpointLabel(
  sm: ReadonlySessionManager,
  targetId: string,
  name: string,
): HostMutationResult<AppendCheckpointLabelResult, LabelMutationFailureDetails | { targetId: string; name: string } | CheckpointLabelConflict> {
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
        aliases: prevalidation.value.aliases,
      },
    };
  }

  const append = getHostMethod<(id: string, label: string | undefined) => unknown>(sm, "appendLabelChange")!;
  const entriesBefore = sm.getEntries();
  const beforeIds = new Set(entriesBefore.map((entry) => entry.id));
  let returned: unknown;
  let hostError: string | undefined;
  try {
    returned = append(targetId, name);
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }

  const entriesAfter = sm.getEntries();
  const aliasesAfter = currentAliases(sm, targetId);
  const observed = findNewLabelEntry(entriesAfter, beforeIds, targetId, name);
  const owner = buildLabelMaps(entriesAfter).labelToEntryId.get(name);
  const hostReturnedEntryId = typeof returned === "string" && returned.length > 0 ? returned : undefined;
  if (owner === targetId && observed) {
    const rollback: LabelRollbackToken = { targetId, name, labelEntryId: observed.id, priorAliases: prevalidation.value.aliases };
    return {
      ok: true,
      state: "applied",
      value: {
        labelEntryId: observed.id,
        targetId,
        name,
        status: "created",
        aliases: aliasesAfter,
        rollback,
        hostReturnedEntryId,
      },
    };
  }

  const changed = entriesAfter.length !== entriesBefore.length || !sameStrings(aliasesAfter, prevalidation.value.aliases);
  return {
    ...failure(
      hostError ? "host_operation_failed" : "malformed_capability",
      hostError ? `appendLabelChange failed: ${hostError}` : "appendLabelChange did not create the expected label journal entry",
      {
        targetId,
        name,
        priorAliases: prevalidation.value.aliases,
        aliasesAfter,
        observedLabelEntryId: observed?.id,
        hostReturnedEntryId,
        hostError,
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
  const aliasesBefore = currentAliases(sm, token.targetId);
  const expectedCurrent = [...token.priorAliases, token.name];
  if (!append || !sameStrings(aliasesBefore, expectedCurrent)) {
    return {
      ...failure(
        append ? "unsafe_rollback" : "missing_capability",
        append ? "Checkpoint aliases changed after append; rollback would overwrite another operation" : "SessionManager does not support appendLabelChange — cannot roll back checkpoint label",
        {
          targetId: token.targetId,
          label: token.name,
          expectedAliases: token.priorAliases,
          aliasesBefore,
          aliasesAfter: aliasesBefore,
        },
      ),
      state: append ? "indeterminate" : "not_applied",
    };
  }

  let hostError: string | undefined;
  try {
    append(token.targetId, undefined);
    for (const alias of token.priorAliases) append(token.targetId, alias);
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }
  const aliasesAfter = currentAliases(sm, token.targetId);
  if (sameStrings(aliasesAfter, token.priorAliases)) {
    return { ok: true, state: "applied", value: { targetId: token.targetId, label: token.name, restoredAliases: aliasesAfter } };
  }
  return {
    ...failure(
      hostError ? "host_operation_failed" : "malformed_capability",
      hostError ? `appendLabelChange rollback failed: ${hostError}` : "appendLabelChange rollback did not restore the previous aliases",
      {
        targetId: token.targetId,
        label: token.name,
        expectedAliases: token.priorAliases,
        aliasesBefore,
        aliasesAfter,
        hostError,
      },
    ),
    state: "indeterminate",
  };
}

export function prevalidateBranchWithSummary(
  sm: ReadonlySessionManager,
  branchFromId: string,
): HostResult<BranchWithSummaryPrevalidation, { branchFromId: string }> {
  if (!getHostCapabilities(sm).branchWithSummary) {
    return failure("missing_capability", "SessionManager does not support branchWithSummary — cannot travel", { branchFromId });
  }
  if (!sm.getEntry(branchFromId)) return failure("entry_not_found", `Entry ${branchFromId} not found`, { branchFromId });
  return success({ branchFromId, leafBefore: sm.getLeafId() });
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
  const branch = getHostMethod<(id: string | null, summary: string, details?: unknown, fromExtension?: boolean) => unknown>(sm, "branchWithSummary")!;

  let returned: unknown;
  let hostError: string | undefined;
  try {
    returned = branch(branchFromId, summary, details, true);
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
  }

  const leafAfter = sm.getLeafId();
  const leafEntry = leafAfter ? sm.getEntry(leafAfter) : undefined;
  const exactSummary = leafEntry?.type === "branch_summary" && leafEntry.parentId === branchFromId && leafEntry.summary === summary;
  const hostReturnedEntryId = typeof returned === "string" && returned.length > 0 ? returned : undefined;
  if (exactSummary && leafAfter) {
    return {
      ok: true,
      state: "applied",
      value: { summaryEntryId: leafAfter, branchFromId, summary, leafBefore, leafAfter, hostReturnedEntryId },
    };
  }

  const failureDetails: BranchMutationFailureDetails = {
    branchFromId,
    leafBefore,
    leafAfter,
    actualSummaryEntryId: leafEntry?.type === "branch_summary" ? leafAfter ?? undefined : undefined,
    hostReturnedEntryId,
    hostError,
  };
  return {
    ...failure(
      hostError ? "host_operation_failed" : "branch_verification_failed",
      hostError ? `branchWithSummary failed: ${hostError}` : "branchWithSummary did not create the expected summary entry at the resulting leaf",
      failureDetails,
    ),
    state: leafAfter === leafBefore ? "not_applied" : "indeterminate",
  };
}
