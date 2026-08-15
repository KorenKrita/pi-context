import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { collectTrustedAcmTravelTransactions } from "../src/context-packet.js";
import { ANCHOR_SEARCH_WINDOW, optionalString } from "../src/conventions.js";
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
  let treeReads = 0;
  const sessionManager = {
    getTree: () => {
      treeReads++;
      return treeNode ? [treeNode] : [];
    },
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
    getTreeReads: () => treeReads,
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
  let treeReads = 0;
  const sessionManager = {
    getTree: () => {
      treeReads++;
      return treeNode ? [treeNode] : [];
    },
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
    getTreeReads: () => treeReads,
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
    branchWithSummary: (targetId: string, summary: string, details: unknown, fromHook?: boolean) => {
      branchCalls++;
      // Mirror the real host contract: fromId is the branch base (not the
      // pre-travel leaf) and fromHook echoes the caller's flag.
      const entry: SessionEntry = {
        type: "branch_summary",
        id: "travel-summary",
        parentId: targetId,
        timestamp: "2026-01-01T00:00:01.000Z",
        fromId: targetId,
        fromHook: fromHook === true,
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
  let entriesReads = 0;
  let appendCalls = 0;
  const sessionManager = {
    getTree: () => tree ? [tree] : [],
    getEntries: () => {
      entriesReads++;
      return entries;
    },
    getBranch: (fromId?: string) => {
      if (fromId === undefined) return entries;
      candidatePrefixReads++;
      const candidateIndex = entries.findIndex((entry) => entry.id === fromId);
      return candidateIndex < 0 ? [] : entries.slice(0, candidateIndex + 1);
    },
    getLeafId: () => checkpointCall.id,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: (targetId: string, label: string | undefined) => {
      appendCalls++;
      const id = `poisoned-anchor-label-${appendCalls}`;
      entries.push(labelEntry(id, targetId, label));
      return id;
    },
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
    getAppendCalls: () => appendCalls,
    getEntriesReads: () => entriesReads,
    getCandidatePrefixReads: () => candidatePrefixReads,
  };
}


function midSpanDamagedTravelContext(toolCallId: string) {
  // Reproduces the field failure: a clean early target, one mid-span
  // provider-error assistant with a dangling tool call, then plenty of
  // ordinary work. Every candidate after the damage rebuilds as "repaired",
  // and the old complete-only rule left the return ticket nowhere to go.
  const root = userEntry("mid-span-root");
  const cleanTurn = userEntry("mid-span-clean", root.id, "2026-01-01T00:00:01.000Z");
  const danglingAssistant = {
    type: "message",
    id: "mid-span-dangling",
    parentId: cleanTurn.id,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "mid-span-lost-call", name: "bash", arguments: { command: "true" } }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "error",
      timestamp: 2,
    },
  } as SessionEntry;
  // A stale orphan result keeps later prefixes "repaired" instead of letting
  // the host projection silently drop the bare dangling call.
  const orphanResult = {
    type: "message",
    id: "mid-span-orphan",
    parentId: danglingAssistant.id,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "mid-span-missing",
      toolName: "bash",
      content: [{ type: "text", text: "stale" }],
      isError: true,
      timestamp: 3,
    },
  } as SessionEntry;
  const laterWorkA = userEntry("mid-span-later-a", orphanResult.id, "2026-01-01T00:00:04.000Z");
  const laterWorkB = userEntry("mid-span-later-b", laterWorkA.id, "2026-01-01T00:00:05.000Z");
  const travelCall = {
    type: "message",
    id: "mid-span-travel",
    parentId: laterWorkB.id,
    timestamp: "2026-01-01T00:00:06.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "acm_travel", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: 6,
    },
  } as SessionEntry;
  const entries: SessionEntry[] = [root, cleanTurn, danglingAssistant, orphanResult, laterWorkA, laterWorkB, travelCall];
  let leafId = travelCall.id;
  let appendCalls = 0;
  let branchCalls = 0;
  let tree: SessionTreeNode | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    tree = { entry: entries[index]!, children: tree ? [tree] : [] };
  }
  const sessionManager = {
    getTree: () => tree ? [tree] : [],
    getEntries: () => entries,
    getBranch: (fromId?: string) => {
      const id = fromId ?? leafId;
      const stopIndex = entries.findIndex((entry) => entry.id === id);
      return stopIndex < 0 ? entries : entries.slice(0, stopIndex + 1);
    },
    getLeafId: () => leafId,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendLabelChange: (targetId: string, label: string | undefined) => {
      appendCalls++;
      const id = `mid-span-label-${appendCalls}`;
      entries.push(labelEntry(id, targetId, label));
      return id;
    },
    branchWithSummary: (targetId: string, summary: string, details: unknown, fromHook?: boolean) => {
      branchCalls++;
      const entry: SessionEntry = {
        type: "branch_summary",
        id: "mid-span-summary",
        parentId: targetId,
        timestamp: "2026-01-01T00:00:07.000Z",
        fromId: targetId,
        fromHook: fromHook === true,
        summary,
        details,
      } as SessionEntry;
      entries.push(entry);
      leafId = entry.id;
      return entry.id;
    },
  };
  return {
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    },
    getAppendCalls: () => appendCalls,
    getBranchCalls: () => branchCalls,
  };
}

