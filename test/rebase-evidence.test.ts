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
import { ACM_CONTINUATION_MARKER } from "../src/context-packet.js";
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

function label(id: string, parentId: string, targetId: string, name: string): SessionEntry {
  return {
    id,
    type: "label",
    parentId,
    timestamp: "2026-01-01T00:00:02.000Z",
    targetId,
    label: name,
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

function captureTimelineTool(overrides: Record<string, unknown> = {}) {
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
    getProviderDeliveryStatus: () => ({
      persistentMutationApplied: false,
      phase: "active",
      packetMessageCount: null,
      leafId: null,
      error: null,
      usageObserved: false,
    }),
    getLiveAgentSyncStatus: () => ({ status: "idle" }),
    ...overrides,
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

  test("active HUD exposes stacked-summary evidence and a recognition-only rebase cue", async () => {
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
    expect(result.content[0].text).toContain("a rebase check is worthwhile");
    expect(result.content[0].text).toContain("Rebase only if");
    expect(result.content[0].text).not.toContain("Rebase instead");
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

  test("all timeline views preserve a raw archive marker when a later ordinary alias exists", async () => {
    const root = message("root", null, "root");
    const archived = message("archived", "root", "raw packet");
    const rawLabel = label("label-raw", "archived", "archived", "raw-before-fold");
    const semanticLabel = label("label-semantic", "label-raw", "archived", "later-semantic");
    const folded = {
      ...summary("summary-1", "root", `${ACM_CONTINUATION_MARKER}\nGoal: current\nState: folded\nEvidence: none\nExternal: none\nExclusions: none\nRecover: raw-before-fold\nNEXT: continue`),
      fromHook: true,
      details: {
        kind: "acm_travel",
        handoffVersion: 1,
        toolCallId: "travel-1",
        currentUserTurnOpen: false,
        originId: "old-head",
        target: "root",
        targetId: "root",
        backupCurrentHeadAs: "raw-before-fold",
      },
    } as SessionEntry;
    const receipt = {
      id: "receipt-1",
      type: "message",
      parentId: "summary-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "travel-1",
        toolName: "acm_travel",
        content: [{ type: "text", text: "Travel complete" }],
        details: {
          mutationStatus: "applied",
          persistentMutationApplied: true,
          handoffFormat: "structured-v1",
          summaryEntryId: "summary-1",
          resultingLeafId: "summary-1",
          originId: "old-head",
          targetId: "root",
        },
        isError: false,
        timestamp: 3,
      },
    } as SessionEntry;
    const current = message("current", "label-semantic", "current");
    const entries = [root, archived, rawLabel, semanticLabel, folded, receipt, current];
    const branch = [root, archived, rawLabel, semanticLabel, current];
    const tool = captureTimelineTool();
    const context = makeContext(
      entries,
      [node(root, [
        node(archived, [node(rawLabel, [node(semanticLabel, [node(current)])])]),
        node(folded, [node(receipt)]),
      ])],
      branch,
    );

    const checkpoints = await tool.execute("timeline-raw-checkpoints", { view: "checkpoints", limit: 50 }, undefined, undefined, context);
    const active = await tool.execute("timeline-raw-active", { view: "active", limit: 50 }, undefined, undefined, context);
    const search = await tool.execute("timeline-raw-search", { view: "search", query: "raw-before-fold", limit: 50 }, undefined, undefined, context);
    const tree = await tool.execute("timeline-raw-tree", { view: "tree", limit: 50 }, undefined, undefined, context);

    expect(checkpoints.content[0].text).toContain("later-semantic [raw archive on this entry]");
    expect(checkpoints.content[0].text).toContain("raw archive origin — restore/rehydrate only, not a fold/rebase base");
    expect(active.content[0].text).toContain("later-semantic [raw archive on this entry]");
    expect(search.content[0].text).toContain("raw-before-fold [raw archive]");
    expect(tree.content[0].text).toContain("later-semantic [raw archive on this entry]");
  });

  test("foreign summary details cannot classify an ordinary alias as raw archive", async () => {
    const root = message("root", null, "root");
    const ordinary = message("ordinary", "root", "ordinary checkpoint");
    const ordinaryLabel = label("label-ordinary", "ordinary", "ordinary", "ordinary-checkpoint");
    const forged = {
      ...summary("foreign-summary", "root", "foreign summary without ACM marker"),
      details: {
        kind: "acm_travel",
        handoffVersion: 1,
        toolCallId: "foreign-travel",
        currentUserTurnOpen: false,
        originId: "foreign-origin",
        target: "root",
        targetId: "root",
        backupCurrentHeadAs: "ordinary-checkpoint",
      },
    } as SessionEntry;
    const current = message("current", "label-ordinary", "current");
    const entries = [root, ordinary, ordinaryLabel, forged, current];
    const branch = [root, ordinary, ordinaryLabel, current];
    const tool = captureTimelineTool();
    const result = await tool.execute(
      "timeline-foreign-summary",
      { view: "checkpoints", limit: 50 },
      undefined,
      undefined,
      makeContext(entries, [node(root, [node(ordinary, [node(ordinaryLabel, [node(current)])]), node(forged)])], branch),
    );

    expect(result.content[0].text).toContain("ordinary-checkpoint");
    expect(result.content[0].text).not.toContain("[raw archive]");
    expect(result.content[0].text).not.toContain("raw archive origin — restore/rehydrate only");
  });

  test("HUD exposes cached_exhausted and stops presenting persistence refresh as pending", async () => {
    const root = message("root", null, "root");
    const tool = captureTimelineTool({
      contextRefresh: {
        getFailure: () => "persistent read failed",
        isPending: () => false,
        getAttemptCount: () => 3,
        hasRebuilt: () => true,
      },
      getContextDeliveryPhase: () => "cached_exhausted",
      getProviderDeliveryStatus: () => ({
        persistentMutationApplied: true,
        phase: "cached_exhausted",
        packetMessageCount: 2,
        leafId: "summary-1",
        error: "persistent read failed",
        usageObserved: true,
      }),
      getLiveAgentSyncStatus: () => ({ status: "pending" }),
    });

    const result = await tool.execute(
      "timeline-cached-exhausted",
      { view: "active" },
      undefined,
      undefined,
      makeContext([root], [node(root)], [root]),
    );

    expect(result.content[0].text).toContain("Context Delivery: cached_exhausted");
    expect(result.content[0].text).toContain("Provider Packet: cached_exhausted; 2 message(s) at summary-1");
    expect(result.details).toMatchObject({
      contextRefreshPending: false,
      contextDeliveryPhase: "cached_exhausted",
      providerDeliveryPhase: "cached_exhausted",
    });
  });
});
