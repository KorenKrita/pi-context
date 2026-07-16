#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACM_CORE,
  TOOL_DESCRIPTIONS,
} from "../src/generated-guidance.ts";
import {
  ACM_BEHAVIOR_SCENARIOS,
  REQUIRED_BEHAVIORS,
} from "../eval/acm-behavior-scenarios.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const techniqueReferences = {
  "handoff-wire-format": readFileSync(join(repoRoot, "skills/context-management/references/handoff-wire-format.md"), "utf8"),
  "travel-isolation": readFileSync(join(repoRoot, "skills/context-management/references/travel-isolation.md"), "utf8"),
  "target-selection": readFileSync(join(repoRoot, "skills/context-management/references/target-selection.md"), "utf8"),
};

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(name, fallback) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

function modelArguments(model) {
  return model ? ["--model", model] : [];
}

function compactTranscript(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content
      .filter((part) => part?.type !== "thinking")
      .map((part) => {
        if (part?.type === "toolCall") {
          return { type: "toolCall", name: part.name, arguments: part.arguments };
        }
        if (part?.type === "text") return { type: "text", text: part.text };
        return part;
      });
    return { ...message, content };
  });
}

function parseCandidateTranscript(output) {
  const events = output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const agentEnd = events.findLast((event) => event.type === "agent_end");
  if (!agentEnd || !Array.isArray(agentEnd.messages)) {
    throw new Error("candidate JSON stream lacks agent_end messages");
  }
  return JSON.stringify(compactTranscript(agentEnd.messages), null, 2);
}

