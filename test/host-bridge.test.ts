import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyBranchWithSummary,
  appendCheckpointLabel,
  buildSessionMessages,
  getHostCapabilities,
  prevalidateBranchWithSummary,
  prevalidateCheckpointLabel,
  rollbackCheckpointLabel,
} from "../src/host-bridge.js";

function userEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello", timestamp: 0 },
  } as SessionEntry;
}

function labelEntry(id: string, targetId: string, label: string | undefined): SessionEntry {
  return {
    type: "label",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    targetId,
    label,
  } as SessionEntry;
}

function branchSummaryEntry(id: string, parentId: string, summary: string): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: parentId,
    summary,
    details: null,
  } as SessionEntry;
}

describe("Host Bridge exception containment", () => {
  test("returns a typed failure when reading the current leaf throws", () => {
    const session = {
      getLeafId: () => { throw new Error("leaf unavailable"); },
      getEntries: () => [userEntry("entry-1")],
    };

    expect(() => buildSessionMessages(session as never)).not.toThrow();
    expect(buildSessionMessages(session as never)).toMatchObject({
      ok: false,
      error: "host_operation_failed",
      details: { leafId: null, cause: "leaf unavailable" },
    });
  });

  test("treats throwing capability getters as unavailable instead of leaking the exception", () => {
    const session = {
      get appendLabelChange() { throw new Error("getter exploded"); },
      get branchWithSummary() { throw new Error("getter exploded"); },
    };

    expect(() => getHostCapabilities(session as never)).not.toThrow();
    expect(getHostCapabilities(session as never)).toEqual({
      appendLabelChange: false,
      branchWithSummary: false,
    });
  });

  test("returns a typed prevalidation failure when a host observation throws", () => {
    const session = {
      appendLabelChange() {},
      getEntry: () => { throw new Error("entry read failed"); },
    };

    expect(() => prevalidateCheckpointLabel(session as never, "entry-1", "safe-name")).not.toThrow();
    expect(prevalidateCheckpointLabel(session as never, "entry-1", "safe-name")).toMatchObject({
      ok: false,
      error: "host_operation_failed",
      details: { targetId: "entry-1", name: "safe-name", cause: "entry read failed" },
    });
  });

  test("classifies a failed pre-mutation snapshot as not applied", () => {
    const entry = userEntry("entry-1");
    let reads = 0;
    let mutations = 0;
    const session = {
      appendLabelChange: () => { mutations++; },
      getEntry: () => entry,
      getEntries: () => {
        reads++;
        if (reads === 2) throw new Error("before snapshot failed");
        return [entry];
      },
      getBranch: () => [entry],
    };

    const result = appendCheckpointLabel(session as never, entry.id, "safe-name");
    expect(result).toMatchObject({
      ok: false,
      state: "not_applied",
      error: "host_operation_failed",
      details: { targetId: entry.id, name: "safe-name", cause: "before snapshot failed" },
    });
    expect(mutations).toBe(0);
  });

  test("classifies a failed post-mutation observation as indeterminate", () => {
    const entry = userEntry("entry-1");
    let reads = 0;
    let mutations = 0;
    const session = {
      appendLabelChange: () => { mutations++; return "label-1"; },
      getEntry: () => entry,
      getEntries: () => {
        reads++;
        if (reads === 3) throw new Error("after snapshot failed");
        return [entry];
      },
      getBranch: () => [entry],
    };

    const result = appendCheckpointLabel(session as never, entry.id, "safe-name");
    expect(result).toMatchObject({
      ok: false,
      state: "indeterminate",
      error: "host_operation_failed",
      details: { targetId: entry.id, name: "safe-name", cause: "after snapshot failed" },
    });
    expect(mutations).toBe(1);
  });

  test("does not start rollback when the current alias observation fails", () => {
    let mutations = 0;
    const session = {
      appendLabelChange: () => { mutations++; },
      getEntries: () => { throw new Error("rollback snapshot failed"); },
    };

    const result = rollbackCheckpointLabel(session as never, {
      targetId: "entry-1",
      name: "temporary",
      labelEntryId: "label-temp",
      priorAliases: ["keeper"],
    });
    expect(result).toMatchObject({
      ok: false,
      state: "not_applied",
      error: "host_operation_failed",
      details: { targetId: "entry-1", label: "temporary", cause: "rollback snapshot failed" },
    });
    expect(mutations).toBe(0);
  });

  test("marks rollback indeterminate when post-mutation verification cannot be observed", () => {
    const entry = userEntry("entry-1");
    const entries = [
      entry,
      labelEntry("label-keeper", entry.id, "keeper"),
      labelEntry("label-temp", entry.id, "temporary"),
    ];
    let reads = 0;
    let mutations = 0;
    const session = {
      appendLabelChange: () => { mutations++; },
      getEntries: () => {
        reads++;
        if (reads === 2) throw new Error("rollback verification failed");
        return entries;
      },
    };

    const result = rollbackCheckpointLabel(session as never, {
      targetId: entry.id,
      name: "temporary",
      labelEntryId: "label-temp",
      priorAliases: ["keeper"],
    });
    expect(result).toMatchObject({
      ok: false,
      state: "indeterminate",
      error: "host_operation_failed",
      details: { targetId: entry.id, label: "temporary", cause: "rollback verification failed" },
    });
    expect(mutations).toBe(2);
  });

  test("enforces the structural root reservation at the host mutation boundary", () => {
    const result = prevalidateCheckpointLabel({} as never, "entry-1", "ROOT");
    expect(result).toMatchObject({
      ok: false,
      error: "reserved_name",
      details: { targetId: "entry-1", name: "ROOT" },
    });
  });

  test("returns a typed branch prevalidation failure when host state cannot be observed", () => {
    const session = {
      branchWithSummary() {},
      getEntry: () => { throw new Error("branch entry read failed"); },
    };

    const result = prevalidateBranchWithSummary(session as never, "entry-1");
    expect(result).toMatchObject({
      ok: false,
      error: "host_operation_failed",
      details: { branchFromId: "entry-1", cause: "branch entry read failed" },
    });
  });

  test("does not report a pre-existing equivalent summary as applied when the host throws", () => {
    const entry = userEntry("entry-1");
    const existing = branchSummaryEntry("existing-summary", entry.id, "summary");
    const session = {
      branchWithSummary: () => { throw new Error("host refused"); },
      getEntry: (id: string) => id === entry.id ? entry : id === existing.id ? existing : undefined,
      getLeafId: () => existing.id,
    };

    const result = applyBranchWithSummary(session as never, entry.id, "summary");
    expect(result).toMatchObject({
      ok: false,
      state: "not_applied",
      error: "host_operation_failed",
      details: {
        branchFromId: entry.id,
        leafBefore: existing.id,
        leafAfter: existing.id,
        actualSummaryEntryId: existing.id,
        hostError: "host refused",
      },
    });
  });

  test("does not report a pre-existing equivalent summary as applied when the host is a no-op", () => {
    const entry = userEntry("entry-1");
    const existing = branchSummaryEntry("existing-summary", entry.id, "summary");
    const session = {
      branchWithSummary: () => existing.id,
      getEntry: (id: string) => id === entry.id ? entry : id === existing.id ? existing : undefined,
      getLeafId: () => existing.id,
    };

    const result = applyBranchWithSummary(session as never, entry.id, "summary");
    expect(result).toMatchObject({
      ok: false,
      state: "not_applied",
      error: "branch_verification_failed",
      message: "branchWithSummary left the active leaf unchanged; the matching summary predates this mutation attempt",
      details: {
        branchFromId: entry.id,
        leafBefore: existing.id,
        leafAfter: existing.id,
        actualSummaryEntryId: existing.id,
        hostReturnedEntryId: existing.id,
      },
    });
  });

  test("accepts a newly observed equivalent summary leaf", () => {
    const entry = userEntry("entry-1");
    const existing = branchSummaryEntry("existing-summary", entry.id, "summary");
    const created = branchSummaryEntry("new-summary", entry.id, "summary");
    let leafId = existing.id;
    const session = {
      branchWithSummary: () => { leafId = created.id; return created.id; },
      getEntry: (id: string) => id === entry.id ? entry : id === existing.id ? existing : id === created.id ? created : undefined,
      getLeafId: () => leafId,
    };

    const result = applyBranchWithSummary(session as never, entry.id, "summary");
    expect(result).toMatchObject({
      ok: true,
      state: "applied",
      value: {
        summaryEntryId: created.id,
        leafBefore: existing.id,
        leafAfter: created.id,
        hostReturnedEntryId: created.id,
      },
    });
  });

  test("accepts an observed summary mutation even when the host throws afterward", () => {
    const entry = userEntry("entry-1");
    const created = branchSummaryEntry("new-summary", entry.id, "summary");
    let leafId = entry.id;
    const session = {
      branchWithSummary: () => { leafId = created.id; throw new Error("late host failure"); },
      getEntry: (id: string) => id === entry.id ? entry : id === created.id ? created : undefined,
      getLeafId: () => leafId,
    };

    const result = applyBranchWithSummary(session as never, entry.id, "summary");
    expect(result).toMatchObject({
      ok: true,
      state: "applied",
      value: { summaryEntryId: created.id, leafBefore: entry.id, leafAfter: created.id },
    });
  });

  test("marks branch mutation indeterminate when the resulting leaf cannot be observed", () => {
    const entry = userEntry("entry-1");
    let leafReads = 0;
    let mutations = 0;
    const session = {
      branchWithSummary: () => { mutations++; return "summary-1"; },
      getEntry: (id: string) => id === entry.id ? entry : undefined,
      getLeafId: () => {
        leafReads++;
        if (leafReads === 2) throw new Error("resulting leaf unavailable");
        return entry.id;
      },
    };

    const result = applyBranchWithSummary(session as never, entry.id, "summary");
    expect(result).toMatchObject({
      ok: false,
      state: "indeterminate",
      error: "host_operation_failed",
      details: { branchFromId: entry.id, leafBefore: entry.id, cause: "resulting leaf unavailable" },
    });
    expect(mutations).toBe(1);
  });
});
