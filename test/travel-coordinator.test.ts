import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { executeTravelMutation } from "../src/travel-coordinator.js";

function userEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello", timestamp: 0 },
  } as SessionEntry;
}

function labelEntry(id: string, targetId: string, label: string): SessionEntry {
  return {
    type: "label",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    targetId,
    label,
  } as SessionEntry;
}

describe("travel mutation recovery", () => {
  test("preserves a typed failure when backup-label presence cannot be observed", () => {
    const entry = userEntry("entry-1");
    let reads = 0;
    let branchCalls = 0;
    const sessionManager = {
      appendLabelChange: () => "label-1",
      branchWithSummary: () => { branchCalls++; return "summary-1"; },
      getEntry: (id: string) => id === entry.id ? entry : undefined,
      getEntries: () => {
        reads++;
        if (reads >= 3) throw new Error("persistent read failure");
        return [entry];
      },
      getBranch: () => [entry],
      getLeafId: () => entry.id,
    };

    const outcome = executeTravelMutation({
      sessionManager: sessionManager as never,
      targetId: entry.id,
      summary: "summary",
      details: {},
      backup: {
        targetId: entry.id,
        name: "archive-done",
        prevalidation: { targetId: entry.id, name: "archive-done", status: "would_create", aliases: [] },
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "backup_label_failed",
      backupOutcome: "indeterminate",
      remainingBackupLabel: null,
      remainingBackupLabelState: "unknown",
    });
    expect(branchCalls).toBe(0);
  });

  test("honors global alias reassignment when reporting whether a backup label remains", () => {
    const original = userEntry("entry-a");
    const newOwner = userEntry("entry-b");
    const entries = [
      original,
      newOwner,
      labelEntry("label-a", original.id, "archive-done"),
      labelEntry("label-b", newOwner.id, "archive-done"),
    ];
    const sessionManager = {
      branchWithSummary: () => "",
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      getEntries: () => entries,
      getBranch: () => [original],
      getLeafId: () => original.id,
    };

    const outcome = executeTravelMutation({
      sessionManager: sessionManager as never,
      targetId: original.id,
      summary: "summary",
      details: {},
      backup: {
        targetId: original.id,
        name: "archive-done",
        prevalidation: {
          targetId: original.id,
          name: "archive-done",
          status: "already_present",
          aliases: ["archive-done"],
          existingLabelEntryId: "label-a",
        },
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "branch_failed",
      remainingBackupLabel: null,
      remainingBackupLabelState: "absent",
    });
  });
});
