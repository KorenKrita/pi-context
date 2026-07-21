import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createModelRegistry } from "./model-registry.ts";
import * as generated from "../../src/generated-guidance.ts";


test("ACM CORE injects once through the exact Pi before_agent_start hook", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-prompt-host-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      ["./.acm-build/index.js"],
      import.meta.dir,
      join(tempDir, "empty-agent-dir"),
    );
    expect(loaded.errors).toEqual([]);

    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const modelRegistry = await createModelRegistry(tempDir);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore({
      sendMessage: async () => {},
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
      getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
      compact: () => {},
      getSystemPrompt: () => "base prompt",
      getSystemPromptOptions: () => ({ cwd: tempDir }),
    });

    const first = await runner.emitBeforeAgentStart("hello", undefined, "base prompt", { cwd: tempDir });
    const injected = first?.systemPrompt;
    expect(injected).toBeDefined();
    expect(injected).toStartWith("base prompt");
    expect(injected).toContain(generated.ACM_CORE_MARKER);
    expect(injected).toContain("Compression is intelligence");
    expect(injected?.split(generated.ACM_CORE_MARKER)).toHaveLength(2);

    const second = await runner.emitBeforeAgentStart("again", undefined, injected!, { cwd: tempDir });
    expect(second?.systemPrompt ?? injected).toBe(injected!);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ACM tools register generated prompt metadata on the exact Pi host", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-tool-host-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      ["./.acm-build/index.js"],
      import.meta.dir,
      join(tempDir, "empty-agent-dir"),
    );
    expect(loaded.errors).toEqual([]);

    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const modelRegistry = await createModelRegistry(tempDir);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);

    const tools = new Map(runner.getAllRegisteredTools().map((tool) => [tool.definition.name, tool.definition]));
    expect([...tools.keys()].sort()).toEqual(["acm_checkpoint", "acm_timeline", "acm_travel"]);
    expect(tools.get("acm_checkpoint")?.promptSnippet).toBe(generated.PROMPT_SNIPPETS.checkpoint);
    expect(tools.get("acm_timeline")?.promptSnippet).toBe(generated.PROMPT_SNIPPETS.timeline);
    expect(tools.get("acm_travel")?.promptSnippet).toBe(generated.PROMPT_SNIPPETS.travel);
    expect(tools.get("acm_travel")?.promptGuidelines).toEqual(generated.PROMPT_GUIDELINES.travel.split("\n"));
    expect(tools.get("acm_travel")?.executionMode).toBe("sequential");
    expect(tools.get("acm_travel")?.description).toContain("alone in its assistant tool batch");
    const travelParameters = tools.get("acm_travel")?.parameters as {
      required?: string[];
      properties?: Record<string, { anyOf?: Array<{ type?: string; required?: string[] }> }>;
    };
    expect(travelParameters.required).toContain("handoff");
    expect(travelParameters.properties?.summary).toBeUndefined();
    const handoffVariants = travelParameters.properties?.handoff?.anyOf ?? [];
    const structuredHandoff = handoffVariants.find((variant) => variant.type === "object");
    const serializedHandoff = handoffVariants.find((variant) => variant.type === "string");
    expect(structuredHandoff?.required?.sort()).toEqual([
      "evidence",
      "exclusions",
      "external",
      "goal",
      "next",
      "recover",
      "state",
    ]);
    expect(serializedHandoff).toBeDefined();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-travel NEXT steer never queues behind a pending user message", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-steer-host-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      ["./.acm-build/index.js"],
      import.meta.dir,
      join(tempDir, "empty-agent-dir"),
    );
    expect(loaded.errors).toEqual([]);

    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const modelRegistry = await createModelRegistry(tempDir);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);
    const sent: Array<{ message: unknown; options: unknown }> = [];
    let pending = true;
    let signal: AbortSignal | undefined;
    runner.bindCore({
      sendMessage: async (message, options) => { sent.push({ message, options }); },
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
      isIdle: () => false,
      isProjectTrusted: () => true,
      getSignal: () => signal,
      abort: () => {},
      hasPendingMessages: () => pending,
      shutdown: () => {},
      getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
      compact: () => {},
      getSystemPrompt: () => "base prompt",
      getSystemPromptOptions: () => ({ cwd: tempDir }),
    });
    const event = {
      type: "tool_result" as const,
      toolName: "acm_travel",
      toolCallId: "travel-1",
      input: {
        target: "root",
        handoff: {
          goal: "continue",
          state: "known",
          evidence: "none",
          external: "none",
          exclusions: "none",
          recover: "none",
          next: "write the old next action",
        },
      },
      content: [],
      isError: false,
      details: { handoffFormat: "structured-v1", resultingLeafId: "summary-1" },
    };

    await runner.emitToolResult(event);
    expect(sent).toEqual([]);

    pending = false;
    await runner.emitToolResult({ ...event, toolCallId: "travel-2" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: { customType: "acm:post-travel-continuation" },
      options: { deliverAs: "steer" },
    });

    const controller = new AbortController();
    controller.abort();
    signal = controller.signal;
    await runner.emitToolResult({ ...event, toolCallId: "travel-3" });
    expect(sent).toHaveLength(1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
