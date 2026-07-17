// Smoke test: boot headless Pi with the local ACM extension and a cheap
// model, confirm the ACM tools are registered and callable end to end.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { buildAgentDir, createRunDir, EXTENSION_PATH } from "./setup.mjs";
import { PiRpcDriver } from "./driver.mjs";

const provider = process.argv[2] ?? "local-openai";
const modelId = process.argv[3] ?? "mimo-v2.5";

const agentDir = buildAgentDir({ contextWindow: 80000 });
const runDir = createRunDir(`smoke-${modelId}`);
writeFileSync(join(runDir, "workspace", "notes.md"), "# Scratch project\n\nNothing here yet.\n");

const driver = new PiRpcDriver({
  cwd: join(runDir, "workspace"),
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPath: EXTENSION_PATH,
  provider,
  modelId,
  thinkingLevel: "off",
  eventLogPath: join(runDir, "events.jsonl"),
});

driver.start();
console.log(`run dir: ${runDir}`);

try {
  const state = await driver.getState();
  console.log("state:", JSON.stringify(state));

  const turn = await driver.prompt(
    "Call the acm_timeline tool with view \"active\", then reply with exactly one short sentence describing what it returned.",
    { timeoutMs: 180000 },
  );
  const toolCalls = turn.filter((e) => e.type === "tool_execution_start");
  console.log("tool calls this turn:", toolCalls.map((e) => e.toolName ?? e.name ?? JSON.stringify(e).slice(0, 100)));
  const assistantTexts = turn
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => (e.message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""));
  console.log("assistant:", assistantTexts.at(-1) ?? "(none)");
} finally {
  await driver.stop();
}
console.log("exit ok, stderr bytes:", driver.stderr.length);
if (driver.stderr.length > 0) console.log("stderr:", driver.stderr.slice(0, 2000));
