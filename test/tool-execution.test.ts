import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { ANCHOR_SEARCH_WINDOW, optionalString } from "../src/lib.js";
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

function userEntry(id: string, parentId: string | null = null, timestamp = "2026-01-01T00:00:00.000Z"): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
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

function captureExecute(register: (pi: ExtensionAPI) => void, commandNames: string[] = []): ExecuteTool {
  let execute: ExecuteTool | undefined;
  register({
    registerTool(tool: { execute?: ExecuteTool }) {
      execute = tool.execute;
    },
    getCommands: () => commandNames.map((name) => ({ name })) as never,
  } as unknown as ExtensionAPI);
  if (!execute) throw new Error("tool execute handler was not registered");
  return execute;
}

function captureTimelineWithCommands(commandNames: string[]): ExecuteTool {
  let execute: ExecuteTool | undefined;
  registerTimelineTool({
    registerTool(tool: { execute?: ExecuteTool }) {
      execute = tool.execute;
    },
    getCommands() {
      return commandNames.map((name) => ({ name })) as never;
    },
  } as unknown as ExtensionAPI, new AcmSessionRuntime());
  if (!execute) throw new Error("timeline execute handler was not registered");
  return execute;
}

function captureTimelineWithSkillPath(path: string): ExecuteTool {
  let execute: ExecuteTool | undefined;
  registerTimelineTool({
    registerTool(tool: { execute?: ExecuteTool }) {
      execute = tool.execute;
    },
    getCommands() {
      return [{
        name: "skill:context-management",
        sourceInfo: { path },
      }] as never;
    },
  } as unknown as ExtensionAPI, new AcmSessionRuntime());
  if (!execute) throw new Error("timeline execute handler was not registered");
  return execute;
}

