import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerAcmExtension from "./.acm-build/index.js";
import { ACM_CORE_MARKER } from "../../src/generated-guidance.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

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

async function runSession(responses: AssistantMessage[], prompts: string[], options: { before?: ExtensionFactory[]; after?: ExtensionFactory[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-fold-provider-"));
  tempDirs.push(dir);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
  const requests: TranscriptContext[] = [];
  faux.setResponses(responses.map((message) => (context: TranscriptContext) => {
    requests.push(structuredClone(context));
    return message;
  }));
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...(options.before ?? []),
      registerAcmExtension,
      (pi) => pi.registerTool({
        name: "dump", label: "dump", description: "large diagnostic output", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "DUMPED-LINE ".repeat(2_000) }], details: {} }),
      }),
      ...(options.after ?? []),
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
    for (const prompt of prompts) {
      await session.prompt(prompt);
      await session.waitForIdle();
    }
  } finally {
    session.dispose();
  }
  return (i: number) => JSON.stringify(requests[i]?.messages ?? null);
}

const FOLD_RUN = () => [
  fauxAssistantMessage(fauxToolCall("acm_checkpoint", { name: "before-dump" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("acm_travel", { target: "before-dump", handoff: HANDOFF, backupCurrentHeadAs: null }), { stopReason: "toolUse" }),
  fauxAssistantMessage("Continuing from the handoff."),
  fauxAssistantMessage("Next prompt answered."),
];
const PROMPTS = ["Find why nested comments break.", "Any update?"];
const FENCE = "Do not execute or repeat an earlier request";
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("an acm_travel fold reaches the provider in the same run and in the next prompt, with CORE exactly once", async () => {
  const request = await runSession(FOLD_RUN(), PROMPTS);
  expect(request(4)).not.toBe("null");
  expect(request(2)).toContain("DUMPED-LINE"); // the dump was live before the fold
  for (const i of [0, 3, 4]) expect(count(request(i), ACM_CORE_MARKER)).toBe(1);
  for (const i of [3, 4]) {
    expect(request(i)).not.toContain("DUMPED-LINE");
    expect(request(i)).toContain("edit tokenizeComment in src/lexer.ts");
    // Trusted continuation projection (not the raw archival summary): exactly one replay fence.
    expect(count(request(i), FENCE)).toBe(1);
  }
});

test("a travel receipt rewritten by a later tool_result handler does not become an authoritative continuation", async () => {
  const request = await runSession(FOLD_RUN(), PROMPTS, {
    after: [(pi) => pi.on("tool_result", (event) => (event.toolName === "acm_travel" ? { isError: true, details: { error: "denied by later extension" } } : undefined))],
  });
  expect(request(4)).not.toBe("null");
  for (const i of [3, 4]) expect(count(request(i), FENCE)).toBe(0);
});

test("CORE still reaches the provider when an earlier extension forces the whole system prompt", async () => {
  const request = await runSession([fauxAssistantMessage("ok")], ["hello"], {
    before: [(pi) => pi.on("before_agent_start", () => ({ systemPrompt: "FORCED BASE" }))],
  });
  expect(request(0)).toContain("FORCED BASE");
  expect(count(request(0), ACM_CORE_MARKER)).toBe(1);
});