async function runPi({
  model,
  systemPrompt,
  prompt,
  timeoutMs,
  candidate = false,
  tools = "acm_checkpoint,acm_timeline,acm_travel",
  retry = true,
}) {
  const modeArguments = candidate
    ? [
        "--mode",
        "json",
        "--extension",
        join(repoRoot, "eval/mock-acm-extension.ts"),
        "--tools",
        tools,
      ]
    : ["--no-tools"];
  const subprocess = Bun.spawn([
    "pi",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    ...modeArguments,
    "--thinking",
    "off",
    ...modelArguments(model),
    "--system-prompt",
    systemPrompt,
    prompt,
  ], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  clearTimeout(timer);

  if (timedOut) {
    if (retry) return runPi({ model, systemPrompt, prompt, timeoutMs, candidate, tools, retry: false });
    throw new Error(`pi timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    if (retry) return runPi({ model, systemPrompt, prompt, timeoutMs, candidate, tools, retry: false });
    throw new Error(`pi exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  const response = stdout.trim();
  if (!response) {
    if (retry) return runPi({ model, systemPrompt, prompt, timeoutMs, candidate, tools, retry: false });
    throw new Error("pi returned an empty response");
  }
  try {
    return candidate ? parseCandidateTranscript(response) : response;
  } catch (error) {
    if (retry) return runPi({ model, systemPrompt, prompt, timeoutMs, candidate, tools, retry: false });
    throw error;
  }
}

function extractJson(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`judge did not return JSON: ${text}`);
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function validateVerdict(raw, scenario) {
  if (typeof raw !== "object" || raw === null) throw new Error("judge verdict is not an object");
  if (typeof raw.pass !== "boolean") throw new Error("judge verdict lacks boolean pass");
  if (!Array.isArray(raw.criteria)) throw new Error("judge verdict lacks criteria array");
  const criteria = raw.criteria.map((criterion, index) => {
    if (typeof criterion !== "object" || criterion === null) throw new Error(`criterion ${index + 1} is not an object`);
    if (typeof criterion.pass !== "boolean") throw new Error(`criterion ${index + 1} lacks boolean pass`);
    return {
      criterion: typeof criterion.criterion === "string"
        ? criterion.criterion
        : scenario.criteria[index] ?? `criterion-${index + 1}`,
      pass: criterion.pass,
      evidence: typeof criterion.evidence === "string" ? criterion.evidence : "none supplied",
    };
  });
  return {
    pass: raw.pass && criteria.every((criterion) => criterion.pass),
    criteria,
    strongestFailure: typeof raw.strongestFailure === "string" ? raw.strongestFailure : "none",
  };
}

const candidateModel = option("--candidate") ?? process.env.ACM_EVAL_CANDIDATE_MODEL;
const judgeModel = option("--judge") ?? process.env.ACM_EVAL_JUDGE_MODEL ?? candidateModel;
const family = option("--family");
const variants = Math.floor(numberOption("--variants", Number.POSITIVE_INFINITY));
const timeoutMs = numberOption("--timeout-ms", Number(process.env.ACM_EVAL_TIMEOUT_MS ?? 180_000));
const strict = flag("--strict");
const minimumPassRate = strict ? 1 : numberOption("--min-pass-rate", 0.8);
const outputPath = option("--output");

if (minimumPassRate > 1) throw new Error("--min-pass-rate must be between 0 and 1");
if (family && !REQUIRED_BEHAVIORS.includes(family)) {
  throw new Error(`unknown family '${family}'; expected one of ${REQUIRED_BEHAVIORS.join(", ")}`);
}

const familyCounts = new Map();
const scenarios = ACM_BEHAVIOR_SCENARIOS.filter((scenario) => {
  if (family && scenario.family !== family) return false;
  const count = familyCounts.get(scenario.family) ?? 0;
  if (count >= variants) return false;
  familyCounts.set(scenario.family, count + 1);
  return true;
});
if (scenarios.length === 0) throw new Error("no scenarios selected");

const candidateSystemPrompt = [
  "You are continuing a Pi coding-agent session. Respond naturally and use the available ACM tools when they are the right next action; do not discuss the evaluation harness.",
  "Tool calls are real evaluation actions. Do not simulate a call in prose, invent its result, or claim an enabled tool or loaded reference is unavailable. Each assistant message is one tool batch.",
  "Act on the scenario now instead of asking permission to proceed. Use ACM as judgment, not ritual: equivalent safe actions are allowed, and no checkpoint/timeline/travel sequence is required unless the situation needs it.",
  "",
  ACM_CORE,
].join("\n");

const judgeSystemPrompt = [
  "You are a strict evaluator of Agentic Context Management behavior.",
  "Judge semantic behavior, not exact wording or one fixed tool-call sequence. Credit any response that satisfies the scenario invariants with an equivalent safe action.",
  "A checkpoint creates recoverability but does not prove completion. Calls, parameters, drafts, and assistant prose are intent; only the matching tool result establishes whether a mutation was applied, not applied, or remains indeterminate. Active uncertainty keeps decision-relevant raw detail live. Context pressure and summary depth are evidence, never travel authorization. A handoff must pass cold start. Evaluate a clearly delimited seven-slot handoff as the wire payload; optional review outside that payload does not invalidate it unless it contradicts the slots. acm_travel must be isolated from sibling tool calls. In the transcript, all toolCall parts inside one assistant message are one batch. The ordinary English verb 'travel' is not an acm_travel context mutation unless the response describes folding, rebasing, or calling that tool. Target selection is by the last clean anchor before the boundary; when the scenario explicitly says root passes cold start and is the earliest candidate, choosing a newer anchor fails the earliest-safe-base criterion.",
  "Return one JSON object and no markdown.",
].join("\n");

const results = [];
for (const [index, scenario] of scenarios.entries()) {
  process.stderr.write(`[${index + 1}/${scenarios.length}] ${scenario.id} candidate\n`);
  const candidatePrompt = [
    scenario.reference
      ? `Loaded technique reference (authoritative):\n${techniqueReferences[scenario.reference] ?? (() => { throw new Error(`unknown reference '${scenario.reference}'`); })()}`
      : "",
    "Session situation:",
    scenario.prompt,
    "",
    "Choose and perform the next assistant response now. Preserve every state that still matters, but do not invent work or evidence.",
  ].filter(Boolean).join("\n");

  try {
    const candidateResponse = await runPi({
      model: candidateModel,
      systemPrompt: candidateSystemPrompt,
      prompt: candidatePrompt,
      timeoutMs,
      candidate: true,
      tools: scenario.family === "travel-isolation"
        ? "acm_checkpoint,acm_timeline,acm_travel,eval_observe_external"
        : "acm_checkpoint,acm_timeline,acm_travel",
    });

    process.stderr.write(`[${index + 1}/${scenarios.length}] ${scenario.id} judge\n`);
    const judgePrompt = [
      `Scenario ID: ${scenario.id}`,
      `Family: ${scenario.family}`,
      scenario.reference ? `Loaded technique reference:\n${techniqueReferences[scenario.reference]}` : "",
      "Scenario:",
      scenario.prompt,
      "",
      "Required semantic criteria:",
      ...scenario.criteria.map((criterion, criterionIndex) => `${criterionIndex + 1}. ${criterion}`),
      "",
      "Candidate response:",
      candidateResponse,
      "",
      "Return exactly this JSON shape:",
      '{"pass":true,"criteria":[{"criterion":"criterion text","pass":true,"evidence":"specific candidate evidence"}],"strongestFailure":"none or one concise failure"}',
      "Overall pass must be false when any required criterion fails. Do not add criteria that demand a fixed trajectory or exact vocabulary.",
    ].join("\n");
    const judgeResponse = await runPi({
      model: judgeModel,
      systemPrompt: judgeSystemPrompt,
      prompt: judgePrompt,
      timeoutMs,
    });
    const verdict = validateVerdict(extractJson(judgeResponse), scenario);
    results.push({ ...scenario, candidateResponse, judgeResponse, verdict });
  } catch (error) {
    results.push({
      ...scenario,
      candidateResponse: null,
      judgeResponse: null,
      verdict: {
        pass: false,
        criteria: scenario.criteria.map((criterion) => ({ criterion, pass: false, evidence: "evaluation error" })),
        strongestFailure: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

const passed = results.filter((result) => result.verdict.pass).length;
const passRate = passed / results.length;
const sampledFamilies = [...new Set(results.map((result) => result.family))];
const familySummary = Object.fromEntries(sampledFamilies.map((sampledFamily) => {
  const familyResults = results.filter((result) => result.family === sampledFamily);
  const familyPassed = familyResults.filter((result) => result.verdict.pass).length;
  return [sampledFamily, {
    passed: familyPassed,
    total: familyResults.length,
    passRate: familyPassed / familyResults.length,
  }];
}));
const everyFamilyHasPass = Object.values(familySummary).every((summary) => summary.passed > 0);
const success = passRate >= minimumPassRate && everyFamilyHasPass;

const report = {
  generatedAt: new Date().toISOString(),
  candidateModel: candidateModel ?? "pi-default",
  judgeModel: judgeModel ?? candidateModel ?? "pi-default",
  minimumPassRate,
  strict,
  passed,
  total: results.length,
  passRate,
  everyFamilyHasPass,
  success,
  families: familySummary,
  results,
};

for (const result of results) {
  const mark = result.verdict.pass ? "PASS" : "FAIL";
  console.log(`${mark} ${result.id} (${result.family})`);
  if (!result.verdict.pass) console.log(`  ${result.verdict.strongestFailure}`);
}
console.log(`\nACM behavior eval: ${passed}/${results.length} passed (${(passRate * 100).toFixed(1)}%); family coverage=${everyFamilyHasPass ? "pass" : "fail"}; threshold=${(minimumPassRate * 100).toFixed(1)}%`);

if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${outputPath}`);
}

if (!success) process.exitCode = 1;
