#!/usr/bin/env bun
// Run the standard long ACM activation flow, then LLM-judge it.
//
// Usage:
//   bun eval/run-flow.mjs [--model provider/id] [--thinking level] [--variant label]
//                         [--context-window N] [--judge-model provider/id]
//                         [--judge-thinking level] [--no-judge] [--extension path]
//
// Two comparison axes both come from this one command:
//   • same models × different code/prompt versions — hold --model, change what
//     is checked out in the repo (or point --extension at a different build),
//     vary --variant to label the run;
//   • same prompt × different models — hold --variant, vary --model.
//
// Writes eval/.runs/<stamp>-flow-<model>/{report.json, transcript.txt, verdict.json}.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentDir, createRunDir, EXTENSION_PATH } from "./setup.mjs";
import { PiRpcDriver } from "./driver.mjs";
import { extractAssistantTexts, extractToolCalls } from "./scenarios.mjs";
import { LONG_FLOW } from "./flow.mjs";
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
const judgeModel = parseModel(option("--judge-model"), JUDGE_MODEL);
const judgeThinking = option("--judge-thinking") ?? "high";
const doJudge = !flag("--no-judge");
const extensionPath = option("--extension") ?? EXTENSION_PATH;
const timeoutScale = Number(option("--timeout-scale") ?? 1);

let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: join(extensionPath, "..", ".."), encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }

const agentDir = buildAgentDir({ contextWindow, label: process.env.ACM_AGENT_LABEL });
const runDir = createRunDir(`flow-${modelSpec.modelId}`);
const workspace = join(runDir, "workspace");
cpSync(LONG_FLOW.seedDir, workspace, { recursive: true });

console.log(`flow=${LONG_FLOW.id} model=${modelSpec.provider}/${modelSpec.modelId} thinking=${thinkingLevel}`);
console.log(`variant=${variant} gitHead=${gitHead} contextWindow=${contextWindow}`);
console.log(`run dir: ${runDir}`);

const driver = new PiRpcDriver({
  cwd: workspace,
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPath,
  provider: modelSpec.provider,
  modelId: modelSpec.modelId,
  thinkingLevel,
  eventLogPath: join(runDir, "events.jsonl"),
});

const turnRecords = [];
let runError = null;
const started = Date.now();

driver.start();
try {
  for (const turn of LONG_FLOW.turns) {
    console.log(`\n=== ${turn.phase} ===`);
    const events = await driver.prompt(turn.prompt, { timeoutMs: Math.round((turn.timeoutMs ?? 300000) * timeoutScale) });
    const toolCalls = extractToolCalls(events);
    const assistantText = extractAssistantTexts(events).at(-1) ?? "";
    turnRecords.push({ phase: turn.phase, prompt: turn.prompt, toolCalls, assistantText });
    const acm = toolCalls.filter((c) => c.name.startsWith("acm_"));
    console.log(`  tools: ${toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
    if (acm.length) console.log(`  ACM: ${acm.map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(", ")}`);
  }
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  console.log(`  run error: ${runError}`);
} finally {
  await driver.stop();
}

const report = {
  flowId: LONG_FLOW.id,
  rubricVersion: RUBRIC_VERSION,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  model: modelSpec,
  thinkingLevel,
  variant,
  gitHead,
  contextWindow,
  runError,
  turns: turnRecords.map((t) => ({
    phase: t.phase,
    toolCallCount: t.toolCalls.length,
    acmCalls: t.toolCalls
      .filter((c) => c.name.startsWith("acm_"))
      .map((c) => ({ name: c.name, isError: c.isError ?? false, args: c.args })),
    assistantPreview: t.assistantText.slice(0, 300),
  })),
};

// Build + persist the human-readable transcript regardless of judging.
const transcript = buildTranscript(turnRecords);
writeFileSync(join(runDir, "transcript.txt"), transcript);

if (doJudge) {
  console.log(`\n=== judging with ${judgeModel.provider}/${judgeModel.modelId} (thinking=${judgeThinking}) ===`);
  const judgeAgentDir = buildAgentDir({ shrink: false, label: process.env.ACM_JUDGE_LABEL ?? "agent-judge" });
  const judgeSessions = join(runDir, "judge-sessions");
  const judgeWorkspace = join(runDir, "judge-workspace");
  mkdirSync(judgeSessions, { recursive: true });
  mkdirSync(judgeWorkspace, { recursive: true });
  try {
    const result = await judgeRun({
      turnRecords,
      opportunities: LONG_FLOW.turns.map((t) => ({ phase: t.phase, intent: t.intent })),
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
  report.judge = { skipped: true };
}

writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(runDir, "report.json")}`);
console.log(`transcript: ${join(runDir, "transcript.txt")}`);
process.exit(runError ? 1 : 0);