const executeCheckpoint = captureExecute((pi) => registerCheckpointTool(pi, new AcmSessionRuntime()));
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

  test("a clean target still folds when mid-span damage leaves only repaired ticket candidates", async () => {
    // Field failure lock: the fold removes the damage, so the archive
    // carrying the same deterministic repairs is honest — refusing it made
    // folding toward any clean earlier target permanently unreachable.
    const toolCallId = "mid-span-fold";
    const fixture = midSpanDamagedTravelContext(toolCallId);
    // Target the last clean node before the damage — exactly the field
    // shape: every ticket candidate strictly after the target is repaired.
    const result = await executeTravel(
      toolCallId,
      { target: "mid-span-clean", handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      backupProtocolStatus: "repaired",
    });
    // The ticket prefers the newest rebuildable candidate near HEAD so the
    // archive covers the work after the damage, not just the clean prefix.
    expect(result.details?.backupEntryId).toBe("mid-span-later-b");
    // The receipt names why the anchor is repaired: the actual tool-protocol
    // repair evidence, not just a bare status.
    const repairs = result.details?.backupProtocolRepairs;
    expect(Array.isArray(repairs)).toBe(true);
    expect((repairs as unknown[]).length).toBeGreaterThan(0);
    expect(fixture.getBranchCalls()).toBe(1);
  });

  test("a complete candidate still wins over a newer repaired one for the return ticket", async () => {
    // Priority lock with a real contest: fold to root so the replaced range
    // contains both the newer repaired candidates (after the damage) and the
    // older complete one (mid-span-clean, before the damage). The two-tier
    // fallback must not degrade into latest-rebuildable-wins: the complete
    // candidate is chosen exactly as the pre-fallback code chose it.
    const toolCallId = "priority-travel";
    const fixture = midSpanDamagedTravelContext(toolCallId);
    const result = await executeTravel(
      toolCallId,
      { target: "mid-span-root", handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      backupProtocolStatus: "complete",
      backupEntryId: "mid-span-clean",
    });
  });

  test("automatic checkpoint skips empty repaired candidates and writes no label", async () => {
    // Orphan-only spine: every prefix repairs to zero messages, so the
    // two-tier fallback must find no lawful anchor at all — an empty
    // repaired packet is not "rebuildable" in any sense the delivery layer
    // honors (it refuses empty rebuilds outright).
    const entries: SessionEntry[] = [];
    for (let index = 0; index < 3; index++) {
      const parent = entries.at(-1);
      entries.push({
        type: "message",
        id: `empty-anchor-${index}`,
        parentId: parent?.id ?? "root",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: `missing-call-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `stale ${index}` }],
          isError: true,
          timestamp: index,
        },
      } as SessionEntry);
    }
    let appendCalls = 0;
    const sessionManager = {
      getTree: () => [] as SessionTreeNode[],
      getEntries: () => entries,
      getBranch: (fromId?: string) => {
        if (fromId === undefined) return entries;
        const stopIndex = entries.findIndex((entry) => entry.id === fromId);
        return stopIndex < 0 ? [] : entries.slice(0, stopIndex + 1);
      },
      getLeafId: () => entries.at(-1)?.id ?? null,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendLabelChange: () => {
        appendCalls++;
        return "must-not-append-empty-anchor-label";
      },
    };
    const ctx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeCheckpoint("empty-anchor", { name: "empty-anchor-probe" }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({ error: "no_protocol_complete_checkpoint_target" });
    const skipped = (result.details as { skipped?: Array<{ reason?: string }> }).skipped ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((skip) => skip.reason === "empty_context_packet")).toBe(true);
    expect(appendCalls).toBe(0);
  });

  test("return-ticket scan skips empty repaired candidates and aborts without mutating", async () => {
    // Orphan-only current spine: every candidate repairs to zero messages,
    // so the return-ticket scan must skip them all (an empty packet is not
    // rebuildable in any sense the delivery layer honors) and abort before
    // any label write or branch mutation.
    const target: SessionEntry = {
      type: "message",
      id: "empty-ticket-target",
      parentId: "root",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "off-path target" }], timestamp: 0 },
    } as SessionEntry;
    const entries: SessionEntry[] = [target, {
      type: "label",
      id: "empty-ticket-label",
      parentId: target.id,
      timestamp: "2026-01-01T00:00:01.000Z",
      targetId: target.id,
      label: "empty-ticket-target-cp",
    } as SessionEntry];
    for (let index = 0; index < 3; index++) {
      entries.push({
        type: "message",
        id: `empty-ticket-${index}`,
        parentId: index === 0 ? "root" : `empty-ticket-${index - 1}`,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: `missing-call-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `stale ${index}` }],
          isError: true,
          timestamp: index,
        },
      } as SessionEntry);
    }
    const spine = entries.slice(2);
    let appendCalls = 0;
    const sessionManager = {
      getTree: () => [
        { entry: target, children: [{ entry: entries[1]!, children: [] }] },
        { entry: spine[0]!, children: [{ entry: spine[1]!, children: [{ entry: spine[2]!, children: [] }] }] },
      ] as SessionTreeNode[],
      getEntries: () => entries,
      getBranch: (fromId?: string) => {
        const stopIndex = spine.findIndex((entry) => entry.id === fromId);
        return stopIndex < 0 ? (fromId === undefined ? spine : [target]) : spine.slice(0, stopIndex + 1);
      },
      getLeafId: () => spine.at(-1)?.id ?? null,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendLabelChange: () => {
        appendCalls++;
        return "must-not-append-empty-ticket-label";
      },
    };
    const ctx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTravel("empty-ticket", { target: "empty-ticket-target-cp", handoff: HANDOFF }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({ error: "no_protocol_complete_backup_target" });
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain("nothing was mutated");
    expect(appendCalls).toBe(0);
  });

  test("a repaired target keeps the newest repaired ticket candidate over an older complete one", async () => {
    // Regression lock for the target-repaired fast path (removed once in
    // e7fc917d and restored in 912a5301): when the fold target itself is
    // repaired, the archive carries exactly the damage the fold already
    // acknowledged, and the ticket stays on the NEWEST repaired candidate —
    // scanning past it to an older complete candidate would silently move
    // placement on a previously-succeeding path. Real contest: the range
    // holds newer repaired candidates and an older complete one.
    const toolCallId = "repaired-target-fold";
    const fixture = midSpanDamagedTravelContext(toolCallId);
    // Target the orphan result itself: its packet needs the same repair, so
    // targetProtocolStatus === "repaired" and the fast path governs.
    const result = await executeTravel(
      toolCallId,
      { target: "mid-span-orphan", handoff: HANDOFF },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      backupProtocolStatus: "repaired",
      // Newest candidate in the replaced range, not an older complete one.
      backupEntryId: "mid-span-later-b",
    });
  });

  test("an abort observed inside the ticket scan returns aborted without mutating", async () => {
    // The scan break must not fall through to the domain error or apply the
    // repaired fallback: an early abort is an abort.
    const toolCallId = "scan-abort-fold";
    const fixture = midSpanDamagedTravelContext(toolCallId);
    const controller = new AbortController();
    const manager = (fixture.context as { sessionManager: { getBranch: (fromId?: string) => unknown } }).sessionManager;
    const originalGetBranch = manager.getBranch.bind(manager);
    let reads = 0;
    // Let target resolution and packet prevalidation pass, then abort while
    // the backward ticket scan is rebuilding candidate prefixes.
    manager.getBranch = (fromId?: string) => {
      reads++;
      if (reads > 4) controller.abort();
      return originalGetBranch(fromId);
    };
    const result = await executeTravel(
      toolCallId,
      { target: "mid-span-clean", handoff: HANDOFF },
      controller.signal,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({ error: "aborted" });
    expect(fixture.getAppendCalls()).toBe(0);
    expect(fixture.getBranchCalls()).toBe(0);
  });

  test("travel receipt reports pressure on the working-budget scale with its name", async () => {
    // Receipt, gauge, and ledger share one yardstick: the percentage is
    // token-derived on the working budget and names its scale in the text.
    // Fixture usage is 100/1000 — an actual-window policy, so the scale
    // reads "window" and the budget fields equal the token-derived percent.
    const result = await executeTravel(
      "travel-budget-receipt",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      successfulTravelContext(),
    );
    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      budgetBeforePercent: 10,
      // Legacy hard-window fields survive unchanged — never renamed in place.
      usageBeforePercent: 10,
    });
    const details = result.details as { estimatedBudgetAfterPercent: number | null; budgetPercentagePointDelta: number | null };
    expect(typeof details.estimatedBudgetAfterPercent).toBe("number");
    expect(typeof details.budgetPercentagePointDelta).toBe("number");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("contextPercent=10% window →");
  });

  test("travel receipt and checkpoint receipt read provider usage during a provider epoch", async () => {
    // Between an earlier travel's provider cutover and its native
    // replacement, ctx.getContextUsage() still describes the pre-travel
    // branch. Receipts starting from that stale numerator would contradict
    // the gauge: provider says 300K/1M (75% budget), native says 90K/1M.
    const prepareProviderEpoch = (runtime: AcmSessionRuntime, session: object, leafId: string) => {
      runtime.deferPostTravelRefresh(session, "prior-travel", leafId);
      runtime.markProviderCutoverReady(session, "prior-travel");
      runtime.activateProviderPacket(session, [{ role: "user", content: "packet", timestamp: 1 }], leafId);
      runtime.setUsage(session, { tokens: 300_000, contextWindow: 1_000_000, percent: 30 });
      runtime.markProviderUsageObserved(session);
    };

    const travelRuntime = new AcmSessionRuntime();
    const travelExecute = captureExecute((pi) => registerTravelTool(pi, travelRuntime));
    const travelFixture = successfulTravelContext();
    (travelFixture as { getContextUsage: () => unknown }).getContextUsage =
      () => ({ tokens: 90_000, contextWindow: 1_000_000, percent: 9 });
    prepareProviderEpoch(travelRuntime, travelFixture.sessionManager, "travel-head");
    const travel = await travelExecute(
      "provider-epoch-travel",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      travelFixture,
    );
    expect(travel.details?.error).toBeUndefined();
    // 300K/400K working budget = 75%, not the native 90K-derived 22.5%.
    expect(travel.details).toMatchObject({ budgetBeforePercent: 75, usageBeforeTokens: 300_000 });

    const checkpointRuntime = new AcmSessionRuntime();
    const checkpointExecute = captureExecute((pi) => registerCheckpointTool(pi, checkpointRuntime));
    const checkpointFixture = checkpointContext();
    (checkpointFixture.ctx as { getContextUsage: () => unknown }).getContextUsage =
      () => ({ tokens: 90_000, contextWindow: 1_000_000, percent: 9 });
    prepareProviderEpoch(checkpointRuntime, checkpointFixture.ctx.sessionManager, "entry-1");
    const checkpoint = await checkpointExecute(
      "provider-epoch-checkpoint",
      { name: "provider-epoch-mark" },
      undefined,
      undefined,
      checkpointFixture.ctx,
    );
    expect(checkpoint.details?.error).toBeUndefined();
    const checkpointText = (checkpoint.content[0] as { text: string }).text;
    expect(checkpointText).toContain("Context usage: 75% budget(400K) · 300K/1M window");
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
    // Null backup means "no custom name": the automatic return ticket is
    // still recorded, and the receipt reports the derived name.
    expect(travel.details).toMatchObject({
      mutationStatus: "applied",
      hasBackup: true,
      backupCurrentHeadAs: "preserve-the-current-task-raw",
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
  test("anchors on the latest repaired entry when an unclosed batch poisons the whole window, with bounded work", async () => {
    // Two-tier fallback: one mid-span dangling tool call must not make
    // checkpoints unreachable for the rest of the session. The anchor lands
    // on the latest rebuildable repaired candidate, the receipt carries the
    // repair evidence, and the scan stays bounded by the shared window.
    const toolCallId = "bounded-anchor-call";
    const { context, getAppendCalls, getCandidatePrefixReads } = poisonedAutomaticCheckpointContext(toolCallId);

    const result = await executeCheckpoint(
      toolCallId,
      { name: "bounded-anchor" },
      undefined,
      undefined,
      context,
    );

    expect(result.details?.error).toBeUndefined();
    expect(result.details).toMatchObject({
      status: "created",
      protocolStatus: "repaired",
      targetResolution: "automatic_protocol_complete",
    });
    // The anchor is the newest candidate before the checkpoint call itself.
    expect(result.details?.entryId).toBe("poisoned-anchor-400");
    expect(result.content[0]?.text).toContain("tool protocol repaired");
    const skipped = (result.details?.autoResolved as { skipped?: unknown[] } | undefined)?.skipped;
    expect(Array.isArray(skipped)).toBe(true);
    if (!Array.isArray(skipped)) throw new Error("checkpoint result omitted skipped candidates");
    // Everything newer that was inspected and rejected stays as evidence,
    // minus the fallback anchor itself.
    expect(skipped.length).toBeLessThanOrEqual(ANCHOR_SEARCH_WINDOW - 1);
    // The anchor scan itself stays window-bounded; the success receipt adds
    // only a constant number of fold-projection rebuilds on top.
    expect(getCandidatePrefixReads()).toBeLessThanOrEqual(ANCHOR_SEARCH_WINDOW + 4);
    expect(getAppendCalls()).toBe(1);
  });

  test("the automatic anchor scan reads session entries once, not once per candidate", async () => {
    // Snapshot contract: the scan's entries read and ID indexing happen once
    // for the whole window. The remaining entries reads are the receipt's
    // constant overhead (label maps, fold projection, label append) — they
    // must stay independent of how many candidates the window inspects.
    const toolCallId = "snapshot-anchor-call";
    const { context, getEntriesReads, getCandidatePrefixReads } = poisonedAutomaticCheckpointContext(toolCallId);

    const result = await executeCheckpoint(
      toolCallId,
      { name: "snapshot-anchor" },
      undefined,
      undefined,
      context,
    );

    expect(result.details?.error).toBeUndefined();
    expect(getCandidatePrefixReads()).toBeGreaterThan(50);
    // Measured 9 on this fixture: label maps, the single snapshot read,
    // the receipt's fold projection, and the label-append path — all
    // constant overhead, independent of the inspected candidate count.
    expect(getEntriesReads()).toBeLessThanOrEqual(10);
    expect(getEntriesReads()).toBeLessThan(getCandidatePrefixReads());
  });

  test("automatic placement receipts show the anchor excerpt and the travel consequence, explicit targets stay bare", async () => {
    // The automatic anchor lands earlier than the model's felt "now". The
    // receipt must show which message the label landed on (sanitized, capped
    // by the shared excerpt limit) and where travel returns to — scoped to
    // conversation context, never files.
    const buildContext = (toolCallId: string, userText: string) => {
      const anchor = {
        type: "message",
        id: "excerpt-anchor",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: userText, timestamp: 0 },
      } as SessionEntry;
      const checkpointCall = {
        type: "message",
        id: "excerpt-checkpoint-call",
        parentId: anchor.id,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "acm_checkpoint", arguments: { name: "excerpt-mark" } }],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "toolUse",
          timestamp: 1,
        },
      } as SessionEntry;
      const entries: SessionEntry[] = [anchor, checkpointCall];
      const sessionManager = {
        getTree: () => [{ entry: anchor, children: [{ entry: checkpointCall, children: [] }] }],
        getEntries: () => entries,
        getBranch: (fromId?: string) => {
          if (fromId === undefined) return [anchor, checkpointCall];
          const index = entries.findIndex((entry) => entry.id === fromId);
          return index < 0 ? [] : entries.slice(0, index + 1);
        },
        getLeafId: () => checkpointCall.id,
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        appendLabelChange: (targetId: string, label: string | undefined) => {
          entries.push(labelEntry(`excerpt-label-${entries.length}`, targetId, label));
          return entries.at(-1)!.id;
        },
      };
      return { sessionManager, getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }), ui: { notify() {} } };
    };

    const longText = `Fix the \u001B[31mparser bug\u001B[0m in module alpha then update schema docs SENTINEL-BEYOND-EXCERPT`;
    const auto = await executeCheckpoint(
      "excerpt-auto-call",
      { name: "excerpt-mark" },
      undefined,
      undefined,
      buildContext("excerpt-auto-call", longText),
    );
    expect(auto.details?.error).toBeUndefined();
    expect(auto.details).toMatchObject({
      entryId: "excerpt-anchor",
      role: "USER",
      targetResolution: "automatic_protocol_complete",
    });
    const autoText = (auto.content[0] as { text: string }).text;
    // The excerpt names the anchored message, quoted and capped: content past
    // the excerpt limit stays out, terminal controls are neutralized.
    expect(autoText).toContain('That message: "');
    expect(autoText).toContain("parser bug");
    expect(autoText).not.toContain("SENTINEL-BEYOND-EXCERPT");
    expect(autoText).not.toContain("\u001B");
    // The consequence is scoped to conversation context and reads forward:
    // where travel returns to, relative to the in-progress assistant turn.
    expect(autoText).toContain("conversation context");
    expect(autoText).toContain("before the later work in the assistant turn");

    // An empty anchored message reports the fallback honestly.
    const empty = await executeCheckpoint(
      "excerpt-empty-call",
      { name: "excerpt-mark" },
      undefined,
      undefined,
      buildContext("excerpt-empty-call", ""),
    );
    expect(empty.details?.error).toBeUndefined();
    expect((empty.content[0] as { text: string }).text).toContain("That message: [no text content]");

    // Explicit targets are caller-chosen positions: the receipt reports the
    // target as before and carries no automatic-placement consequence prose.
    const explicit = await executeCheckpoint(
      "excerpt-explicit-call",
      { name: "explicit-mark", target: "excerpt-anchor" },
      undefined,
      undefined,
      buildContext("excerpt-explicit-call", longText),
    );
    expect(explicit.details?.error).toBeUndefined();
    expect(explicit.details).toMatchObject({ targetResolution: "explicit" });
    const explicitText = (explicit.content[0] as { text: string }).text;
    expect(explicitText).toContain("explicit target 'excerpt-anchor'");
    expect(explicitText).not.toContain("That message:");
    expect(explicitText).not.toContain("conversation context");
  });


  test("collision recovery is self-contained and points to no external skill files", async () => {
    // The skill layer is deleted; a collision must resolve from the recovery
    // text alone instead of routing the model to files that do not exist.
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

    expect(core.details).toMatchObject({ error: "duplicate_name" });
    expect(core.content[0]?.text).toContain("pick a new checkpoint name");
    expect(core.content[0]?.text).not.toContain("context-management");
    expect(core.content[0]?.text).not.toContain("references/");
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

  test("an aborted checkpoint render reconciles the header and the omitted tail with the rendered rows", async () => {
    const fixture = sortedCheckpointTimelineContext();
    const controller = new AbortController();
    controller.abort();

    const result = await executeTimeline(
      "aborted-checkpoints",
      { view: "checkpoints", filter: "checkpoint", limit: 6 },
      controller.signal,
      undefined,
      fixture.context,
    );

    // The abort stops the row loop before any listing renders. Header text,
    // omitted tail, and details must all describe zero rendered rows - the
    // planned 6 would make one receipt contradict itself.
    expect(result.details).toMatchObject({
      checkpointsMatchingEntries: 6,
      checkpointsDisplayedEntries: 0,
      checkpointsDisplayedAliases: 0,
      checkpointAliasNamesShown: 0,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("6 save points matching 'checkpoint', showing 0 (limit 6)");
    expect(text).toContain("... +6 more — use a narrower filter or query");
    expect(text).not.toContain("(checkpoint: checkpoint-on-first");
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
    // The branch budget is the perf contract: one rebuild per target (101
    // packets: current, root, and 99 checkpoints, each reading its branch
    // once inside the snapshot) plus a few view-level branch reads. The old
    // two-walks-per-target shape lands at ~205 and must fail here.
    expect(fixture.getBranchReads()).toBeLessThanOrEqual(106);
    // Checkpoints needs the tree only for the root lookup: exactly one
    // build, never one per target.
    expect(fixture.getTreeReads()).toBe(1);
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
    // Perf contract: the active view answers from branch/entries and never
    // builds the session tree.
    expect(fixture.getTreeReads()).toBe(0);
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

  test("search stops after the first undisplayed pre-order match", async () => {
    const root = userEntry("entry-root");
    const first = userEntry("needle-first", root.id);
    const second = userEntry("needle-second", first.id);
    const third = userEntry("needle-third", root.id);
    let tailContentReads = 0;
    const tail: SessionEntry = {
      type: "message",
      id: "entry-tail",
      parentId: root.id,
      timestamp: "2026-01-01T00:03:00.000Z",
      message: {
        role: "user",
        get content() {
          tailContentReads++;
          return "nonmatching tail sentinel";
        },
        timestamp: 0,
      },
    } as SessionEntry;
    const entries = [root, first, second, third, tail];
    const tree: SessionTreeNode[] = [{
      entry: root,
      children: [
        { entry: first, children: [{ entry: second, children: [] }] },
        { entry: third, children: [] },
        { entry: tail, children: [] },
      ],
    }];
    const ctx = {
      sessionManager: {
        getTree: () => tree,
        getEntries: () => entries,
        getBranch: () => [root, first, second],
        getLeafId: () => second.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("search-early-stop", { view: "search", query: "needle", limit: 2 }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text.indexOf("needle-first")).toBeLessThan(text.indexOf("needle-second"));
    expect(text).not.toContain("needle-third");
    expect(result.details).toMatchObject({ searchDisplayedMatches: 2, searchTruncated: true });
    expect(text).toContain("scan stopped early (display limit)");
    expect(tailContentReads).toBe(0);
  });

  test("search matches mixed-case content case-insensitively on both matcher paths", async () => {
    // The ASCII fast path must reproduce toLowerCase().includes() exactly:
    // mixed-case content, lowercase query, and a hit that straddles the
    // first-character check. A non-ASCII query rides the Unicode fallback and
    // still matches identical text.
    const root = userEntry("entry-root");
    const ascii = userEntry("entry-NeEdLe-mixed", root.id);
    const unicode = userEntry("entry-needle-Ünïcode", ascii.id);
    const entries = [root, ascii, unicode];
    let treeNode: SessionTreeNode | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      treeNode = { entry: entries[index]!, children: treeNode ? [treeNode] : [] };
    }
    const ctx = {
      sessionManager: {
        getTree: () => treeNode ? [treeNode] : [],
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => unicode.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const mixedCase = await executeTimeline("search-mixed-case", { view: "search", query: "needle" }, undefined, undefined, ctx);
    expect(mixedCase.content[0]?.text).toContain("entry-NeEdLe-mixed");
    expect(mixedCase.content[0]?.text).toContain("entry-needle-Ünïcode");

    const exactUnicode = await executeTimeline("search-unicode", { view: "search", query: "Ünïcode" }, undefined, undefined, ctx);
    expect(exactUnicode.content[0]?.text).toContain("entry-needle-Ünïcode");
  });

  test("search does not report truncation when matches exactly fill the limit", async () => {
    const root = userEntry("entry-root");
    const first = userEntry("needle-first", root.id);
    const nonmatch = userEntry("entry-nonmatch", first.id);
    const second = userEntry("needle-second", root.id);
    let tailContentReads = 0;
    const tail: SessionEntry = {
      type: "message",
      id: "entry-tail",
      parentId: root.id,
      timestamp: "2026-01-01T00:03:00.000Z",
      message: {
        role: "user",
        get content() {
          tailContentReads++;
          return "nonmatching tail sentinel";
        },
        timestamp: 0,
      },
    } as SessionEntry;
    const tree: SessionTreeNode[] = [{
      entry: root,
      children: [
        { entry: first, children: [{ entry: nonmatch, children: [] }] },
        { entry: second, children: [] },
        { entry: tail, children: [] },
      ],
    }];
    const entries = [root, first, nonmatch, second, tail];
    const ctx = {
      sessionManager: {
        getTree: () => tree,
        getEntries: () => entries,
        getBranch: () => [root, first, nonmatch],
        getLeafId: () => nonmatch.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("search-exact-limit", { view: "search", query: "needle", limit: 2 }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("needle-first");
    expect(text).toContain("needle-second");
    expect(result.details).toMatchObject({ searchDisplayedMatches: 2, searchTruncated: false });
    expect(text).not.toContain("scan stopped early");
    // The limit is exactly filled, so the scan must keep walking the tree to
    // keep `truncated === false` honest: the sentinel past the last match is
    // still read. A premature stop at the limit-th match would leave it at 0.
    expect(tailContentReads).toBeGreaterThan(0);
  });

  test("a pre-aborted search preserves the truncated receipt", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeTimeline(
      "search-aborted",
      { view: "search", query: "entry", limit: 2 },
      controller.signal,
      undefined,
      timelineContext(),
    );
    expect(result.details).toMatchObject({ searchDisplayedMatches: 0, searchTruncated: true });
    expect(result.content[0]?.text ?? "").toContain("scan stopped early (cancelled)");
  });

  test("search scope and type filters partition the tree without reading excluded content", async () => {
    const root = userEntry("entry-root");
    const activeUser = userEntry("needle-active", root.id);
    const summary: SessionEntry = {
      type: "branch_summary",
      id: "needle-summary",
      parentId: activeUser.id,
      timestamp: "2026-01-01T00:02:00.000Z",
      summary: "needle-summary-body",
    } as SessionEntry;
    const toolResult: SessionEntry = {
      type: "message",
      id: "needle-tool",
      parentId: summary.id,
      timestamp: "2026-01-01T00:03:00.000Z",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "needle-tool-body", isError: false, timestamp: 0 },
    } as SessionEntry;
    let archivedReads = 0;
    const archived: SessionEntry = {
      type: "message",
      id: "needle-archived",
      parentId: root.id,
      timestamp: "2026-01-01T00:04:00.000Z",
      message: {
        role: "user",
        get content() {
          archivedReads++;
          return "needle-archived-body";
        },
        timestamp: 0,
      },
    } as SessionEntry;
    const entries = [root, activeUser, summary, toolResult, archived];
    const tree: SessionTreeNode[] = [{
      entry: root,
      children: [
        { entry: activeUser, children: [{ entry: summary, children: [{ entry: toolResult, children: [] }] }] },
        { entry: archived, children: [] },
      ],
    }];
    const ctx = {
      sessionManager: {
        getTree: () => tree,
        getEntries: () => entries,
        getBranch: () => [root, activeUser, summary, toolResult],
        getLeafId: () => toolResult.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const idsOf = async (params: Record<string, unknown>): Promise<string[]> => {
      const result = await executeTimeline("search-filtered", { view: "search", query: "needle", limit: 10, ...params }, undefined, undefined, ctx);
      const text = result.content[0]?.text ?? "";
      const ids = ["needle-active", "needle-summary", "needle-tool", "needle-archived"].filter((id) => text.includes(id));
      return ids;
    };

    expect(await idsOf({})).toEqual(["needle-active", "needle-summary", "needle-tool", "needle-archived"]);
    expect(await idsOf({ scope: "active" })).toEqual(["needle-active", "needle-summary", "needle-tool"]);
    expect(await idsOf({ scope: "archive" })).toEqual(["needle-archived"]);
    expect(await idsOf({ type: "user" })).toEqual(["needle-active", "needle-archived"]);
    expect(await idsOf({ type: "summary" })).toEqual(["needle-summary"]);
    expect(await idsOf({ type: "tool" })).toEqual(["needle-tool"]);
    expect(await idsOf({ scope: "active", type: "user" })).toEqual(["needle-active"]);
    // The archived node's content is read exactly when it is a candidate
    // (unfiltered, scope=archive, type=user) and never by the scope=active
    // runs — that read is the scan cost this filter exists to skip.
    expect(archivedReads).toBe(3);

    const detailed = await executeTimeline("search-details", { view: "search", query: "needle", scope: "archive", type: "user", limit: 10 }, undefined, undefined, ctx);
    expect(detailed.details).toMatchObject({
      searchScope: "archive",
      searchType: "user",
      searchScanBudget: 5000,
      searchTruncationReason: null,
      searchTruncated: false,
    });
    expect(typeof detailed.details?.searchScannedNodes).toBe("number");
    expect(detailed.content[0]?.text ?? "").toContain("scope archive, type user");
  });

  test("search reports the scan budget boundary honestly", async () => {
    const buildTree = (totalNodes: number) => {
      const root = userEntry("entry-root");
      const children: SessionTreeNode[] = [];
      const entries: SessionEntry[] = [root];
      let tailReads = 0;
      for (let index = 0; index < totalNodes - 1; index++) {
        const isLast = index === totalNodes - 2;
        const entry: SessionEntry = {
          type: "message",
          id: `entry-filler-${index}`,
          parentId: root.id,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "user",
            get content() {
              if (isLast) tailReads++;
              return "filler-body";
            },
            timestamp: 0,
          },
        } as SessionEntry;
        entries.push(entry);
        children.push({ entry, children: [] });
      }
      return { root, children, entries, tailReads: () => tailReads };
    };

    const ctxOf = (built: ReturnType<typeof buildTree>) => ({
      sessionManager: {
        getTree: () => [{ entry: built.root, children: built.children }],
        getEntries: () => built.entries,
        getBranch: () => [built.root],
        getLeafId: () => built.root.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    });

    // Exactly 5,000 nodes, fully scanned, no match: not truncated.
    const exact = buildTree(5_000);
    const exactResult = await executeTimeline("search-budget-exact", { view: "search", query: "zzz-nothing", limit: 5 }, undefined, undefined, ctxOf(exact));
    expect(exactResult.details).toMatchObject({ searchScannedNodes: 5_000, searchTruncated: false, searchTruncationReason: null });

    // 5,001 nodes: the scan stops at the budget, says why, and never reads
    // the content of the unvisited tail node.
    const over = buildTree(5_001);
    const overResult = await executeTimeline("search-budget-over", { view: "search", query: "zzz-nothing", limit: 5 }, undefined, undefined, ctxOf(over));
    expect(overResult.details).toMatchObject({ searchScannedNodes: 5_000, searchTruncated: true, searchTruncationReason: "scan_budget" });
    expect(overResult.content[0]?.text ?? "").toContain("scan stopped at the 5,000-node limit");
    expect(over.tailReads()).toBe(0);
  });

  test("node view returns an off-path entry in full without mutating the tree", async () => {
    // Forked tree: root -> [active branch (kept), archived branch (off-path)].
    // The archived entry's text is far past the 100-char search snippet cut.
    const archivedText = `The parser rejects nested template literals because the lexer state machine drops one brace depth. ${"Detail sentence about the archived investigation. ".repeat(6)}`;
    const root = userEntry("entry-root");
    const activeChild = userEntry("entry-active", root.id);
    const archived: SessionEntry = {
      type: "message",
      id: "entry-archived",
      parentId: root.id,
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: archivedText, timestamp: 0 },
    } as SessionEntry;
    const archivedFollowUp = userEntry("entry-archived-next", archived.id, "2026-01-01T00:02:00.000Z");
    const entries = [root, activeChild, archived, archivedFollowUp, labelEntry("label-arch", archived.id, "parser-notes")];
    const tree: SessionTreeNode[] = [{
      entry: root,
      children: [
        { entry: activeChild, children: [] },
        { entry: archived, children: [{ entry: archivedFollowUp, children: [] }] },
      ],
    }];
    const sessionManager = {
      getTree: () => tree,
      getEntries: () => entries,
      getBranch: (fromId?: string) => {
        if (fromId === archived.id) return [root, archived];
        if (fromId === archivedFollowUp.id) return [root, archived, archivedFollowUp];
        return [root, activeChild];
      },
      getLeafId: () => activeChild.id,
      appendLabelChange: () => { throw new Error("node view must not mutate labels"); },
      branchWithSummary: () => { throw new Error("node view must not branch"); },
    };
    const ctx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
      ui: { notify() {} },
    };
    const leafBefore = sessionManager.getLeafId();
    const entryCountBefore = entries.length;

    const result = await executeTimeline("node-read", { view: "node", target: "parser-notes" }, undefined, undefined, ctx);

    const text = result.content[0]?.text ?? "";
    // entryText is the readable-text projection: extractTextFromContent trims.
    expect(text).toContain(archivedText.trim());
    expect(text).toContain("--- node entry-archived text ---");
    // A complete read carries the end-of-node marker — the structural
    // completeness evidence the cue teaches — and no truncation claim.
    expect(text).toContain("--- end of node entry-archived ---");
    expect(result.details).toMatchObject({ outputTruncatedByCharacterBudget: false });
    expect(text).toContain("off-path");
    expect(text).toContain("checkpoint: parser-notes");
    expect(text).toContain("before entry-root");
    expect(text).toContain("after entry-archived-next");
    expect(result.details).toMatchObject({
      view: "node",
      nodeRequestedTarget: "parser-notes",
      nodeEntryId: "entry-archived",
      nodeLabel: "parser-notes",
      nodeRole: "AI",
      nodeOnActivePath: false,
      nodeBeforeCount: 1,
      nodeAfterCount: 1,
    });
    expect(sessionManager.getLeafId()).toBe(leafBefore);
    expect(entries.length).toBe(entryCountBefore);
  });

  test("node descendant neighbors preserve BFS order across unreadable child branches", async () => {
    const root = userEntry("entry-root");
    const unreadableA = {
      type: "message",
      id: "entry-tool-only-a",
      parentId: root.id,
      timestamp: "2026-01-01T00:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.md" } }],
        timestamp: 0,
      },
    } as SessionEntry;
    const unreadableB = {
      type: "message",
      id: "entry-tool-only-b",
      parentId: root.id,
      timestamp: "2026-01-01T00:02:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.md" } }],
        timestamp: 0,
      },
    } as SessionEntry;
    const readableA = userEntry("entry-readable-a", unreadableA.id, "2026-01-01T00:03:00.000Z");
    const readableB = userEntry("entry-readable-b", unreadableB.id, "2026-01-01T00:04:00.000Z");
    const entries = [root, unreadableA, unreadableB, readableA, readableB];
    const tree: SessionTreeNode[] = [{
      entry: root,
      children: [
        { entry: unreadableA, children: [{ entry: readableA, children: [] }] },
        { entry: unreadableB, children: [{ entry: readableB, children: [] }] },
      ],
    }];
    const ctx = {
      sessionManager: {
        getTree: () => tree,
        getEntries: () => entries,
        getBranch: () => [root],
        getLeafId: () => readableA.id,
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("node-branching-bfs", { view: "node", target: root.id }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      nodeBeforeCount: 0,
      nodeAfterCount: 2,
      nodeNeighborScanAborted: false,
    });
    expect(text.indexOf("after entry-readable-a")).toBeLessThan(text.indexOf("after entry-readable-b"));
    expect(text).toContain("2 child branches");
  });

  test("node view reports a stable error for an unknown target without mutating", async () => {
    const fixture = timelineContext();
    const result = await executeTimeline("node-miss", { view: "node", target: "no-such-checkpoint" }, undefined, undefined, fixture);
    expect(result.details).toMatchObject({ error: "target_not_found", nodeRequestedTarget: "no-such-checkpoint" });
    expect(result.content[0]?.text ?? "").toContain("view=search locates candidates");

    const missing = await executeTimeline("node-missing-target", { view: "node" }, undefined, undefined, fixture);
    expect(missing.details).toMatchObject({ error: "missing_target" });
  });

  test("node view truncation footer names the node instead of suggesting a narrower query", async () => {
    const hugeText = "archived fact ".repeat(40_000);
    const root = userEntry("entry-root");
    const huge: SessionEntry = {
      type: "message",
      id: "entry-huge",
      parentId: root.id,
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: hugeText, timestamp: 0 },
    } as SessionEntry;
    const tree: SessionTreeNode[] = [{ entry: root, children: [{ entry: huge, children: [] }] }];
    const sessionManager = {
      getTree: () => tree,
      getEntries: () => [root, huge],
      getBranch: (fromId?: string) => fromId === huge.id ? [root, huge] : [root],
      getLeafId: () => root.id,
    };
    const ctx = {
      sessionManager,
      // Small window drives a small character budget so the huge node overflows it.
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 20_000, percent: 50 }),
      ui: { notify() {} },
    };
    const result = await executeTimeline("node-truncated", { view: "node", target: "entry-huge" }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    const budget = result.details?.resultCharacterBudget;
    if (typeof budget !== "number") throw new Error("node view omitted its character budget");
    expect(result.details).toMatchObject({ outputTruncatedByCharacterBudget: true });
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain(`… [timeline node output truncated at ${budget} characters; node entry-huge; active leaf ${root.id}.]`);
    expect(text).not.toContain("Use a narrower filter/query");
    // A truncated result must not carry the structural completeness evidence:
    // the cut removes the end-of-node marker along with the tail.
    expect(text).not.toContain("--- end of node entry-huge ---");
  });

  test("node view keeps the budget invariant even when entry IDs are oversized", async () => {
    // IDs come from persisted sessions — imported, hand-edited, or produced
    // by another host — so the footer must bound them instead of assuming
    // they stay short.
    const hugeId = `entry-${"x".repeat(12_000)}`;
    const root = userEntry("entry-root");
    const huge: SessionEntry = {
      type: "message",
      id: hugeId,
      parentId: root.id,
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: "archived fact ".repeat(40_000), timestamp: 0 },
    } as SessionEntry;
    const tree: SessionTreeNode[] = [{ entry: root, children: [{ entry: huge, children: [] }] }];
    const sessionManager = {
      getTree: () => tree,
      getEntries: () => [root, huge],
      getBranch: (fromId?: string) => fromId === hugeId ? [root, huge] : [root],
      getLeafId: () => root.id,
    };
    const ctx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 20_000, percent: 50 }),
      ui: { notify() {} },
    };
    const result = await executeTimeline("node-huge-id", { view: "node", target: hugeId }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    const budget = result.details?.resultCharacterBudget;
    if (typeof budget !== "number") throw new Error("node view omitted its character budget");
    expect(result.details).toMatchObject({ outputTruncatedByCharacterBudget: true });
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain("[timeline node output truncated at");
  });

  test("a cancelled node request reports the interrupted neighbor scan instead of a clean zero", async () => {
    // A pre-aborted signal must not let a real descendant disappear into a
    // confident "0 after" — the receipt has to distinguish "none exist"
    // from "the scan was cancelled".
    const root = userEntry("entry-root");
    const child = userEntry("entry-child", root.id, "2026-01-01T00:01:00.000Z");
    const tree: SessionTreeNode[] = [{ entry: root, children: [{ entry: child, children: [] }] }];
    const sessionManager = {
      getTree: () => tree,
      getEntries: () => [root, child],
      getBranch: (fromId?: string) => fromId === root.id ? [root] : [root, child],
      getLeafId: () => child.id,
    };
    const ctx = {
      sessionManager,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await executeTimeline("node-aborted", { view: "node", target: "entry-root" }, controller.signal, undefined, ctx);
    expect(result.details).toMatchObject({
      view: "node",
      nodeEntryId: "entry-root",
      nodeAfterCount: 0,
      nodeNeighborScanAborted: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("scan interrupted");
    expect(text).toContain("may omit existing neighbors");
  });


  test("timeline output carries no skill routing regardless of advertised commands", async () => {
    // The skill layer is deleted; the timeline reports facts and cues only,
    // even when a host advertises a similarly named command.
    const withoutSkill = captureTimelineWithCommands([]);
    const withSkill = captureTimelineWithCommands(["skill:context-management"]);

    for (const execute of [withoutSkill, withSkill]) {
      const result = await execute("timeline-no-routing", { view: "active" }, undefined, undefined, timelineContext());
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain("references/");
      expect(text).not.toContain("Skill");
      expect(text).not.toContain("Router location");
    }
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

  test("indeterminate travel reports the automatic return ticket as the recovery pointer", async () => {
    // Every travel now records a return ticket, so even an indeterminate
    // mutation names a concrete label to recover by instead of leaving the
    // model without a pointer.
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
    const ticket = (result.details as { backupCurrentHeadAs?: string }).backupCurrentHeadAs;
    expect(typeof ticket).toBe("string");
    expect(result.content[0]?.text).toContain(`Return-ticket label '${ticket}'`);
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
      // The return-ticket transaction must survive an evidence failure:
      // trusted receipt matching and [raw archive] classification read these
      // fields from the receipt itself.
      hasBackup: true,
      backupCurrentHeadAs: "preserve-the-current-task-raw",
      backupEntryId: "travel-head",
      backupOutcome: "created",
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
      hasBackup: true,
      backupCurrentHeadAs: "preserve-the-current-task-raw",
      backupEntryId: "travel-head",
      backupOutcome: "created",
    });
    expect(runtime.contextRefresh.isPending(context.sessionManager)).toBe(true);
    expect(result.content[0]?.text).toContain("Travel complete");
    // The mutation applied, so the fold count describes it even though the
    // post-mutation observation failed before the fold row could be built.
    // Otherwise every later boundary row understates foldsSoFar.
    expect(runtime.ledgerState(context.sessionManager as never).folds).toBe(1);
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
      hasBackup: true,
      backupCurrentHeadAs: "preserve-the-current-task-raw",
      backupEntryId: "travel-head",
      backupOutcome: "created",
    });
    expect(result.content[0]?.text).toContain("Travel complete");
    expect(result.content[0]?.text).toContain("invalid_tool_call_id");
    expect(result.content[0]?.text).toContain(`Applied handoff NEXT: ${HANDOFF.next}`);
  });

  test("an applied-but-unverified receipt still forms a trusted travel transaction", async () => {
    const fixture = successfulTravelContext(false, true);
    const result = await executeTravel(
      "travel-unverified-trusted",
      { target: "travel-root", handoff: HANDOFF },
      undefined,
      undefined,
      fixture,
    );
    expect(result.details).toMatchObject({
      mutationStatus: "applied",
      postMutationEvidenceStatus: "invalid_protocol",
    });

    // Reconstruct the receipt exactly as it would be persisted, then verify
    // it matches its summary provenance: this is what timeline [raw archive]
    // classification and packet normalization depend on.
    const summaryEntry = fixture.sessionManager.getEntry("travel-summary")!;
    const receiptEntry = {
      type: "message",
      id: "receipt-unverified",
      parentId: "travel-summary",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "travel-unverified-trusted",
        toolName: "acm_travel",
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: 2,
      },
    } as SessionEntry;
    const transactions = collectTrustedAcmTravelTransactions([summaryEntry, receiptEntry]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      summaryEntryId: "travel-summary",
      backupEntryId: "travel-head",
    });
  });
});

