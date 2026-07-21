import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  SessionEntry,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
  countActiveSummaryDepth,
  projectSummaryDepthAfterTravel,
} from "../src/lib.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { GUIDANCE_CUES } from "../src/generated-guidance.js";

function message(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text },
  } as SessionEntry;
}

function summary(id: string, parentId: string, text: string): SessionEntry {
  return {
    id,
    type: "branch_summary",
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    fromId: parentId,
    summary: text,
  } as SessionEntry;
}

function node(entry: SessionEntry, children: SessionTreeNode[] = []): SessionTreeNode {
  return { entry, children };
}

function makeContext(entries: SessionEntry[], tree: SessionTreeNode[], branch: SessionEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    sessionManager: {
      getEntries: () => entries,
      getTree: () => tree,
      getBranch: (fromId?: string) => {
        if (fromId === undefined || fromId === branch.at(-1)?.id) return branch;
        const result: SessionEntry[] = [];
        let current = byId.get(fromId);
        while (current) {
          result.unshift(current);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return result;
      },
      getLeafId: () => branch.at(-1)?.id ?? null,
      getEntry: (id: string) => byId.get(id),
      getLabel: () => undefined,
      buildSessionContext: () => ({ messages: [] }),
    },
    getContextUsage: () => undefined,
  };
}

function captureTimelineTool() {
  let timeline: any;
  const pi = {
    registerTool(tool: any) {
      if (tool.name === "acm_timeline") timeline = tool;
    },
  };
  const runtime = {
    getUsage: () => undefined,
    contextRefresh: {
      getFailure: () => undefined,
      isPending: () => false,
      getAttemptCount: () => 0,
      hasRebuilt: () => false,
    },
    getContextDeliveryPhase: () => "active",
    getLiveAgentSyncStatus: () => ({ status: "idle" }),
  };
  registerTimelineTool(pi as ExtensionAPI, runtime as never);
  if (!timeline) throw new Error("acm_timeline was not registered");
  return timeline;
}

describe("semantic rebase evidence", () => {
  test("counts only semantic branch summaries and projects one new travel layer", () => {
    const root = message("root", null, "root");
    const first = summary("summary-1", "root", "first");
    const nativeCompaction = {
      ...summary("compaction", "summary-1", "native"),
      type: "compaction",
    } as SessionEntry;

    expect(countActiveSummaryDepth([root, first, nativeCompaction])).toBe(1);
    expect(projectSummaryDepthAfterTravel([root, first, nativeCompaction])).toBe(2);
    expect(projectSummaryDepthAfterTravel([root])).toBe(1);
  });

  test("active HUD exposes stacked-summary evidence and the canonical rebase cue", async () => {
    const root = message("root", null, "root");
    const first = summary("summary-1", "root", "first handoff");
    const current = message("current", "summary-1", "current");
    const branch = [root, first, current];
    const tool = captureTimelineTool();

    const result = await tool.execute(
      "timeline-test",
      { view: "active", limit: 50 },
      undefined,
      undefined,
      makeContext(branch, [node(root, [node(first, [node(current)])])], branch),
    );

    expect(result.details).toMatchObject({ activeSummaryDepth: 1 });
    expect(result.content[0].text).toContain("Summary Depth:    1 active handoff summary layer(s) on the current spine");
    expect(result.content[0].text).not.toContain("normalized rebase");
    expect(result.content[0].text).toContain(GUIDANCE_CUES.rebaseCheck);
  });

  test("checkpoint view exposes root as a structural candidate with projected depth", async () => {
    const root = message("root", null, "root");
    const first = summary("summary-1", "root", "first handoff");
    const current = message("current", "summary-1", "current");
    const branch = [root, first, current];
    const tool = captureTimelineTool();

    const result = await tool.execute(
      "timeline-test",
      { view: "checkpoints", limit: 50 },
      undefined,
      undefined,
      makeContext(branch, [node(root, [node(first, [node(current)])])], branch),
    );

    expect(result.details).toMatchObject({
      activeSummaryDepth: 1,
      rootCandidateDisplayed: true,
      rootCandidateEntryId: "root",
      rootProjectedSummaryDepth: 1,
    });
    expect(result.content[0].text).toContain("root → root (structural candidate, not a checkpoint)");
    expect(result.content[0].text).toContain("summary depth 1 → 1 projected");
    expect(result.content[0].text).toContain("projected depth is 1 rather than 0 because travel appends one new handoff");
  });
});
