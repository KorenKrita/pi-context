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

test("finalized ExtensionRunner tool result controls provider cutover and queues no duplicate NEXT", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-final-receipt-host-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      ["./.acm-build/index.js"],
      import.meta.dir,
      join(tempDir, "empty-agent-dir"),
    );
    expect(loaded.errors).toEqual([]);

    const template = loaded.extensions[0]!;
    const laterResultRewriter = {
      ...template,
      path: "<inline:rewrite-travel-result>",
      resolvedPath: "<inline:rewrite-travel-result>",
      handlers: new Map([["tool_result", [(event: { toolCallId: string }) => event.toolCallId === "travel-untrusted-receipt"
        ? {
            isError: false,
            details: { rewrittenByLaterExtension: true },
          }
        : {
            isError: true,
            details: { error: "rewritten_by_later_extension" },
          }]]]),
      tools: new Map(),
      messageRenderers: new Map(),
      entryRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    };
    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    const modelRegistry = await createModelRegistry(tempDir);
    const runner = new ExtensionRunner(
      [...loaded.extensions, laterResultRewriter as never],
      loaded.runtime,
      tempDir,
      sessionManager,
      modelRegistry,
    );
    const sent: Array<{ message: unknown; options: unknown }> = [];
    let idle = false;
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
      isIdle: () => idle,
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
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    sessionManager.appendMessage({ role: "user", content: "raw work", timestamp: Date.now() });
    const travel = runner.getToolDefinition("acm_travel");
    if (!travel) throw new Error("acm_travel was not registered");
    const travelResult = await travel.execute(
      "travel-final-receipt",
      {
        target: rootId,
        handoff: {
          goal: "continue once from final receipt",
          state: "travel tree mutation applied",
          evidence: "exact ExtensionRunner ordering",
          external: "none",
          exclusions: "interceptable tool_result state",
          recover: "root",
          next: "continue exactly once",
        },
      },
      undefined,
      undefined,
      runner.createContext(),
    );
    const intercepted = await runner.emitToolResult({
      type: "tool_result" as const,
      toolName: "acm_travel",
      toolCallId: "travel-final-receipt",
      input: {},
      content: travelResult.content,
      isError: false,
      details: travelResult.details,
    });
    expect(intercepted).toMatchObject({
      isError: true,
      details: { error: "rewritten_by_later_extension" },
    });
    expect(sent).toEqual([]);

    const finalizedMessage = {
      role: "toolResult" as const,
      toolCallId: "travel-final-receipt",
      toolName: "acm_travel",
      content: intercepted?.content ?? travelResult.content,
      details: intercepted?.details,
      isError: intercepted?.isError ?? false,
      timestamp: Date.now(),
    };
    const messageReplacement = await runner.emitMessageEnd({ type: "message_end", message: finalizedMessage });
    const persistedMessage = messageReplacement ?? finalizedMessage;
    sessionManager.appendMessage(persistedMessage);
    const providerMessages = await runner.emitContext([persistedMessage]);

    expect(providerMessages.some((message) => message.role === "custom" && message.customType === "acm:continuation")).toBe(false);
    expect(sent).toEqual([]);

    idle = true;
    await runner.emit({ type: "agent_settled" });
    const afterSettlement = await runner.emitContext([persistedMessage]);
    expect(afterSettlement.some((message) => message.role === "custom" && message.customType === "acm:continuation")).toBe(false);
    expect(JSON.stringify(afterSettlement)).not.toContain("continue once from final receipt");

    const untrustedResult = await travel.execute(
      "travel-untrusted-receipt",
      {
        target: rootId,
        handoff: {
          goal: "never cut over from an untrusted receipt",
          state: "tree mutation applied before a later extension stripped proof",
          evidence: "exact ExtensionRunner non-error rewrite ordering",
          external: "none",
          exclusions: "untrusted finalized details",
          recover: "root",
          next: "remain on the current provider and native context",
        },
      },
      undefined,
      undefined,
      runner.createContext(),
    );
    const untrustedIntercepted = await runner.emitToolResult({
      type: "tool_result" as const,
      toolName: "acm_travel",
      toolCallId: "travel-untrusted-receipt",
      input: {},
      content: untrustedResult.content,
      isError: false,
      details: untrustedResult.details,
    });
    expect(untrustedIntercepted).toMatchObject({
      isError: false,
      details: { rewrittenByLaterExtension: true },
    });
    const untrustedMessage = {
      role: "toolResult" as const,
      toolCallId: "travel-untrusted-receipt",
      toolName: "acm_travel",
      content: untrustedIntercepted?.content ?? untrustedResult.content,
      details: untrustedIntercepted?.details,
      isError: untrustedIntercepted?.isError ?? false,
      timestamp: Date.now(),
    };
    const untrustedReplacement = await runner.emitMessageEnd({ type: "message_end", message: untrustedMessage });
    const persistedUntrusted = untrustedReplacement ?? untrustedMessage;
    sessionManager.appendMessage(persistedUntrusted);

    const untrustedProvider = await runner.emitContext([persistedUntrusted]);
    expect(untrustedProvider.some((message) => message.role === "custom" && message.customType === "acm:continuation")).toBe(false);
    expect(JSON.stringify(untrustedProvider)).not.toContain("never cut over from an untrusted receipt");
    const timeline = runner.getToolDefinition("acm_timeline");
    if (!timeline) throw new Error("acm_timeline was not registered");
    const rejectedStatus = await timeline.execute(
      "untrusted-receipt-timeline",
      { view: "active" },
      undefined,
      undefined,
      runner.createContext(),
    );
    expect(rejectedStatus.details).toMatchObject({
      contextRefreshPending: false,
      contextDeliveryPhase: "receipt_rejected",
      providerDeliveryPhase: "receipt_rejected",
      nativeContextReplacement: { status: "skipped", reason: "not_pending" },
    });

    await runner.emit({ type: "agent_settled" });
    const untrustedAfterSettlement = await runner.emitContext([persistedUntrusted]);
    expect(untrustedAfterSettlement.some((message) => message.role === "custom" && message.customType === "acm:continuation")).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
