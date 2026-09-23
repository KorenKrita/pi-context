import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "./.acm-build/index.js";

// End to end on the exact host: a real AgentSession, a faux provider, and the provider
// requests themselves as evidence. Pi >= 0.87 builds provider context from the SessionManager,
// so a fold must be visible in the next request without any live message replacement.

const installationSymbol = Symbol.for("pi-context.live-agent-session-adapter.v1");
const originalGetContextUsage = AgentSession.prototype.getContextUsage;
const tempDirs: string[] = [];
afterEach(() => {
  AgentSession.prototype.getContextUsage = originalGetContextUsage;
  delete (AgentSession.prototype as Record<PropertyKey, unknown>)[installationSymbol];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HANDOFF = {
  goal: "trace the parser regression",
  state: "the dump shows the tokenizer drops nested comments",
  next: "edit tokenizeComment in src/lexer.ts",
  evidence: null,
  external: null,
  exclusions: null,
};

test("an acm_travel fold reaches the provider in the same run and in the next prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-fold-provider-"));
  tempDirs.push(dir);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
  const requests: TranscriptContext[] = [];
  const reply = (message: AssistantMessage) => (context: TranscriptContext) => {
    requests.push(structuredClone(context));
    return message;
  };
  faux.setResponses([
    reply(fauxAssistantMessage(fauxToolCall("acm_checkpoint", { name: "before-dump" }), { stopReason: "toolUse" })),
    reply(fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" })),
    reply(fauxAssistantMessage(fauxToolCall("acm_travel", { target: "before-dump", handoff: HANDOFF, backupCurrentHeadAs: null }), { stopReason: "toolUse" })),
    reply(fauxAssistantMessage("Continuing from the handoff.")),
    reply(fauxAssistantMessage("Next prompt answered.")),
  ]);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      registerAcmExtension,
      (pi) => pi.registerTool({
        name: "dump", label: "dump", description: "large diagnostic output", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "DUMPED-LINE ".repeat(2_000) }], details: {} }),
      }),
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  (modelRuntime as unknown as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => true;
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  try {
    await session.prompt("Find why nested comments break.");
    await session.waitForIdle();
    await session.prompt("Any update?");
    await session.waitForIdle();
  } finally {
    session.dispose();
  }

  expect(requests).toHaveLength(5);
  const text = (i: number) => JSON.stringify(requests[i]!.messages);
  expect(text(2)).toContain("DUMPED-LINE"); // the dump was live before the fold
  for (const i of [3, 4]) {
    expect(text(i)).not.toContain("DUMPED-LINE");
    expect(text(i)).toContain("edit tokenizeComment in src/lexer.ts");
    // Trusted continuation projection (not the raw archival summary): exactly one replay fence.
    expect(text(i).split("Do not execute or repeat an earlier request")).toHaveLength(2);
  }
});