function checkpointContext(initialLabel?: string) {
  const entry = userEntry("entry-1");
  const entries: SessionEntry[] = [
    entry,
    ...(initialLabel === undefined ? [] : [labelEntry("label-existing", entry.id, initialLabel)]),
  ];
  const tree: SessionTreeNode[] = [{ entry, children: [] }];
  let appendCalls = 0;
  let branchCalls = 0;
  const sessionManager = {
    getTree: () => tree,
    getEntries: () => entries,
    getBranch: () => [entry],
    getLeafId: () => entry.id,
    getEntry: (id: string) => entries.find((candidate) => candidate.id === id),
    appendLabelChange: (targetId: string, label: string | undefined) => {
      appendCalls++;
      const id = `label-${appendCalls}`;
      entries.push(labelEntry(id, targetId, label));
      return id;
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
  const entries = [root, labelEntry("label-1", root.id, "baseline-checkpoint")];
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

function largeTimelineContext(count = 250) {
  const messages: SessionEntry[] = [];
  const labels: SessionEntry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = userEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`);
    messages.push(entry);
    labels.push(labelEntry(`label-${index}`, entry.id, `checkpoint-${index}`));
  }
  let treeNode: SessionTreeNode | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    treeNode = { entry: messages[index]!, children: treeNode ? [treeNode] : [] };
  }
  let branchReads = 0;
  const sessionManager = {
    getTree: () => treeNode ? [treeNode] : [],
    getEntries: () => [...messages, ...labels],
    getBranch: (fromId?: string) => {
      branchReads++;
      if (!fromId) return messages;
      const index = messages.findIndex((entry) => entry.id === fromId);
      return index < 0 ? [] : messages.slice(0, index + 1);
    },
    getLeafId: () => messages.at(-1)?.id ?? null,
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
      ui: { notify() {} },
    },
    getBranchReads: () => branchReads,
  };
}

function largeLabelTimelineContext(count = 250) {
  const messages: SessionEntry[] = [];
  const labels: SessionEntry[] = [];
  const volumeLabel = `volume-${"x".repeat(1_000)}`;
  let longLabel = "";
  for (let index = 0; index < count; index++) {
    const entry = userEntry(`entry-long-label-${index}`, index === 0 ? null : `entry-long-label-${index - 1}`);
    const label = index === count - 50 ? `long-${"x".repeat(100_000)}` : `${volumeLabel}-${index}`;
    if (index === count - 50) longLabel = label;
    messages.push(entry);
    labels.push(labelEntry(`label-${index}`, entry.id, label));
  }
  let treeNode: SessionTreeNode | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    treeNode = { entry: messages[index]!, children: treeNode ? [treeNode] : [] };
  }
  const entries = [...messages, ...labels];
  const leafId = messages.at(-1)?.id ?? null;
  const sessionManager = {
    getTree: () => treeNode ? [treeNode] : [],
    getEntries: () => entries,
    getBranch: (fromId?: string) => {
      if (!fromId) return messages;
      const index = messages.findIndex((entry) => entry.id === fromId);
      return index < 0 ? [] : messages.slice(0, index + 1);
    },
    getLeafId: () => leafId,
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 20_000, percent: 5 }),
      ui: { notify() {} },
    },
    longLabel,
    leafId,
  };
}

function sortedCheckpointTimelineContext() {
  const root = userEntry("root", null, "2026-01-01T00:00:00.000Z");
  const onFirst = userEntry("on-first", root.id, "2026-01-01T00:00:05.000Z");
  const onSecond = userEntry("on-second", onFirst.id, "2026-01-01T00:00:01.000Z");
  const head = userEntry("head", onSecond.id, "2026-01-01T00:00:06.000Z");
  const offEarlier = userEntry("z-off-earlier", root.id, "2026-01-01T00:00:02.000Z");
  const offAlpha = userEntry("off-alpha", root.id, "2026-01-01T00:00:04.000Z");
  const offZeta = userEntry("off-zeta", root.id, "2026-01-01T00:00:04.000Z");
  const offLater = userEntry("a-off-later", root.id, "2026-01-01T00:00:07.000Z");
  const activeBranch = [root, onFirst, onSecond, head];
  const entries: SessionEntry[] = [
    root,
    onFirst,
    onSecond,
    head,
    offEarlier,
    offAlpha,
    offZeta,
    offLater,
    labelEntry("label-on-first", onFirst.id, "checkpoint-on-first"),
    labelEntry("label-on-second", onSecond.id, "checkpoint-on-second"),
    labelEntry("label-off-earlier", offEarlier.id, "checkpoint-off-earlier"),
    labelEntry("label-off-alpha", offAlpha.id, "checkpoint-off-alpha"),
    labelEntry("label-off-zeta", offZeta.id, "checkpoint-off-zeta"),
    labelEntry("label-off-later", offLater.id, "checkpoint-off-later"),
  ];
  const branches: Record<string, SessionEntry[]> = {
    [root.id]: [root],
    [onFirst.id]: [root, onFirst],
    [onSecond.id]: [root, onFirst, onSecond],
    [head.id]: activeBranch,
    [offEarlier.id]: [root, offEarlier],
    [offAlpha.id]: [root, offAlpha],
    [offZeta.id]: [root, offZeta],
    [offLater.id]: [root, offLater],
  };
  const tree: SessionTreeNode[] = [{
    entry: root,
    children: [
      { entry: onFirst, children: [{ entry: onSecond, children: [{ entry: head, children: [] }] }] },
      { entry: offEarlier, children: [] },
      { entry: offAlpha, children: [] },
      { entry: offZeta, children: [] },
      { entry: offLater, children: [] },
    ],
  }];
  return {
    context: {
      sessionManager: {
        getTree: () => tree,
        getEntries: () => entries,
        getBranch: (fromId?: string) => fromId === undefined ? activeBranch : branches[fromId] ?? [],
        getLeafId: () => head.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
  };
}

function filterableCheckpointTimelineContext() {
  const root = userEntry("root");
  const labelMatched = userEntry("entry-label-match", root.id);
  const idMatched = userEntry("alpha-entry", labelMatched.id);
  const excluded = userEntry("entry-excluded", idMatched.id);
  const branch = [root, labelMatched, idMatched, excluded];
  const entries: SessionEntry[] = [
    ...branch,
    labelEntry("label-alpha", labelMatched.id, "checkpoint-alpha"),
    labelEntry("label-unrelated", idMatched.id, "checkpoint-unrelated"),
    labelEntry("label-excluded", excluded.id, "checkpoint-hidden"),
  ];
  return {
    context: {
      sessionManager: {
        getTree: () => [{ entry: root, children: [{ entry: labelMatched, children: [{ entry: idMatched, children: [{ entry: excluded, children: [] }] }] }] }],
        getEntries: () => entries,
        getBranch: (fromId?: string) => {
          if (fromId === undefined) return branch;
          const index = branch.findIndex((entry) => entry.id === fromId);
          return index < 0 ? [] : branch.slice(0, index + 1);
        },
        getLeafId: () => excluded.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
  };
}

function timelineCandidateBuildFailureContext() {
  const root = userEntry("root");
  const brokenSummary = {
    type: "branch_summary",
    id: "broken-summary",
    parentId: root.id,
    timestamp: "2026-01-01T00:00:01.000Z",
    fromId: "old-leaf",
    get summary() {
      throw new Error("candidate summary is unreadable");
    },
  } as unknown as SessionEntry;
  const entries = [root, brokenSummary, labelEntry("label-broken", brokenSummary.id, "broken-candidate")];
  const sessionManager = {
    getTree: () => [{ entry: root, children: [{ entry: brokenSummary, children: [] }] }],
    getEntries: () => entries,
    getBranch: (fromId?: string) => fromId === brokenSummary.id ? [root, brokenSummary] : [root],
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

function successfulTravelContext(
  failPostMutationRebuild = false,
  invalidatePostMutationPacket = false,
  failPostMutationBranchRead = false,
  preexistingBackupLabel?: string,
) {
  const root = userEntry("travel-root");
  const head = userEntry("travel-head", root.id);
  const entries: SessionEntry[] = [
    root,
    head,
    ...(preexistingBackupLabel === undefined ? [] : [labelEntry("label-existing-backup", head.id, preexistingBackupLabel)]),
  ];
  let leafId = head.id;
  let postMutationRebuildFailed = false;
  let postMutationPacketInvalid = false;
  let appendCalls = 0;
  let branchCalls = 0;
  const invalidRoot = {
    ...root,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "", name: "broken-tool", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 0,
    },
  } as SessionEntry;
  const sessionManager = {
    getTree: () => [{ entry: root, children: [{ entry: head, children: [] }] }],
    getEntries: () => {
      if (postMutationRebuildFailed) throw new Error("post-mutation session messages are temporarily unavailable");
      return postMutationPacketInvalid ? [invalidRoot, ...entries.slice(1)] : entries;
    },
    getBranch: (fromId?: string) => {
      if (failPostMutationBranchRead && leafId !== head.id) throw new Error("post-mutation branch read failed");
      if (fromId === root.id) return [root];
      return leafId === head.id ? [root, head] : [root, entries.at(-1)!];
    },
    getLeafId: () => leafId,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: (targetId: string, label: string | undefined) => {
      appendCalls++;
      const id = `label-backup-${appendCalls}`;
      entries.push(labelEntry(id, targetId, label));
      return id;
    },
    branchWithSummary: (targetId: string, summary: string, details: unknown) => {
      branchCalls++;
      const entry: SessionEntry = {
        type: "branch_summary",
        id: "travel-summary",
        parentId: targetId,
        timestamp: "2026-01-01T00:00:01.000Z",
        fromId: leafId,
        summary,
        details,
      } as SessionEntry;
      entries.push(entry);
      leafId = entry.id;
      postMutationRebuildFailed = failPostMutationRebuild;
      postMutationPacketInvalid = invalidatePostMutationPacket;
      return entry.id;
    },
  };
  return {
    sessionManager,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    ui: { notify() {} },
    getAppendCalls: () => appendCalls,
    getBranchCalls: () => branchCalls,
  };
}

function currentProtocolInvalidTravelContext(toolCallId: string) {
  const root = userEntry("current-protocol-root");
  const invalidAssistant = {
    type: "message",
    id: "current-protocol-invalid",
    parentId: root.id,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "duplicate-current", name: "read", arguments: { path: "a.md" } },
        { type: "toolCall", id: "duplicate-current", name: "read", arguments: { path: "b.md" } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as SessionEntry;
  const currentTravel = {
    type: "message",
    id: "current-protocol-travel",
    parentId: invalidAssistant.id,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "acm_travel", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 2,
    },
  } as SessionEntry;
  const entries = [root, invalidAssistant, currentTravel];
  let appendCalls = 0;
  let branchCalls = 0;
  const sessionManager = {
    getTree: () => [{
      entry: root,
      children: [{
        entry: invalidAssistant,
        children: [{ entry: currentTravel, children: [] }],
      }],
    }],
    getEntries: () => entries,
    getBranch: (fromId?: string) => fromId === root.id
      ? [root]
      : fromId === invalidAssistant.id
        ? [root, invalidAssistant]
        : entries,
    getLeafId: () => currentTravel.id,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: () => {
      appendCalls++;
      return "must-not-append-label";
    },
    branchWithSummary: () => {
      branchCalls++;
      return "must-not-branch";
    },
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
    sessionManager,
    getAppendCalls: () => appendCalls,
    getBranchCalls: () => branchCalls,
  };
}

function poisonedAutomaticCheckpointContext(toolCallId: string, entryCount = 402) {
  const root = userEntry("poisoned-anchor-root");
  const unclosedBatch = {
    type: "message",
    id: "poisoned-anchor-unclosed",
    parentId: root.id,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "poisoned-anchor-read", name: "read", arguments: { path: "stuck.txt" } }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as SessionEntry;
  // Host context projection strips bare dangling calls. A stale orphan result
  // after the interrupted batch keeps every later prefix protocol-repaired.
  const staleOrphanResult = {
    type: "message",
    id: "poisoned-anchor-orphan-result",
    parentId: unclosedBatch.id,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "poisoned-anchor-missing",
      toolName: "read",
      content: [{ type: "text", text: "interrupted result" }],
      isError: true,
      timestamp: 2,
    },
  } as SessionEntry;
  const entries: SessionEntry[] = [root, unclosedBatch, staleOrphanResult];
  for (let index = 3; index < entryCount - 1; index++) {
    const parent = entries.at(-1);
    if (!parent) throw new Error("poisoned checkpoint fixture lost its parent");
    entries.push({
      type: "message",
      id: `poisoned-anchor-${index}`,
      parentId: parent.id,
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: `later message ${index}`, timestamp: index },
    } as SessionEntry);
  }
  const checkpointParent = entries.at(-1);
  if (!checkpointParent) throw new Error("poisoned checkpoint fixture has no checkpoint parent");
  const checkpointCall = {
    type: "message",
    id: "poisoned-anchor-checkpoint",
    parentId: checkpointParent.id,
    timestamp: "2026-01-01T00:10:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "acm_checkpoint", arguments: { name: "bounded-anchor" } }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: entryCount,
    },
  } as SessionEntry;
  entries.push(checkpointCall);
  let tree: SessionTreeNode | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    tree = { entry: entries[index]!, children: tree ? [tree] : [] };
  }
  let candidatePrefixReads = 0;
  let appendCalls = 0;
  const sessionManager = {
    getTree: () => tree ? [tree] : [],
    getEntries: () => entries,
    getBranch: (fromId?: string) => {
      if (fromId === undefined) return entries;
      candidatePrefixReads++;
      const candidateIndex = entries.findIndex((entry) => entry.id === fromId);
      return candidateIndex < 0 ? [] : entries.slice(0, candidateIndex + 1);
    },
    getLeafId: () => checkpointCall.id,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: () => {
      appendCalls++;
      return "must-not-append-poisoned-anchor";
    },
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
    getAppendCalls: () => appendCalls,
    getCandidatePrefixReads: () => candidatePrefixReads,
  };
}

const executeCheckpoint = captureExecute(registerCheckpointTool);
const executeCheckpointWithSkill = captureExecute(registerCheckpointTool, ["skill:context-management"]);
const executeTimeline = captureExecute((pi) => registerTimelineTool(pi, new AcmSessionRuntime()));
const executeTravel = captureExecute((pi) => registerTravelTool(pi, new AcmSessionRuntime()));
const HANDOFF = {
  goal: "preserve the current task",
  state: "ready to fold",
  evidence: "test fixture",
  external: "none",
  exclusions: "none",
  recover: "archive-done",
  next: "continue",
};

describe("ACM tool execution contracts", () => {
  test("normalizes optional string provider parameters", () => {
    for (const value of [null, undefined, 0, {}, " \t\n"]) {
      expect(optionalString(value)).toBeUndefined();
    }
    expect(optionalString("  recovery-anchor  ")).toBe("recovery-anchor");
  });
  test("rejects malformed top-level travel parameters without throwing or mutating", async () => {
    for (const params of [
      { target: 42, handoff: HANDOFF },
      { target: null, handoff: HANDOFF },
      { target: "entry-1", handoff: HANDOFF, backupCurrentHeadAs: {} },
      { target: "entry-1", handoff: HANDOFF, unexpected: true },
    ]) {
      const { ctx, getAppendCalls, getBranchCalls } = checkpointContext();
      const result = await executeTravel("invalid-params", params, undefined, undefined, ctx);
      expect(result.details).toMatchObject({ error: "invalid_params" });
      expect(getAppendCalls()).toBe(0);
      expect(getBranchCalls()).toBe(0);
    }
  });
  test("treats null optional tool parameters as omitted", async () => {
    const travel = await executeTravel(
      "null-backup",
      { target: "travel-root", handoff: HANDOFF, backupCurrentHeadAs: null },
      undefined,
      undefined,
      successfulTravelContext(),
    );
    expect(travel.details?.error).toBeUndefined();
    expect(travel.details).toMatchObject({
      mutationStatus: "applied",
      hasBackup: false,
      backupCurrentHeadAs: null,
    });

    const checkpointFixture = checkpointContext();
    const checkpoint = await executeCheckpoint(
      "null-target",
      { name: "null-optional-target", target: null },
      undefined,
      undefined,
      checkpointFixture.ctx,
    );
    expect(checkpoint.details).toMatchObject({
      target: "auto",
      targetResolution: "automatic_protocol_complete",
    });
    expect(checkpointFixture.getAppendCalls()).toBe(1);

    const timeline = await executeTimeline(
      "null-timeline-optionals",
      { view: null, limit: null, verbose: null, filter: null, query: null },
      undefined,
      undefined,
      timelineContext(),
    );
    expect(timeline.details).toMatchObject({ view: "active", limit: 50, verbose: false });

    const missingQuery = await executeTimeline(
      "null-search-query",
      { view: "search", query: null },
      undefined,
      undefined,
      timelineContext(),
    );
    expect(missingQuery.details).toMatchObject({ error: "missing_query" });
  });

  test("rejects malformed archive aliases before mutation", async () => {
    const { ctx, getAppendCalls, getBranchCalls } = checkpointContext();
    const result = await executeTravel(
      "invalid-backup-format",
      { target: "entry-1", handoff: HANDOFF, backupCurrentHeadAs: "bad name!" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).toMatchObject({
      error: "invalid_params",
      defects: expect.arrayContaining(["backupCurrentHeadAs:invalid_type_or_format"]),
    });
    expect(getAppendCalls()).toBe(0);
    expect(getBranchCalls()).toBe(0);
  });

  test("rejects every case variant of the reserved structural root name without mutating labels", async () => {
    for (const name of ["root", "ROOT", "Root", "rOoT"]) {
      const { ctx, getAppendCalls } = checkpointContext();
      const result = await executeCheckpoint("call-1", { name }, undefined, undefined, ctx);
      expect(result.details).toMatchObject({ error: "reserved_name", name });
      expect(result.content[0]?.text).toContain("reserved");
      expect(getAppendCalls()).toBe(0);
    }
  });

  test("refuses a checkpoint that would displace an existing label without appending", async () => {
    const fixture = checkpointContext("existing-checkpoint");
    const result = await executeCheckpoint(
      "checkpoint-displacement",
      { name: "replacement-checkpoint", target: "entry-1" },
      undefined,
      undefined,
      fixture.ctx,
    );

    expect(result.details).toMatchObject({
      error: "label_displaces_existing",
      entryId: "entry-1",
      existingLabel: "existing-checkpoint",
    });
    expect(result.content[0]?.text).toContain("existing-checkpoint");
    expect(fixture.getAppendCalls()).toBe(0);
  });

  test("reuses a checkpoint label already present on the same entry without appending", async () => {
    const fixture = checkpointContext("same-checkpoint");
    const result = await executeCheckpoint(
      "checkpoint-reuse",
      { name: "same-checkpoint", target: "entry-1" },
      undefined,
      undefined,
      fixture.ctx,
    );

    expect(result.details).toMatchObject({ status: "already_present", alreadyPresent: true, label: "same-checkpoint" });
    expect(fixture.getAppendCalls()).toBe(0);
  });
  test("bounds automatic checkpoint anchoring after an unclosed tool batch", async () => {
    const toolCallId = "bounded-anchor-call";
    const { context, getAppendCalls, getCandidatePrefixReads } = poisonedAutomaticCheckpointContext(toolCallId);

    const result = await executeCheckpoint(
      toolCallId,
      { name: "bounded-anchor" },
      undefined,
      undefined,
      context,
    );

    expect(result.details).toMatchObject({
      error: "no_protocol_complete_checkpoint_target",
      searchWindow: ANCHOR_SEARCH_WINDOW,
      searchExhausted: true,
    });
    expect(result.content[0]?.text).toContain(
      `within the last ${ANCHOR_SEARCH_WINDOW} entries before this checkpoint call`,
    );
    const skipped = result.details?.skipped;
    expect(Array.isArray(skipped)).toBe(true);
    if (!Array.isArray(skipped)) throw new Error("bounded checkpoint result omitted skipped candidates");
    expect(skipped).toHaveLength(ANCHOR_SEARCH_WINDOW);
    expect(getCandidatePrefixReads()).toBeLessThanOrEqual(ANCHOR_SEARCH_WINDOW);
    expect(getAppendCalls()).toBe(0);
  });

  test("exposes collision routing only when the advanced Skill is available", async () => {
    const root = userEntry("entry-collision-root");
    const head = userEntry("entry-collision-head", root.id);
    const entries = [root, head, labelEntry("label-collision", root.id, "existing-name")];
    const ctx = {
      sessionManager: {
        getTree: () => [{ entry: root, children: [{ entry: head, children: [] }] }],
        getEntries: () => entries,
        getBranch: () => [root, head],
        getLeafId: () => head.id,
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        appendLabelChange: () => { throw new Error("must not mutate"); },
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const core = await executeCheckpoint("collision-core", { name: "existing-name" }, undefined, undefined, ctx);
    const product = await executeCheckpointWithSkill("collision-product", { name: "existing-name" }, undefined, undefined, ctx);

    expect(core.details).toMatchObject({ error: "duplicate_name" });
    expect(core.content[0]?.text).not.toContain("context-management");
    expect(core.content[0]?.text).not.toContain("references/");
    // With the skill available, the cue contains the advanced guidance
    expect(product.content[0]?.text).toContain("acm_timeline");
  });

  test("rejects every case variant of root as an archive bookmark before any mutation", async () => {
    for (const name of ["root", "ROOT", "Root", "rOoT"]) {
      const { ctx, getAppendCalls, getBranchCalls } = checkpointContext();
      const result = await executeTravel(
        "call-2",
        { target: "entry-1", handoff: HANDOFF, backupCurrentHeadAs: name },
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

  test("refuses a travel backup that would displace the resolved pre-travel label", async () => {
    const fixture = successfulTravelContext(false, false, false, "existing-backup");
    const result = await executeTravel(
      "travel-backup-displacement",
      { target: "travel-root", handoff: HANDOFF, backupCurrentHeadAs: "replacement-backup" },
      undefined,
      undefined,
      fixture,
    );

    expect(result.details).toMatchObject({
      error: "backup_displaces_existing_label",
      candidateId: "travel-head",
      existingLabel: "existing-backup",
    });
    expect(fixture.getAppendCalls()).toBe(0);
    expect(fixture.getBranchCalls()).toBe(0);
  });

  test("names the concrete handoff defects instead of restating the slot list", async () => {
    const { ctx, getAppendCalls, getBranchCalls } = checkpointContext();
    const broken = { ...HANDOFF, state: " ", next: "none" };
    const result = await executeTravel("call-handoff", { target: "entry-1", handoff: broken }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ error: "invalid_handoff" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("state:empty");
    expect(text).toContain("next:none_not_allowed");
    expect(text).toContain("nothing was mutated");
    expect(getAppendCalls()).toBe(0);
    expect(getBranchCalls()).toBe(0);
  });

  test("applies the caller-supplied limit to sorted checkpoint entries", async () => {
    const fixture = sortedCheckpointTimelineContext();
    const full = await executeTimeline(
      "sorted-checkpoints",
      { view: "checkpoints", filter: "checkpoint", limit: 6 },
      undefined,
      undefined,
      fixture.context,
    );
    const fullText = full.content[0]?.text ?? "";
    const listingOrder = [
      "on-first (checkpoint:",
      "on-second (checkpoint:",
      "z-off-earlier (checkpoint:",
      "off-alpha (checkpoint:",
      "off-zeta (checkpoint:",
      "a-off-later (checkpoint:",
    ];
    for (let index = 1; index < listingOrder.length; index++) {
      expect(fullText.indexOf(listingOrder[index - 1]!)).toBeLessThan(fullText.indexOf(listingOrder[index]!));
    }

    const limited = await executeTimeline(
      "limited-checkpoints",
      { view: "checkpoints", filter: "checkpoint", limit: 2 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(limited.details).toMatchObject({
      view: "checkpoints",
      limit: 2,
      checkpointsMatchingEntries: 6,
      checkpointsDisplayedEntries: 2,
    });
    expect(limited.content[0]?.text).toContain("... +4 more — use a narrower filter or query");
  });

  test("filters checkpoint entries by label or entry id and reports the filtered set", async () => {
    const result = await executeTimeline(
      "filtered-checkpoints",
      { view: "checkpoints", limit: 10, filter: "alpha" },
      undefined,
      undefined,
      filterableCheckpointTimelineContext().context,
    );

    expect(result.details).toMatchObject({
      checkpointsMatchingEntries: 2,
      checkpointsDisplayedEntries: 2,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("entry-label-match (checkpoint: checkpoint-alpha");
    expect(text).toContain("alpha-entry (checkpoint: checkpoint-unrelated");
    expect(text).not.toContain("entry-excluded");
  });

  test("keeps a failed checkpoint message estimate unknown instead of reporting zero", async () => {
    const result = await executeTimeline(
      "call-checkpoint-build-failure",
      { view: "checkpoints", limit: 10 },
      undefined,
      undefined,
      timelineCandidateBuildFailureContext(),
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("broken-summary (checkpoint: broken-candidate; off-path");
    expect(text).toContain("message estimate unavailable");
    expect(text).not.toContain("broken-candidate → broken-summary (off-path) ~0 msgs");
  });

  test("bounds checkpoint rebuild work for an extreme requested limit", async () => {
    const fixture = largeTimelineContext();

    const result = await executeTimeline(
      "large-checkpoint-view",
      { view: "checkpoints", limit: 1_000_000_000 },
      undefined,
      undefined,
      fixture.context,
    );

    expect(result.details).toMatchObject({
      view: "checkpoints",
      limit: 1_000_000_000,
      effectiveLimit: 100,
      resultEntryBudget: 100,
      resultBudgetApplied: true,
      checkpointsMatchingEntries: 250,
      checkpointsDisplayedEntries: 99,
    });
    expect(fixture.getBranchReads()).toBeLessThanOrEqual(205);
    expect(result.content[0]?.text).toContain("Result Budget:    requested 1000000000");
    expect(result.content[0]?.text).toContain("+151 more");
  });

  test("bounds timeline output for many labeled entries and a huge search query", async () => {
    const fixture = largeLabelTimelineContext();

    const active = await executeTimeline(
      "large-label-active",
      { view: "active", limit: 1_000_000_000 },
      undefined,
      undefined,
      fixture.context,
    );
    const activeText = active.content[0]?.text ?? "";
    const activeBudget = active.details?.resultCharacterBudget;
    if (typeof activeBudget !== "number") throw new Error("timeline result omitted its character budget");
    expect(active.details).toMatchObject({ outputTruncatedByCharacterBudget: true });
    expect(activeText.length).toBeLessThanOrEqual(activeBudget);
    expect(activeText).toContain(`truncated ${fixture.longLabel.length} chars`);
    expect(activeText).toContain(`… [timeline output truncated at ${activeBudget} characters; active leaf ${fixture.leafId}. Use a narrower filter/query or a smaller view.]`);

    const query = "q".repeat(100_000);
    const search = await executeTimeline(
      "long-query-search",
      { view: "search", query, limit: 1_000_000_000 },
      undefined,
      undefined,
      fixture.context,
    );
    const searchText = search.content[0]?.text ?? "";
    const searchBudget = search.details?.resultCharacterBudget;
    if (typeof searchBudget !== "number") throw new Error("timeline search omitted its character budget");
    expect(searchText.length).toBeLessThanOrEqual(searchBudget);
    expect(searchText).toContain(`truncated ${query.length} chars`);
  });

  test("timeline active view works with and without the skill available", async () => {
    const withoutSkill = captureTimelineWithCommands([]);
    const withSkill = captureTimelineWithCommands(["skill:context-management"]);

    const absent = await withoutSkill("timeline-no-skill", { view: "active" }, undefined, undefined, timelineContext());
    const available = await withSkill("timeline-with-skill", { view: "active" }, undefined, undefined, timelineContext());

    // Both produce valid output
    expect(absent.content[0]?.text).toContain("Context Dashboard");
    expect(available.content[0]?.text).toContain("Context Dashboard");
  });

  test("timeline HUD renders cleanly with a skill router path", async () => {
    const path = "/tmp/ACM Skill/context management/SKILL.md";
    const executeWithPath = captureTimelineWithSkillPath(path);

    const result = await executeWithPath(
      "timeline-with-router-path",
      { view: "active" },
      undefined,
      undefined,
      timelineContext(),
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Context Dashboard");
    expect(text).toContain("Active Path");
  });

  test("does not claim an unobservable backup label definitely remains after skipped rollback", async () => {
    const result = await executeTravel(
      "call-4",
      { target: "entry-1", handoff: HANDOFF, backupCurrentHeadAs: "archive-done" },
      undefined,
      undefined,
      indeterminateTravelContext(),
    );
    expect(result.details).toMatchObject({
      error: "branch_failed",
      backupRollbackSkipped: true,
      remainingBackupLabelState: "unknown",
      contextDeliveryPhase: "active",
    });
    expect(result.content[0]?.text).toContain("may remain");
    expect(result.content[0]?.text).not.toContain("remains because branch mutation");
  });

  test("does not invent a backup pointer for indeterminate travel without a backup", async () => {
    const result = await executeTravel(
      "call-5",
      { target: "entry-1", handoff: HANDOFF },
      undefined,
      undefined,
      indeterminateTravelContext(),
    );
    expect(result.details).toMatchObject({
      error: "branch_failed",
      branchState: "indeterminate",
      contextDeliveryPhase: "active",
    });
    expect(result.content[0]?.text).toContain("Branch mutation cannot be excluded");
    expect(result.content[0]?.text).not.toContain("backup pointer");
  });

  test("preserves the raw scheduled native replacement outcome alongside delivery phase", async () => {
    const nativeOutcome = { status: "pending" as const, preferredLeafId: "adapter-leaf" };
    const adapter = {
      installation: { status: "ready" as const },
      schedule: () => nativeOutcome,
      apply: () => ({ status: "skipped" as const, reason: "not_pending" as const, message: "not exercised" }),
      getStatus: () => nativeOutcome,
      clear() {},
    };
    const executeWithAdapter = captureExecute((pi) => registerTravelTool(pi, new AcmSessionRuntime(adapter)));

    const result = await executeWithAdapter(
      "travel-native-outcome",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      successfulTravelContext(),
    );

    expect(result.details).toMatchObject({
      contextDeliveryPhase: "pending_tool_result",
      nativeContextReplacementState: "pending",
      nativeContextReplacement: nativeOutcome,
      liveAgentSessionSyncState: "pending",
      liveAgentSessionSync: nativeOutcome,
    });
  });

  test("rejects an invalid current packet before labels, branch mutation, or deferred refresh", async () => {
    const runtime = new AcmSessionRuntime();
    const executeWithRuntime = captureExecute((pi) => registerTravelTool(pi, runtime));
    const toolCallId = "current-protocol-travel-call";
    const fixture = currentProtocolInvalidTravelContext(toolCallId);
    const entriesBefore = [...fixture.sessionManager.getEntries()];

    const result = await executeWithRuntime(
      toolCallId,
      {
        target: "current-protocol-root",
        handoff: HANDOFF,
        backupCurrentHeadAs: "must-not-create-current-protocol-backup",
      },
      undefined,
      undefined,
      fixture.context,
    );

    expect(result.details).toMatchObject({
      error: "current_protocol_invalid",
      target: "current-protocol-root",
      targetId: "current-protocol-root",
      originId: "current-protocol-travel",
      currentProtocolStatus: "invalid",
      defects: [expect.objectContaining({
        kind: "duplicate_tool_call_id",
        toolCallId: "duplicate-current",
      })],
      contextRefreshPending: false,
      contextRefreshState: "not_scheduled",
      contextDeliveryPhase: "active",
    });
    expect(result.content[0]?.text).toContain("nothing was mutated");
    expect(fixture.sessionManager.getEntries()).toEqual(entriesBefore);
    expect(fixture.sessionManager.getLeafId()).toBe("current-protocol-travel");
    expect(fixture.getAppendCalls()).toBe(0);
    expect(fixture.getBranchCalls()).toBe(0);
    expect(runtime.contextRefresh.isPending(fixture.sessionManager)).toBe(false);
    expect(runtime.getContextDeliveryPhase(fixture.sessionManager)).toBe("active");
  });

  test("keeps an applied travel receipt and post-travel steer data when post-mutation evidence cannot rebuild", async () => {
    const result = await executeTravel(
      "travel-post-mutation-rebuild-failure",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      successfulTravelContext(true),
    );

    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      resultingLeafId: "travel-summary",
      handoffFormat: "structured-v1",
      handoffNext: HANDOFF.next,
      currentUserTurnOpen: false,
      contextRefreshPending: true,
      contextDeliveryPhase: "pending_tool_result",
      postMutationEvidenceStatus: "unavailable",
      postMutationEvidenceWarning: expect.stringContaining("post-mutation session messages are temporarily unavailable"),
    });
    expect(result.content[0]?.text).toContain("Travel complete");
    expect(result.content[0]?.text).toContain(`Applied handoff NEXT: ${HANDOFF.next}`);
  });

  test("keeps an applied travel receipt when post-mutation branch diagnostics fail", async () => {
    const runtime = new AcmSessionRuntime();
    const executeWithRuntime = captureExecute((pi) => registerTravelTool(pi, runtime));
    const context = successfulTravelContext(false, false, true);

    const result = await executeWithRuntime(
      "travel-post-mutation-branch-failure",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      context,
    );

    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      resultingLeafId: "travel-summary",
      contextRefreshPending: true,
      contextDeliveryPhase: "pending_tool_result",
      postMutationEvidenceStatus: "unavailable",
      postMutationEvidenceWarning: expect.stringContaining("post-mutation branch read failed"),
    });
    expect(runtime.contextRefresh.isPending(context.sessionManager)).toBe(true);
    expect(result.content[0]?.text).toContain("Travel complete");
  });

  test("keeps an applied travel receipt and protocol defects when post-mutation packet evidence is invalid", async () => {
    const result = await executeTravel(
      "travel-post-mutation-invalid-packet",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      successfulTravelContext(false, true),
    );

    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      resultingLeafId: "travel-summary",
      handoffFormat: "structured-v1",
      handoffNext: HANDOFF.next,
      currentUserTurnOpen: false,
      contextRefreshPending: true,
      contextDeliveryPhase: "pending_tool_result",
      postMutationEvidenceStatus: "invalid_protocol",
      postMutationProtocolStatus: "invalid",
      postMutationProtocolDefects: [{ kind: "invalid_tool_call_id" }],
    });
    expect(result.content[0]?.text).toContain("Travel complete");
    expect(result.content[0]?.text).toContain("invalid_tool_call_id");
    expect(result.content[0]?.text).toContain(`Applied handoff NEXT: ${HANDOFF.next}`);
  });
});
