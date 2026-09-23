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

    const first = await runner.emitBeforeAgentStart("hello", undefined, { cwd: tempDir });
    const section = first.systemPromptOptions.sections?.["acm_core"];
    expect(section).toBeDefined();
    expect(section).toStartWith(generated.ACM_CORE_MARKER);
    expect(section).toContain("The fold test");
    expect(section?.split(generated.ACM_CORE_MARKER)).toHaveLength(2);
    // Structured section, not a forced whole-prompt replacement.
    expect(first.systemPromptOptions.forceSystemPrompt).toBeUndefined();

    const second = await runner.emitBeforeAgentStart("again", undefined, first.systemPromptOptions);
    expect(second.systemPromptOptions.sections?.["acm_core"]).toBe(section!);
    expect(second.systemPromptOptions.forceSystemPrompt).toBeUndefined();
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
    expect(tools.get("acm_travel")?.description).toContain("alone in its tool batch");
    const travelParameters = tools.get("acm_travel")?.parameters as {
      required?: string[];
      properties?: Record<string, { anyOf?: Array<{ type?: string; required?: string[] }> }>;
    };
    expect(travelParameters.required).toContain("handoff");
    expect(travelParameters.properties?.summary).toBeUndefined();
    const handoffProperty = travelParameters.properties?.handoff as { type?: string; required?: string[] } | undefined;
    // Strict-mode wire shape, structured-only: every field listed in required
    // so constrained decoding accepts the schema; supporting fields stay cheap
    // by taking null, and prepareArguments fills null for callers that omit
    // them. The legacy JSON-string variant must NOT be provider-visible — a
    // schema-legal string handoff would inevitably fail invalid_json, so it
    // is rescued in prepareArguments instead.
    expect(handoffProperty?.type).toBe("object");
    expect(handoffProperty?.required?.sort()).toEqual([
      "evidence", "exclusions", "external", "goal", "next", "recover", "state",
    ]);
    expect(travelParameters.properties?.handoff?.anyOf).toBeUndefined();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
