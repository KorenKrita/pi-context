import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { AcmSessionRuntime } from "../src/runtime.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerTravelTool } from "../src/travel-tool.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type ExecuteTool = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResult>;

function userEntry(id: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
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

function captureExecute(register: (pi: ExtensionAPI) => void): ExecuteTool {
  let execute: ExecuteTool | undefined;
  register({
    registerTool(tool: { execute?: ExecuteTool }) {
      execute = tool.execute;
    },
  } as unknown as ExtensionAPI);
  if (!execute) throw new Error("tool execute handler was not registered");
  return execute;
}

function checkpointContext() {
  const entry = userEntry("entry-1");
  const tree: SessionTreeNode[] = [{ entry, children: [] }];
  let appendCalls = 0;
  let branchCalls = 0;
  const sessionManager = {
    getTree: () => tree,
    getEntries: () => [entry],
    getBranch: () => [entry],
    getLeafId: () => entry.id,
    getEntry: (id: string) => id === entry.id ? entry : undefined,
    appendLabelChange: () => {
      appendCalls++;
      return "label-1";
    },
    branchWithSummary: () => {
      branchCalls++;
      return "summary-1";
    },
  };
  return {
    ctx: {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
    getAppendCalls: () => appendCalls,
    getBranchCalls: () => branchCalls,
  };
}

function timelineContext() {
  const root = userEntry("entry-1");
  const entries = [
    root,
    labelEntry("label-1", root.id, "alpha"),
    labelEntry("label-2", root.id, "beta"),
    labelEntry("label-3", root.id, "gamma"),
    labelEntry("label-4", root.id, "delta"),
  ];
  const sessionManager = {
    getTree: () => [{ entry: root, children: [] }],
    getEntries: () => entries,
    getBranch: () => [root],
    getLeafId: () => root.id,
  };
  return {
    sessionManager,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    ui: { notify() {} },
  };
}

function indeterminateTravelContext() {
  const root = userEntry("entry-1");
  const head = userEntry("entry-2", root.id);
  const entries: SessionEntry[] = [root, head];
  let leafId = head.id;
  let branchAttempted = false;
  const sessionManager = {
    getTree: () => [{ entry: root, children: [{ entry: head, children: [] }] }],
    getEntries: () => {
      if (branchAttempted) throw new Error("label presence unavailable");
      return entries;
    },
    getBranch: (fromId?: string) => fromId === root.id ? [root] : [root, head],
    getLeafId: () => leafId,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: (targetId: string, label: string | undefined) => {
      const id = `label-${entries.length}`;
      entries.push({
        type: "label",
        id,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        targetId,
        label,
      } as SessionEntry);
      return id;
    },
    branchWithSummary: () => {
      branchAttempted = true;
      leafId = "unverified-summary";
      return leafId;
    },
  };
  return {
    sessionManager,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    ui: { notify() {} },
  };
}

const executeCheckpoint = captureExecute(registerCheckpointTool);
const executeTimeline = captureExecute((pi) => registerTimelineTool(pi, new AcmSessionRuntime()));
const executeTravel = captureExecute((pi) => registerTravelTool(pi, new AcmSessionRuntime()));
const HANDOFF = [
  "Goal: preserve the current task",
  "State: ready to fold",
  "Evidence: test fixture",
  "External: none",
  "Exclusions: none",
  "Recover: archive-done",
  "NEXT: continue",
].join("\n");

describe("ACM tool execution contracts", () => {
  test("rejects every case variant of the reserved structural root name without mutating labels", async () => {
    for (const name of ["root", "ROOT", "Root", "rOoT"]) {
      const { ctx, getAppendCalls } = checkpointContext();
      const result = await executeCheckpoint("call-1", { name }, undefined, undefined, ctx);
      expect(result.details).toMatchObject({ error: "reserved_name", name });
      expect(result.content[0]?.text).toContain("reserved");
      expect(getAppendCalls()).toBe(0);
    }
  });

  test("rejects every case variant of root as an archive bookmark before any mutation", async () => {
    for (const name of ["root", "ROOT", "Root", "rOoT"]) {
      const { ctx, getAppendCalls, getBranchCalls } = checkpointContext();
      const result = await executeTravel(
        "call-2",
        { target: "entry-1", summary: HANDOFF, backupCurrentHeadAs: name },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toMatchObject({ error: "reserved_backup_name", name });
      expect(result.content[0]?.text).toContain("reserved");
      expect(getAppendCalls()).toBe(0);
      expect(getBranchCalls()).toBe(0);
    }
  });

  test("reports the caller-supplied checkpoint display limit instead of a hard-coded cap", async () => {
    const result = await executeTimeline(
      "call-3",
      { view: "checkpoints", limit: 2 },
      undefined,
      undefined,
      timelineContext(),
    );
    expect(result.details).toMatchObject({ view: "checkpoints", limit: 2, checkpointsDisplayedAliases: 2 });
    expect(result.content[0]?.text).toContain("; cap 2)");
    expect(result.content[0]?.text).not.toContain("; cap 50)");
  });

  test("does not claim an unobservable backup label definitely remains after skipped rollback", async () => {
    const result = await executeTravel(
      "call-4",
      { target: "entry-1", summary: HANDOFF, backupCurrentHeadAs: "archive-done" },
      undefined,
      undefined,
      indeterminateTravelContext(),
    );
    expect(result.details).toMatchObject({
      error: "branch_failed",
      backupRollbackSkipped: true,
      remainingBackupLabelState: "unknown",
    });
    expect(result.content[0]?.text).toContain("may remain");
    expect(result.content[0]?.text).not.toContain("remains because branch mutation");
  });

  test("does not invent a backup pointer for indeterminate travel without a backup", async () => {
    const result = await executeTravel(
      "call-5",
      { target: "entry-1", summary: HANDOFF },
      undefined,
      undefined,
      indeterminateTravelContext(),
    );
    expect(result.details).toMatchObject({ error: "branch_failed", branchState: "indeterminate" });
    expect(result.content[0]?.text).toContain("Branch mutation cannot be excluded");
    expect(result.content[0]?.text).not.toContain("backup pointer");
  });
});
