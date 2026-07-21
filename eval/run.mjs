#!/usr/bin/env bun
// Live ACM eval runner.
//
// Usage:
//   bun eval/run.mjs [--model provider/id] [--thinking level] [--family name] [--id scenario-id] [--list]
//                    [--environment-mode core-only|product-isolated|full-env] [--env mode] [--full-env]
//
// Reads ~/.pi/agent models via the harness agent dir. Writes a JSON report under
// eval/.runs/<stamp>-eval/report.json and prints a compact summary.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  buildAgentDir,
  buildFullEnvAgentDir,
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  createRunDir,
  EXTENSION_PATH,
} from "./setup.mjs";
import { classifySkillAvailability, normalizeEnvironmentMode, PiRpcDriver } from "./driver.mjs";
import { createScenarioWorkspace } from "./scenario-workspace.mjs";
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

function flag(name) {
  return process.argv.includes(name);
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
const requestedEnvironmentMode = option("--environment-mode");
const envAlias = option("--env");
if (requestedEnvironmentMode && envAlias && requestedEnvironmentMode !== envAlias) {
  throw new Error("--environment-mode and --env must name the same mode when both are supplied");
}
const fullEnvAlias = flag("--full-env");
const explicitEnvironmentMode = requestedEnvironmentMode ?? envAlias;
if (explicitEnvironmentMode && fullEnvAlias && explicitEnvironmentMode !== "full-env") {
  throw new Error("--full-env conflicts with --environment-mode/--env other than full-env");
}
const environmentMode = normalizeEnvironmentMode({
  environmentMode: explicitEnvironmentMode ?? (fullEnvAlias ? "full-env" : undefined),
});
const fullEnv = environmentMode === "full-env";
const extensionPath = option("--extension") ?? EXTENSION_PATH;
const skillPath = option("--skill") ?? CONTEXT_MANAGEMENT_SKILL_PATH;
const extensionPaths = environmentMode === "raw-control"
  ? []
  : environmentMode === "core-only"
    ? [extensionPath]
    : [extensionPath, CONTEXT_EXTENSION_PATH];
const skillPaths = environmentMode === "core-only" || environmentMode === "raw-control" ? [] : [skillPath];
const expectedSkillPath = (() => {
  try {
    return realpathSync(skillPath);
  } catch {
    return null;
  }
})();
let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse HEAD", { cwd: join(extensionPath, "..", ".."), encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }

const scenarios = listScenarios({ family }).filter((s) => !onlyId || s.id === onlyId);
if (scenarios.length === 0) {
  console.error("No scenarios matched.");
  process.exit(1);
}

const agentDir = fullEnv
  ? buildFullEnvAgentDir({ contextWindow })
  : buildAgentDir({ contextWindow });
const runDir = createRunDir(`eval-${modelSpec.modelId}`);
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  model: modelSpec,
  thinkingLevel,
  contextWindow,
  environmentMode,
  gitHead,
  extensionPaths,
  skillPaths,
  expectedSkillPath,
  runDir,
  results: [],
};

console.log(`model=${modelSpec.provider}/${modelSpec.modelId} thinking=${thinkingLevel}`);
console.log(`environment=${environmentMode}`);
console.log(`gitHead=${gitHead}`);
console.log(`run dir: ${runDir}`);
console.log(`scenarios: ${scenarios.map((s) => s.id).join(", ")}`);

for (const scenario of scenarios) {
  const scenarioDir = join(runDir, scenario.id);
  mkdirSync(join(scenarioDir, "sessions"), { recursive: true });
  // Keep every model-visible workspace out of eval/.runs. Otherwise an agent
  // can traverse into persisted events/session artifacts from a prior turn and
  // invalidate the environment isolation. The directory is retained for
  // post-run evidence, rather than automatically cleaned up.
  const workspace = createScenarioWorkspace({ scenarioId: scenario.id, environmentMode });
  for (const [rel, contents] of Object.entries(scenario.seedFiles ?? {})) {
    const path = join(workspace, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }

  const driver = new PiRpcDriver({
    cwd: workspace,
    agentDir,
    sessionDir: join(scenarioDir, "sessions"),
    extensionPaths,
    skillPaths,
    environmentMode,
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
    environmentMode,
    workspace,
    commands: null,
    skillAvailability: null,
    infrastructureInvalid: null,
    durationMs: 0,
  };

  console.log(`\n=== ${scenario.id} ===`);
  driver.start();
  try {
    try {
      result.commands = await driver.getCommands();
      result.skillAvailability = classifySkillAvailability({
        environmentMode,
        expectedSkillPath,
        commands: result.commands,
        realpath: realpathSync,
      });
    } catch (error) {
      result.skillAvailability = classifySkillAvailability({
        environmentMode,
        expectedSkillPath,
        rpcError: error instanceof Error ? error.message : String(error),
        realpath: realpathSync,
      });
    }

    if (!result.skillAvailability.valid) {
      result.infrastructureInvalid = {
        status: result.skillAvailability.status,
        reason: result.skillAvailability.reason ?? result.skillAvailability.status,
      };
      result.error = `infrastructure_invalid: ${result.infrastructureInvalid.reason}`;
      result.checks = [{
        name: "Skill infrastructure gate",
        pass: false,
        detail: `${result.infrastructureInvalid.status}: ${result.infrastructureInvalid.reason}`,
      }];
    } else {
      const allEvents = [];
      const turnRecords = [];
      for (const turn of scenario.turns) {
        const events = await driver.prompt(turn.prompt, { timeoutMs: turn.timeoutMs ?? 240000 });
        const toolCalls = extractToolCalls(events);
        const assistantTexts = extractAssistantTexts(events);
        allEvents.push(...events);
        turnRecords.push({ events, toolCalls, assistantTexts });
      }
      const toolCalls = extractToolCalls(allEvents);
      const assistantTexts = extractAssistantTexts(allEvents);
      const scored = await scenario.score({
        events: allEvents,
        toolCalls,
        assistantTexts,
        turnRecords,
        environmentMode,
        workspace,
      });
      result = {
        ...result,
        pass: scored.pass,
        checks: scored.checks,
        toolCalls: toolCalls.map((c) => ({
          name: c.name,
          args: c.args,
          completed: c.completed ?? false,
          isError: c.isError ?? false,
          resultPreview: (c.resultText ?? "").slice(0, 240),
        })),
        assistantPreview: (assistantTexts.at(-1) ?? "").slice(0, 400),
      };
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await driver.stop();
  }
  result.durationMs = Date.now() - started;

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
report.infrastructureInvalid = report.results.filter((r) => r.infrastructureInvalid).map((r) => ({
  id: r.id,
  ...r.infrastructureInvalid,
}));
report.skillAvailability = report.results.map((r) => ({
  id: r.id,
  availability: r.skillAvailability,
}));
report.status = report.infrastructureInvalid.length > 0 ? "infrastructure_invalid" : "completed";
writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));

console.log(`\n=== summary ===`);
console.log(`${report.passed}/${report.results.length} passed (${(report.passRate * 100).toFixed(0)}%)`);
console.log(`report: ${join(runDir, "report.json")}`);
process.exit(report.failed === 0 ? 0 : 1);
