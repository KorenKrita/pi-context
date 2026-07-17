#!/usr/bin/env bun
// Live ACM eval runner.
//
// Usage:
//   bun eval/run.mjs [--model provider/id] [--thinking level] [--family name] [--id scenario-id] [--list]
//
// Reads ~/.pi/agent models via the harness agent dir. Writes a JSON report under
// eval/.runs/<stamp>-eval/report.json and prints a compact summary.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentDir, createRunDir, EXTENSION_PATH } from "./setup.mjs";
import { PiRpcDriver } from "./driver.mjs";
import {
  extractAssistantTexts,
  extractToolCalls,
  listScenarios,
} from "./scenarios.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseModel(raw) {
  if (!raw) return { provider: "local-openai", modelId: "mimo-v2.5" };
  if (raw.includes("/")) {
    const slash = raw.indexOf("/");
    return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
  }
  return { provider: "local-openai", modelId: raw };
}

if (process.argv.includes("--list")) {
  for (const scenario of listScenarios()) {
    console.log(`${scenario.id}\t${scenario.family}\t${scenario.description}`);
  }
  process.exit(0);
}

const modelSpec = parseModel(option("--model") ?? process.env.ACM_EVAL_MODEL);
const thinkingLevel = option("--thinking") ?? process.env.ACM_EVAL_THINKING ?? "off";
const family = option("--family");
const onlyId = option("--id");
const contextWindow = Number(option("--context-window") ?? 80000);

const scenarios = listScenarios({ family }).filter((s) => !onlyId || s.id === onlyId);
if (scenarios.length === 0) {
  console.error("No scenarios matched.");
  process.exit(1);
}

const agentDir = buildAgentDir({ contextWindow });
const runDir = createRunDir(`eval-${modelSpec.modelId}`);
const report = {
  startedAt: new Date().toISOString(),
  model: modelSpec,
  thinkingLevel,
  contextWindow,
  runDir,
  results: [],
};

console.log(`model=${modelSpec.provider}/${modelSpec.modelId} thinking=${thinkingLevel}`);
console.log(`run dir: ${runDir}`);
console.log(`scenarios: ${scenarios.map((s) => s.id).join(", ")}`);

for (const scenario of scenarios) {
  const scenarioDir = join(runDir, scenario.id);
  mkdirSync(join(scenarioDir, "workspace"), { recursive: true });
  mkdirSync(join(scenarioDir, "sessions"), { recursive: true });
  for (const [rel, contents] of Object.entries(scenario.seedFiles ?? {})) {
    const path = join(scenarioDir, "workspace", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }

  const driver = new PiRpcDriver({
    cwd: join(scenarioDir, "workspace"),
    agentDir,
    sessionDir: join(scenarioDir, "sessions"),
    extensionPath: EXTENSION_PATH,
    provider: modelSpec.provider,
    modelId: modelSpec.modelId,
    thinkingLevel: scenario.thinkingLevel ?? thinkingLevel,
    eventLogPath: join(scenarioDir, "events.jsonl"),
  });

  const started = Date.now();
  /** @type {any} */
  let result = {
    id: scenario.id,
    family: scenario.family,
    description: scenario.description,
    pass: false,
    checks: [],
    toolCalls: [],
    error: null,
    durationMs: 0,
  };

  console.log(`\n=== ${scenario.id} ===`);
  driver.start();
  try {
    const allEvents = [];
    for (const turn of scenario.turns) {
      const events = await driver.prompt(turn.prompt, { timeoutMs: turn.timeoutMs ?? 240000 });
      allEvents.push(...events);
    }
    const toolCalls = extractToolCalls(allEvents);
    const assistantTexts = extractAssistantTexts(allEvents);
    const scored = scenario.score({ events: allEvents, toolCalls, assistantTexts });
    result = {
      ...result,
      pass: scored.pass,
      checks: scored.checks,
      toolCalls: toolCalls.map((c) => ({
        name: c.name,
        args: c.args,
        isError: c.isError ?? false,
        resultPreview: (c.resultText ?? "").slice(0, 240),
      })),
      assistantPreview: (assistantTexts.at(-1) ?? "").slice(0, 400),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.durationMs = Date.now() - started;
  } finally {
    await driver.stop();
  }

  const status = result.pass ? "PASS" : "FAIL";
  console.log(`${status} (${result.durationMs}ms)`);
  for (const check of result.checks) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (result.error) console.log(`  error: ${result.error}`);
  if (result.toolCalls?.length) {
    console.log(`  tools: ${result.toolCalls.map((c) => c.name).join(", ")}`);
  }
  report.results.push(result);
  writeFileSync(join(scenarioDir, "result.json"), JSON.stringify(result, null, 2));
}

report.finishedAt = new Date().toISOString();
report.passed = report.results.filter((r) => r.pass).length;
report.failed = report.results.filter((r) => !r.pass).length;
report.passRate = report.results.length === 0 ? 0 : report.passed / report.results.length;
writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));

console.log(`\n=== summary ===`);
console.log(`${report.passed}/${report.results.length} passed (${(report.passRate * 100).toFixed(0)}%)`);
console.log(`report: ${join(runDir, "report.json")}`);
process.exit(report.failed === 0 ? 0 : 1);
