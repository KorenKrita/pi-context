// Re-judge a completed flow run from its persisted transcript.txt.
//
// Usage:
//   bun eval/rejudge.mjs <runDir> [<runDir>...] [--flow id] [--judge-model provider/id]
//                        [--judge-thinking level] [--timeout-ms N]
//
// run-flow.mjs only judges at run time; when the judge reply fails to parse,
// the transcript is already on disk but there is no way to retry without
// re-running the whole (expensive) flow. This script rebuilds the exact judge
// prompt from transcript.txt + the flow definition and updates verdict.json
// and report.json in place.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiRpcDriver } from "./driver.mjs";
import { getFlow, listFlows } from "./flow.mjs";
import { buildJudgePrompt, JUDGE_MODEL, parseVerdict, RUBRIC_VERSION } from "./judge.mjs";
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
  const prompt = buildJudgePrompt({
    opportunities: flow.turns.map((t) => ({ phase: t.phase, intent: t.intent })),
    transcript,
    taskCompletionDesc: flow.taskCompletionDesc,
  });

  const judgeAgentDir = buildAgentDir({ shrink: false, label: process.env.ACM_JUDGE_LABEL ?? "agent-judge" });
  const judgeSessions = join(runDir, "judge-sessions");
  const judgeWorkspace = join(runDir, "judge-workspace");
  mkdirSync(judgeSessions, { recursive: true });
  mkdirSync(judgeWorkspace, { recursive: true });

  const driver = new PiRpcDriver({
    cwd: judgeWorkspace,
    agentDir: judgeAgentDir,
    sessionDir: judgeSessions,
    provider: judgeModel.provider,
    modelId: judgeModel.modelId,
    thinkingLevel: judgeThinking,
  });

  console.log(`=== rejudging ${runDir} with ${judgeModel.provider}/${judgeModel.modelId} (thinking=${judgeThinking}) ===`);
  driver.start();
  try {
    const events = await driver.prompt(prompt, { timeoutMs });
    const texts = events
      .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
      .map((e) => (e.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""))
      .filter(Boolean);
    const raw = texts.at(-1) ?? "";
    const parsed = parseVerdict(raw);
    const result = { raw, ...parsed, judgeModel, rubricVersion: RUBRIC_VERSION };
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(result, null, 2));

    const reportPath = join(runDir, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.judge = parsed.ok
      ? { model: judgeModel, verdict: parsed.verdict }
      : { model: judgeModel, error: parsed.error, raw };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (parsed.ok) {
      const v = parsed.verdict;
      console.log(`  overall: ${v.overall?.score}/3 tier=${v.overall?.modelTier}  attrs: ${(v.topAttributions ?? []).join(", ")}`);
    } else {
      console.log(`  judge parse failed again: ${parsed.error} (full raw in verdict.json)`);
    }
  } finally {
    await driver.stop();
  }
}
