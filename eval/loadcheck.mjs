#!/usr/bin/env bun
// Quick load-check: does a given extension source load against the current Pi
// host, register the ACM tools, and successfully run acm_timeline?
//
// Usage: bun eval/loadcheck.mjs <path-to/src/index.ts> [provider/model]

import { join } from "node:path";
import { buildAgentDir, createRunDir } from "./setup.mjs";
import { PiRpcDriver } from "./driver.mjs";

const ext = process.argv[2];
if (!ext) { console.error("need extension path"); process.exit(2); }
const raw = process.argv[3] ?? "local-openai/mimo-v2.5";
const slash = raw.indexOf("/");
const provider = slash < 0 ? "local-openai" : raw.slice(0, slash);
const modelId = slash < 0 ? raw : raw.slice(slash + 1);

const agentDir = buildAgentDir({ contextWindow: 60000, label: "agent-loadcheck" });
const runDir = createRunDir("loadcheck");
const driver = new PiRpcDriver({
  cwd: join(runDir, "workspace"),
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPath: ext,
  provider, modelId, thinkingLevel: "off",
});

driver.start();
try {
  const ev = await driver.prompt('Call acm_timeline with view "active", then reply with the single word OK.', { timeoutMs: 120000 });
  const starts = ev.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName);
  const acmEnd = ev.find((e) => e.type === "tool_execution_end" && String(e.toolName ?? "").startsWith("acm_"));
  console.log("EXT:", ext);
  console.log("tool calls:", starts.join(",") || "(none)");
  console.log("acm_timeline:", acmEnd ? (acmEnd.isError ? "REGISTERED-but-ERRORED" : "OK") : "NOT CALLED/registered");
  console.log("stderr bytes:", driver.stderr.length);
  if (driver.stderr.length) console.log("stderr head:\n" + driver.stderr.slice(0, 1200));
} catch (e) {
  console.log("EXT:", ext);
  console.log("LOAD/RUN FAILED:", e instanceof Error ? e.message : String(e));
  if (driver.stderr.length) console.log("stderr head:\n" + driver.stderr.slice(0, 1200));
} finally {
  await driver.stop();
}
