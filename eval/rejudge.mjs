// Re-judge a completed flow run from its persisted transcript.txt.
//
// Usage:
//   bun eval/rejudge.mjs <runDir> [<runDir>...] [--flow id] [--judge-model provider/id]
//                        [--judge-thinking level] [--timeout-ms N]
//
// run-flow.mjs only judges at run time; when the judge reply fails syntax or
// schema validation, the transcript is already on disk but there is no way to
// retry without re-running the whole (expensive) flow. This script rebuilds
// the exact judge prompt from transcript.txt + the flow definition and updates
// verdict.json and report.json in place.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFlow, listFlows } from "./flow.mjs";
import { JUDGE_MODEL, judgeTranscript, writeJsonAtomically } from "./judge.mjs";
import { buildAgentDir } from "./setup.mjs";

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const runDirs = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);

const flowId = option("--flow") ?? "exprlang-xl-flow";
const flow = getFlow(flowId);
if (!flow) {
  throw new Error(`unknown --flow; known flows: ${listFlows().map((f) => f.id).join(", ")}`);
}
const judgeModel = (() => {
  const raw = option("--judge-model");
  if (!raw) return JUDGE_MODEL;
  const [provider, ...rest] = raw.split("/");
  return { provider, modelId: rest.join("/") };
})();
const judgeThinking = option("--judge-thinking") ?? "high";
const timeoutMs = Number(option("--timeout-ms") ?? 300000);

if (!runDirs.length) {
  console.error("usage: bun eval/rejudge.mjs <runDir>... [--flow id] [--judge-model p/id] [--judge-thinking level]");
  process.exit(1);
}

for (const runDir of runDirs) {
  const transcript = readFileSync(join(runDir, "transcript.txt"), "utf8");
  const reportPath = join(runDir, "report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  const judgeAgentDir = buildAgentDir({ shrink: false, label: process.env.ACM_JUDGE_LABEL ?? "agent-judge" });
  const judgeSessions = join(runDir, "judge-sessions");
  const judgeWorkspace = join(runDir, "judge-workspace");
  mkdirSync(judgeSessions, { recursive: true });
  mkdirSync(judgeWorkspace, { recursive: true });

  console.log(`=== rejudging ${runDir} with ${judgeModel.provider}/${judgeModel.modelId} (thinking=${judgeThinking}) ===`);
  const result = await judgeTranscript({
    transcript,
    opportunities: flow.turns.map((turn) => ({ phase: turn.phase, intent: turn.intent })),
    taskCompletionDesc: flow.taskCompletionDesc,
    judgeAgentDir,
    sessionDir: judgeSessions,
    cwd: judgeWorkspace,
    model: judgeModel,
    thinkingLevel: judgeThinking,
    timeoutMs,
  });
  writeJsonAtomically(join(runDir, "verdict.json"), result);
  report.rubricVersion = result.rubricVersion;
  report.judge = result.ok
    ? { model: judgeModel, rubricVersion: result.rubricVersion, attempts: result.attempts, verdict: result.verdict }
    : { model: judgeModel, rubricVersion: result.rubricVersion, attempts: result.attempts, error: result.error, errors: result.errors, raw: result.raw };
  writeJsonAtomically(reportPath, report);

  if (result.ok) {
    const v = result.verdict;
    console.log(`  overall: ${v.overall?.score}/3 tier=${v.overall?.modelTier}  attrs: ${(v.topAttributions ?? []).join(", ")}`);
  } else {
    console.log(`  judge invalid after ${result.attempts.length} attempts: ${result.error} (full attempts in verdict.json)`);
  }
}
