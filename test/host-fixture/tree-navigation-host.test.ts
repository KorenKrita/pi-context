import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createModelRegistry } from "./model-registry.ts";
import { TREE_SUMMARY_INSTRUCTIONS } from "../../src/generated-guidance.ts";


async function createRunner(tempDir: string, sessionManager: SessionManager) {
  const loaded = await discoverAndLoadExtensions(
    ["./.acm-build/index.js"],
    import.meta.dir,
    join(tempDir, "empty-agent-dir"),
  );
  expect(loaded.errors).toEqual([]);
  const modelRegistry = await createModelRegistry(tempDir);
  return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);
}

test("plain /tree summarize receives the handoff prompt through the exact Pi runner merge", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-tree-host-"));
  try {
    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
    const runner = await createRunner(tempDir, sessionManager);

    const abandoned = sessionManager.getBranch().filter((entry: SessionEntry) => entry.id !== rootId);
    const oldLeafId = sessionManager.getLeafId();
    const result = await runner.emit({
      type: "session_before_tree",
      preparation: {
        targetId: rootId,
        oldLeafId,
        commonAncestorId: rootId,
        entriesToSummarize: abandoned,
        userWantsSummary: true,
      },
      signal: new AbortController().signal,
    }) as { customInstructions: string; replaceInstructions: boolean };

    expect(result.replaceInstructions).toBe(true);
    expect(result.customInstructions.startsWith(TREE_SUMMARY_INSTRUCTIONS)).toBe(true);
    expect(result.customInstructions).toContain(`The abandoned branch tip is node ${oldLeafId}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("user-authored /tree instructions pass through the exact Pi runner untouched", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-tree-host-"));
  try {
    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
    const runner = await createRunner(tempDir, sessionManager);

    const result = await runner.emit({
      type: "session_before_tree",
      preparation: {
        targetId: rootId,
        oldLeafId: sessionManager.getLeafId(),
        commonAncestorId: rootId,
        entriesToSummarize: sessionManager.getBranch(),
        userWantsSummary: true,
        customInstructions: "focus on the database work",
      },
      signal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session_tree navigation resets the reminder cycle on the exact Pi host", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-tree-host-"));
  try {
    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
    const runner = await createRunner(tempDir, sessionManager);

    const sentMessages: unknown[] = [];
    runner.bindCore({
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
      },
      sendUserMessage: async () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => {},
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    }, {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => ({ tokens: 55_000, contextWindow: 100_000, percent: 55 }),
      compact: () => {},
      getSystemPrompt: () => "base prompt",
      getSystemPromptOptions: () => ({ cwd: tempDir }),
    });

    // Reach the 50% tier, then navigate before any tool boundary delivers it.
    await runner.emitContext([]);
    await runner.emit({
      type: "session_tree",
      newLeafId: rootId,
      oldLeafId: sessionManager.getLeafId(),
    });
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: {},
      content: [],
      isError: false,
    });
    expect(sentMessages).toHaveLength(0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
