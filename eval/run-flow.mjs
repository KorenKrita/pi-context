#!/usr/bin/env bun
// Run the standard long ACM activation flow, then LLM-judge it.
//
// Usage:
//   bun eval/run-flow.mjs [--model provider/id] [--thinking level] [--variant label]
//                         [--context-window N] [--judge-model provider/id]
//                         [--judge-thinking level] [--no-judge] [--extension path]
//                         [--skill path] [--environment-mode core-only|product-isolated|full-env]
//
// Two comparison axes both come from this one command:
//   • same models × different code/prompt versions — hold --model, change what
//     is checked out in the repo (or point --extension at a different build),
//     vary --variant to label the run;
//   • same prompt × different models — hold --variant, vary --model.
//
// Writes eval/.runs/<stamp>-flow-<model>/{report.json, transcript.txt, verdict.json}.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentDir,
  buildFullEnvAgentDir,
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  createRunDir,
  EXTENSION_PATH,
} from "./setup.mjs";
import { classifySkillAvailability, finalAssistantOutcome, normalizeEnvironmentMode, PiRpcDriver } from "./driver.mjs";
import { extractAssistantTranscript, extractToolCalls, extractTranscriptSegments } from "./scenarios.mjs";
import { getFlow, listFlows } from "./flow.mjs";
import { buildTranscript, JUDGE_MODEL, judgeRun, RUBRIC_VERSION } from "./judge.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function flag(name) {
  return process.argv.includes(name);
}
function parseModel(raw, dflt) {
  if (!raw) return dflt;
  const slash = raw.indexOf("/");
  return slash < 0
    ? { provider: "local-openai", modelId: raw }
    : { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

const modelSpec = parseModel(option("--model") ?? process.env.ACM_EVAL_MODEL, {
  provider: "local-openai",
  modelId: "mimo-v2.5",
});
const thinkingLevel = option("--thinking") ?? process.env.ACM_EVAL_THINKING ?? "off";
const variant = option("--variant") ?? process.env.ACM_EVAL_VARIANT ?? "HEAD";
const contextWindow = Number(option("--context-window") ?? 60000);
const shrink = !flag("--native"); // --native keeps the model's real window; the % nudge then rarely fires
const requestedEnvironmentMode = option("--environment-mode");
const fullEnvAlias = flag("--full-env");
if (requestedEnvironmentMode && fullEnvAlias && requestedEnvironmentMode !== "full-env") {
  throw new Error("--full-env conflicts with --environment-mode other than full-env");
}
const environmentMode = normalizeEnvironmentMode({
  environmentMode: requestedEnvironmentMode ?? (fullEnvAlias ? "full-env" : undefined),
});
const judgeModel = parseModel(option("--judge-model"), JUDGE_MODEL);
const judgeThinking = option("--judge-thinking") ?? "high";
const doJudge = !flag("--no-judge");
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
const timeoutScale = Number(option("--timeout-scale") ?? 1);
const flow = getFlow(option("--flow") ?? process.env.ACM_EVAL_FLOW ?? "exprlang-long-flow");
if (!flow) {
  throw new Error(`unknown --flow; known flows: ${listFlows().map((f) => f.id).join(", ")}`);
}

let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: join(extensionPath, "..", ".."), encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }

const fullEnv = environmentMode === "full-env";
const agentDir = fullEnv
  ? buildFullEnvAgentDir({ contextWindow, shrink, label: process.env.ACM_AGENT_LABEL })
  : buildAgentDir({ contextWindow, shrink, label: process.env.ACM_AGENT_LABEL });
const runDir = createRunDir(`flow-${modelSpec.modelId}`);
// full-env runs must NOT keep the workspace inside this repo: cwd-ancestry
// context-file discovery would find the repo's own AGENTS.md (the ACM design
// doc) and leak it into the tested agent's prompt.
const workspace = fullEnv ? mkdtempSync(join(tmpdir(), "acm-flow-ws-")) : join(runDir, "workspace");
cpSync(flow.seedDir, workspace, { recursive: true });

console.log(`flow=${flow.id} model=${modelSpec.provider}/${modelSpec.modelId} thinking=${thinkingLevel}`);
console.log(`variant=${variant} gitHead=${gitHead} context=${shrink ? contextWindow : "native"} environment=${environmentMode}`);
console.log(`run dir: ${runDir}`);

const driver = new PiRpcDriver({
  cwd: workspace,
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPaths,
  skillPaths,
  environmentMode,
  provider: modelSpec.provider,
  modelId: modelSpec.modelId,
  thinkingLevel,
  eventLogPath: join(runDir, "events.jsonl"),
});

const turnRecords = [];
let runError = null;
let commands = null;
let skillAvailability = null;
let infrastructureInvalid = null;
const started = Date.now();

driver.start();
try {
  try {
    commands = await driver.getCommands();
    skillAvailability = classifySkillAvailability({
      environmentMode,
      expectedSkillPath,
      commands,
      realpath: realpathSync,
    });
  } catch (error) {
    skillAvailability = classifySkillAvailability({
      environmentMode,
      expectedSkillPath,
      rpcError: error instanceof Error ? error.message : String(error),
      realpath: realpathSync,
    });
  }
  if (!skillAvailability.valid) {
    infrastructureInvalid = {
      status: skillAvailability.status,
      reason: skillAvailability.reason ?? skillAvailability.status,
    };
    console.log(`\n=== infrastructure invalid: ${infrastructureInvalid.status} ===`);
    console.log(`  ${infrastructureInvalid.reason}`);
  } else {
    for (const turn of flow.turns) {
      console.log(`\n=== ${turn.phase} ===`);
      const events = await driver.prompt(turn.prompt, { timeoutMs: Math.round((turn.timeoutMs ?? 300000) * timeoutScale) });
      const toolCalls = extractToolCalls(events);
      const assistantText = extractAssistantTranscript(events);
      const segments = extractTranscriptSegments(events);
      const outcome = finalAssistantOutcome(events);
      turnRecords.push({ phase: turn.phase, prompt: turn.prompt, toolCalls, assistantText, segments, ...outcome });
      const acm = toolCalls.filter((c) => c.name.startsWith("acm_"));
      console.log(`  tools: ${toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
      if (acm.length) console.log(`  ACM: ${acm.map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(", ")}`);
    }
  }
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  console.log(`  run error: ${runError}`);
} finally {
  await driver.stop();
}

const report = {
  status: infrastructureInvalid ? "infrastructure_invalid" : runError ? "run_error" : "completed",
  flowId: flow.id,
  rubricVersion: RUBRIC_VERSION,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  model: modelSpec,
  thinkingLevel,
  variant,
  gitHead,
  contextWindow,
  shrink,
  fullEnv,
  environmentMode,
  extensionPaths,
  skillPaths,
  expectedSkillPath,
  commands,
  skillAvailability,
  infrastructureInvalid,
  runError,
  workspace, // full-env runs live outside the repo; kept for post-hoc inspection
  turns: turnRecords.map((t) => ({
    phase: t.phase,
    toolCallCount: t.toolCalls.length,
    acmCalls: t.toolCalls
      .filter((c) => c.name.startsWith("acm_"))
      .map((c) => ({
        name: c.name,
        completed: c.completed ?? false,
        isError: c.isError ?? false,
        domainError: c.details?.error ?? null,
        args: c.args,
      })),
    assistantPreview: t.assistantText.slice(0, 300),
    stopReason: t.stopReason,
    errorMessage: t.errorMessage,
  })),
};

// Build + persist the human-readable transcript regardless of judging.
const transcript = buildTranscript(turnRecords);
writeFileSync(join(runDir, "transcript.txt"), transcript);

if (!infrastructureInvalid && !runError && doJudge) {
  console.log(`\n=== judging with ${judgeModel.provider}/${judgeModel.modelId} (thinking=${judgeThinking}) ===`);
  const judgeAgentDir = buildAgentDir({ shrink: false, label: process.env.ACM_JUDGE_LABEL ?? "agent-judge" });
  const judgeSessions = join(runDir, "judge-sessions");
  const judgeWorkspace = join(runDir, "judge-workspace");
  mkdirSync(judgeSessions, { recursive: true });
  mkdirSync(judgeWorkspace, { recursive: true });
  try {
    const result = await judgeRun({
      turnRecords,
      opportunities: flow.turns.map((t) => ({ phase: t.phase, intent: t.intent })),
      taskCompletionDesc: flow.taskCompletionDesc,
      judgeAgentDir,
      sessionDir: judgeSessions,
      cwd: judgeWorkspace,
      model: judgeModel,
      thinkingLevel: judgeThinking,
    });
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(result, null, 2));
    report.judge = result.ok
      ? { model: judgeModel, verdict: result.verdict }
      : { model: judgeModel, error: result.error, raw: result.raw };
    if (result.ok) {
      const v = result.verdict;
      console.log(`\n=== verdict (${RUBRIC_VERSION}) ===`);
      for (const [dim, d] of Object.entries(v.dimensions ?? {})) {
        console.log(`  ${dim}: ${d.score}/3 [${d.attribution}] ${d.note ?? ""}`);
      }
      console.log(`  overall: ${v.overall?.score}/3 tier=${v.overall?.modelTier}`);
      console.log(`  topAttributions: ${(v.topAttributions ?? []).join(", ")}`);
      console.log(`  summary: ${v.overall?.summary ?? ""}`);
    } else {
      console.log(`  judge parse failed: ${result.error}`);
    }
  } catch (error) {
    report.judge = { model: judgeModel, error: error instanceof Error ? error.message : String(error) };
    console.log(`  judge error: ${report.judge.error}`);
  }
} else {
  report.judge = infrastructureInvalid
    ? { skipped: true, reason: "infrastructure_invalid" }
    : runError
      ? { skipped: true, reason: "run_error" }
    : { skipped: true };
}

writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(runDir, "report.json")}`);
console.log(`transcript: ${join(runDir, "transcript.txt")}`);
process.exit(runError || infrastructureInvalid ? 1 : 0);