describe("search text budget", () => {
  test("oversized entries are cut at the node cap and the call budget reports honestly", async () => {
    const entries = [];
    for (let index = 0; index < 60; index++) {
      entries.push({
        type: "message",
        id: `big-${index}`,
        parentId: index === 0 ? null : `big-${index - 1}`,
        timestamp: new Date(1700000000000 + index * 1000).toISOString(),
        message: { role: "user", content: `needle ${index} ${"x".repeat(70_000)}` },
      } as never);
    }
    let treeNode;
    for (let index = entries.length - 1; index >= 0; index--) {
      treeNode = { entry: entries[index], children: treeNode ? [treeNode] : [] };
    }
    const ctx = {
      sessionManager: {
        getTree: () => [treeNode],
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => "big-59",
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };
    // 60 nodes × 64KB cut = ~3.8MB > 2MB budget: the scan stops early with
    // the text_budget reason, and the receipt states both budgets.
    const result = await executeTimeline("text-budget", { view: "search", query: "zzz-absent" }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("truncated (text budget");
    expect(result.details).toMatchObject({ searchTruncated: true, searchTruncationReason: "text_budget" });
    // A hit inside the node cut still matches and renders a bounded snippet.
    const hit = await executeTimeline("text-budget-hit", { view: "search", query: "needle 3" }, undefined, undefined, ctx);
    const hitText = hit.content[0]?.text ?? "";
    expect(hitText).toContain("big-3");
    expect(hitText).not.toContain("x".repeat(200));
    // Source work reaches the call budget exactly. The final partial node is
    // attributed to the call-budget remainder, not misreported as a full
    // 65,536-char node-cap cut.
    expect(hit.details).toMatchObject({
      searchTextChars: 2_000_000,
      searchNodesCutAtNodeCap: 30,
      searchNodesCutAtCallBudget: 1,
    });
    expect(hitText).toContain("30 node(s) were searched only through their first 65,536 source chars");
    expect(hitText).toContain("1 node(s) were cut at the remaining per-call text budget");

    // A hit that exists ONLY past the 65,536-char cut must not read as a
    // clean zero: the cut is reported, so the model knows where it did not
    // look.
    const tailEntry = {
      type: "message",
      id: "tail-carrier",
      parentId: "big-59",
      timestamp: "2026-01-01T00:00:59.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "y".repeat(65_536) },
          { type: "toolCall", id: "tail-call", name: "read" },
          { type: "text", text: "UNIQUE_TAIL_NEEDLE" },
        ],
      },
    } as never;
    const tailCtx = {
      sessionManager: {
        getTree: () => [{ entry: tailEntry, children: [] }],
        getEntries: () => [tailEntry],
        getBranch: () => [tailEntry],
        getLeafId: () => "tail-carrier",
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };
    const tail = await executeTimeline("tail-needle", { view: "search", query: "UNIQUE_TAIL_NEEDLE" }, undefined, undefined, tailCtx);
    const tailText = tail.content[0]?.text ?? "";
    expect(tailText).toContain("0");
    expect(tailText).toContain("1 node(s) were searched only through their first 65,536 source chars");
    expect(tail.details).toMatchObject({ searchNodesCutAtNodeCap: 1, searchNodesCutAtCallBudget: 0 });
  });

  test("charges whitespace source work against the call budget", async () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      type: "message",
      id: `space-${index}`,
      parentId: index === 0 ? null : `space-${index - 1}`,
      timestamp: new Date(1700001000000 + index * 1000).toISOString(),
      message: { role: "user", content: " ".repeat(65_536) },
    })) as never[];
    let treeNode: { entry: never; children: unknown[] } | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      treeNode = { entry: entries[index]!, children: treeNode ? [treeNode] : [] };
    }
    const ctx = {
      sessionManager: {
        getTree: () => [treeNode],
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => "space-39",
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("whitespace-budget", { view: "search", query: "zzz-absent" }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      searchDisplayedMatches: 0,
      searchTruncated: true,
      searchTruncationReason: "text_budget",
      searchScannedNodes: 31,
      searchTextChars: 2_000_000,
      searchNodesCutAtNodeCap: 0,
      searchNodesCutAtCallBudget: 1,
    });
    expect(text).toContain("2000000/2000000 text-budget chars");
    expect(text).toContain("1 node(s) were cut at the remaining per-call text budget");
  });

  test("does not claim a node cut when the call budget ends on a full-node boundary", async () => {
    const entries = Array.from({ length: 32 }, (_, index) => ({
      type: "message",
      id: `boundary-${index}`,
      parentId: index === 0 ? null : `boundary-${index - 1}`,
      timestamp: new Date(1700002000000 + index * 1000).toISOString(),
      message: { role: "user", content: "x".repeat(index < 30 ? 65_536 : index === 30 ? 33_920 : 10) },
    })) as never[];
    let treeNode: { entry: never; children: unknown[] } | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      treeNode = { entry: entries[index]!, children: treeNode ? [treeNode] : [] };
    }
    const ctx = {
      sessionManager: {
        getTree: () => [treeNode],
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => "boundary-31",
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("exact-text-budget", { view: "search", query: "zzz-absent" }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      searchTruncationReason: "text_budget",
      searchScannedNodes: 31,
      searchTextChars: 2_000_000,
      searchNodesCutAtNodeCap: 0,
      searchNodesCutAtCallBudget: 0,
    });
    expect(text).toContain("later nodes were not searched, and any partial-node cuts are reported above");
    expect(text).not.toContain("largest entries were cut before their ends");
  });

  test("keeps partial-node cuts visible when the output budget trims the tail notices", async () => {
    // A node cut at the 65,536-char cap does not set search.truncated, so the
    // header reads " matching node(s)" — complete. Long match rows then push
    // the detailed cut notices past the character budget. Unless the header
    // carries the cut summary, a partial search reports itself as exhaustive.
    const longId = (index: number) => `match-${index}-${"i".repeat(190)}`;
    const capCarrier = {
      type: "message",
      id: "cap-carrier",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.000Z",
      message: { role: "user", content: "y".repeat(65_600) },
    };
    const matchEntries = Array.from({ length: 50 }, (_, index) => ({
      type: "message",
      id: longId(index),
      parentId: index === 0 ? "cap-carrier" : longId(index - 1),
      timestamp: new Date(1770000000000 + index * 1000).toISOString(),
      message: { role: "user", content: `needle ${index} ${"p".repeat(200)}` },
    }));
    const entries = [capCarrier, ...matchEntries] as never[];
    let treeNode: { entry: never; children: unknown[] } | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      treeNode = { entry: entries[index]!, children: treeNode ? [treeNode] : [] };
    }
    const ctx = {
      sessionManager: {
        getTree: () => [treeNode],
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => longId(49),
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      ui: { notify() {} },
    };

    const result = await executeTimeline("cut-under-budget", { view: "search", query: "needle" }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    expect(result.details).toMatchObject({
      searchDisplayedMatches: 50,
      searchTruncated: false,
      searchNodesCutAtNodeCap: 1,
      searchNodesCutAtCallBudget: 0,
    });
    // The output really was trimmed, and the detailed notice really is gone.
    expect(text).toContain("timeline output truncated at");
    expect(text).not.toContain("were searched only through their first");
    // The surviving search header still admits the partial search.
    const header = text.split("\n").find((line) => line.startsWith("Search '")) ?? "";
    expect(header).toContain("50 displayed matching node(s)");
    expect(header).toContain("1 node(s) partially searched (their later text was not searched)");
  });
});
