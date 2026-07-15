#!/usr/bin/env bun

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = option("--model", "local-openai/deepseek-v4-flash");
const thinking = option("--thinking", "max");
const piBin = option("--pi", "pi");
const runs = Number.parseInt(option("--runs", "1"), 10);
const scenarioFilter = option("--scenario", "all");
const outputRoot = resolve(option(
  "--output",
  join(tmpdir(), `pi-context-behavior-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
));
const strict = process.argv.includes("--strict");

if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const scenarios = [
  {
    id: "direct-text",
    turns: ["What is 2 + 2? Reply with only the number."],
    check(result) {
      return [check("text-only exemption", result.turns[0].tools.length === 0, result.turns[0].tools)];
    },
  },
  {
    id: "managed-planning",
    turns: ["Make a concise three-step plan for renaming a module safely. Do not inspect files; base it on this request alone."],
    check(result) {
      const turn = result.turns[0];
      const firstBatch = turn.batches[0]?.calls.map((call) => call.name) ?? [];
      const names = checkpointNamesFor(turn);
      return [
        check("checkpoint is first tool", turn.tools[0] === "acm_checkpoint", turn.tools),
        check("checkpoint result is awaited", firstBatch.length === 1 && firstBatch[0] === "acm_checkpoint", firstBatch),
        check("completion boundary recorded", names.some((name) => name.endsWith("-done")), names),
      ];
    },
  },
  {
    id: "managed-bash",
    turns: ["Use bash to print the current working directory, then report it to me."],
    check(result) {
      return managedTurnChecks(result.turns[0], "bash");
    },
  },
  {
    id: "managed-read",
    files: { "note.txt": "alpha\nbeta\ngamma\n" },
    turns: ["Read note.txt and tell me how many lines it contains."],
    check(result) {
      return managedTurnChecks(result.turns[0], "read");
    },
  },
  {
    id: "new-goal",
    files: { "note.txt": "one\ntwo\n" },
    turns: [
      "Use bash to print the current working directory, then report it.",
      "New task: read note.txt and tell me how many lines it has.",
    ],
    check(result) {
      return [
        ...managedTurnChecks(result.turns[0], "bash").map(prefixCheck("turn 1")),
        ...managedTurnChecks(result.turns[1], "read").map(prefixCheck("turn 2")),
      ];
    },
  },
  {
    id: "phase-boundary",
    files: {
      "note.txt": "alpha\nbeta\n",
      "config.txt": "alpha=on\nbeta=off\n",
    },
    turns: [
      "Work in two explicit phases. Phase 1: read note.txt and summarize it. Phase 2: read config.txt and compare it with note.txt. Then report.",
    ],
    check(result) {
      const turn = result.turns[0];
      const names = checkpointNamesFor(turn);
      const startNames = names.filter((name) => name.endsWith("-start"));
      return [
        ...managedTurnChecks(turn, "read"),
        check("both files are read", turn.tools.filter((name) => name === "read").length >= 2, turn.tools),
        check("phase boundary is checkpointed", startNames.length >= 2, startNames),
      ];
    },
  },
  {
    id: "advanced-target-skill",
    turns: [
      "An ACM rebase trigger and fold boundary are already known, but candidate chronology is ambiguous because multiple fronts are interleaved. Inspect the applicable local skill guidance and explain the target-selection procedure. Do not perform travel.",
    ],
    check(result) {
      const turn = result.turns[0];
      const paths = readPathsFor(turn);
      return [
        ...managedTurnChecks(turn, "read"),
        check("skill router is loaded", paths.some((path) => path.endsWith("/skills/context-management/SKILL.md")), paths),
        check("target reference is loaded", paths.some((path) => path.endsWith("/references/target-selection.md")), paths),
        check("travel is not performed", !turn.tools.includes("acm_travel"), turn.tools),
      ];
    },
  },
  {
    id: "advanced-archive-skill",
    turns: [
      "The summary branch is authoritative, but one exact detail must be recovered from an off-path raw branch before ordinary work resumes. Inspect the applicable local skill guidance and explain the recovery sequence. Do not perform travel.",
    ],
    check(result) {
      const turn = result.turns[0];
      const paths = readPathsFor(turn);
      return [
        ...managedTurnChecks(turn, "read"),
        check("skill router is loaded", paths.some((path) => path.endsWith("/skills/context-management/SKILL.md")), paths),
        check("archive reference is loaded", paths.some((path) => path.endsWith("/references/archive-recovery.md")), paths),
        check("travel is not performed", !turn.tools.includes("acm_travel"), turn.tools),
      ];
    },
  },
  {
    id: "distilled-fold",
    files: { "note.txt": "alpha: enabled\nbeta: disabled\ngamma: enabled\n" },
    turns: [
      "Inspect note.txt, determine which entries are enabled, and once your findings are distilled use ACM to fold the raw investigation safely before giving the final answer.",
    ],
    check(result) {
      const turn = result.turns[0];
      const travelBatches = turn.batches.filter((batch) => batch.calls.some((call) => call.name === "acm_travel"));
      const travelCalls = travelBatches.flatMap((batch) => batch.calls.filter((call) => call.name === "acm_travel"));
      const taskEndTravel = travelCalls[0];
      const taskEndSummary = taskEndTravel?.arguments?.summary ?? "";
      const taskEndNext = taskEndSummary.split(/\r?\n/).find((line) => line.startsWith("NEXT:")) ?? "";
      const timelineIndex = turn.tools.indexOf("acm_timeline");
      const travelIndex = turn.tools.indexOf("acm_travel");
      const finalText = turn.finalText.trim();
      return [
        ...managedTurnChecks(turn, "read"),
        check("timeline before travel", timelineIndex >= 0 && travelIndex > timelineIndex, turn.tools),
        check(
          "travel is isolated",
          travelBatches.length > 0 && travelBatches.every((batch) => batch.calls.length === 1),
          travelBatches.map((batch) => batch.calls.map((call) => call.name)),
        ),
        check("exactly one task-end travel", travelCalls.length === 1, travelCalls.length),
        check(
          "task-end travel uses -done backup",
          typeof taskEndTravel?.arguments?.backupCurrentHeadAs === "string"
            && taskEndTravel.arguments.backupCurrentHeadAs.endsWith("-done"),
          taskEndTravel?.arguments?.backupCurrentHeadAs,
        ),
        check("task-end NEXT is final answer", /^NEXT:\s*(answer|report|deliver|present)\b/i.test(taskEndNext), taskEndNext),
        check("task-end travel is final tool", travelIndex >= 0 && travelIndex === turn.tools.length - 1, turn.tools),
        check("travel succeeds", turn.travelResults.length === 1 && turn.travelResults[0]?.success, turn.travelResults),
        check(
          "final answer reports enabled entries",
          /\balpha\b/i.test(finalText) && /\bgamma\b/i.test(finalText)
            && !/^acm_(?:checkpoint|timeline|travel)$/i.test(finalText),
          finalText,
        ),
      ];
    }
  },
  {
    id: "fold-then-rebase",
    files: {
      "note.txt": "alpha: enabled\nbeta: disabled\ngamma: enabled\n",
      "next.txt": "delta\nepsilon\n",
    },
    turns: [
      "Inspect note.txt, determine which entries are enabled, and once your findings are distilled use ACM to fold the raw investigation safely before giving the final answer.",
      "New task: read next.txt and report its entries. Before starting it, apply the required rebase check and rebase if every gate passes.",
    ],
    check(result) {
      const first = result.turns[0];
      const second = result.turns[1];
      const firstTimeline = first.tools.indexOf("acm_timeline");
      const firstTravel = first.tools.indexOf("acm_travel");
      const secondTravelBatches = second.batches.filter((batch) => batch.calls.some((call) => call.name === "acm_travel"));
      const checkpointIndex = second.tools.indexOf("acm_checkpoint");
      const readIndex = second.tools.indexOf("read");
      const names = checkpointNamesFor(second);
      return [
        check("turn 1 checkpoint is first", first.tools[0] === "acm_checkpoint", first.tools),
        check("turn 1 timeline precedes travel", firstTimeline >= 0 && firstTravel > firstTimeline, first.tools),
        check("turn 1 travel succeeds", first.travelResults.some((item) => item.success), first.travelResults),
        check("turn 2 rebase check is first", second.tools[0] === "acm_timeline", second.tools),
        check("turn 2 rebase succeeds", second.travelResults.some((item) => item.success), second.travelResults),
        check(
          "turn 2 travel is isolated",
          secondTravelBatches.length > 0 && secondTravelBatches.every((batch) => batch.calls.length === 1),
          secondTravelBatches.map((batch) => batch.calls.map((call) => call.name)),
        ),
        check("turn 2 checkpoint precedes read", checkpointIndex > second.tools.indexOf("acm_travel") && readIndex > checkpointIndex, second.tools),
        check("turn 2 completion boundary recorded", names.some((name) => name.endsWith("-done")), names),
      ];
    },
  },
];

function check(name, passed, observed) {
  return { name, passed, observed };
}

function prefixCheck(prefix) {
  return (item) => ({ ...item, name: `${prefix} ${item.name}` });
}

function checkpointNamesFor(turn) {
  return turn.batches
    .flatMap((batch) => batch.calls)
    .filter((call) => call.name === "acm_checkpoint")
    .map((call) => call.arguments?.name)
    .filter((name) => typeof name === "string");
}

function readPathsFor(turn) {
  return turn.batches
    .flatMap((batch) => batch.calls)
    .filter((call) => call.name === "read")
    .map((call) => call.arguments?.path)
    .filter((path) => typeof path === "string");
}

function managedTurnChecks(turn, managedTool) {
  const checkpointIndex = turn.tools.indexOf("acm_checkpoint");
  const managedIndex = turn.tools.indexOf(managedTool);
  const firstBatch = turn.batches[0]?.calls.map((call) => call.name) ?? [];
  const checkpointNames = checkpointNamesFor(turn);
  return [
    check("checkpoint is first tool", turn.tools[0] === "acm_checkpoint", turn.tools),
    check("checkpoint result is awaited", firstBatch.length === 1 && firstBatch[0] === "acm_checkpoint", firstBatch),
    check(
      `${managedTool} follows checkpoint`,
      checkpointIndex >= 0 && managedIndex > checkpointIndex,
      turn.tools,
    ),
    check(
      "completion boundary recorded",
      checkpointNames.some((name) => name.endsWith("-done")) || turn.travelResults.some((item) => item.success),
      checkpointNames,
    ),
  ];
}

async function findSessionFile(sessionDir) {
  const entries = await readdir(sessionDir, { withFileTypes: true });
  const file = entries.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (!file) throw new Error(`No session JSONL created in ${sessionDir}`);
  return join(sessionDir, file.name);
}

function parseEvents(stdout) {
  const batches = [];
  const tools = [];
  const travelResults = [];
  let finalText = "";

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const calls = (event.message.content ?? [])
        .filter((item) => item.type === "toolCall")
        .map((item) => ({ name: item.name, arguments: item.arguments ?? {} }));
      if (calls.length > 0) batches.push({ calls });
      const text = (event.message.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (text) finalText = text;
    }

    if (event.type === "tool_execution_start") tools.push(event.toolName);
    if (event.type === "tool_execution_end" && event.toolName === "acm_travel") {
      travelResults.push({ success: !event.isError, result: event.result });
    }
  }

  return { batches, tools, travelResults, finalText };
}

async function runTurn({ workspace, sessionDir, sessionFile, prompt, outputFile }) {
  const args = [
    "--no-extensions",
    "--extension", join(repoRoot, "src", "index.ts"),
    "--extension", join(repoRoot, "src", "context.ts"),
    "--no-skills",
    "--skill", join(repoRoot, "skills"),
    "--no-context-files",
    "--session-dir", sessionDir,
    "--model", model,
    "--thinking", thinking,
    "--mode", "json",
    "--print",
  ];
  if (sessionFile) args.push("--session", sessionFile);
  args.push(prompt);

  const child = Bun.spawn([piBin, ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await writeFile(outputFile, stdout);
  await writeFile(`${outputFile}.stderr`, stderr);
  if (exitCode !== 0) throw new Error(`pi exited ${exitCode}: ${stderr.trim() || "no stderr"}`);
  return parseEvents(stdout);
}

async function runScenario(scenario, runNumber) {
  const runRoot = join(outputRoot, scenario.id, `run-${runNumber}`);
  const workspace = join(runRoot, "workspace");
  const sessionDir = join(runRoot, "sessions");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  for (const [path, content] of Object.entries(scenario.files ?? {})) {
    const target = join(workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const turns = [];
  let sessionFile;
  for (let index = 0; index < scenario.turns.length; index += 1) {
    const outputFile = join(runRoot, `turn-${index + 1}.events.jsonl`);
    turns.push(await runTurn({
      workspace,
      sessionDir,
      sessionFile,
      prompt: scenario.turns[index],
      outputFile,
    }));
    sessionFile ??= await findSessionFile(sessionDir);
  }

  const result = { scenario: scenario.id, run: runNumber, turns };
  result.checks = scenario.check(result);
  result.passed = result.checks.every((item) => item.passed);
  await writeFile(join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const selected = scenarios.filter((scenario) => scenarioFilter === "all" || scenario.id === scenarioFilter);
if (selected.length === 0) {
  throw new Error(`Unknown scenario '${scenarioFilter}'. Available: ${scenarios.map((item) => item.id).join(", ")}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const results = [];
for (const scenario of selected) {
  for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
    process.stdout.write(`Running ${scenario.id} ${runNumber}/${runs}...\n`);
    results.push(await runScenario(scenario, runNumber));
  }
}

const summary = {
  repoRoot,
  model,
  thinking,
  runs,
  outputRoot,
  scenarios: selected.map((item) => item.id),
  passed: results.filter((item) => item.passed).length,
  total: results.length,
  results: results.map((result) => ({
    scenario: result.scenario,
    run: result.run,
    passed: result.passed,
    checks: result.checks,
  })),
};
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

for (const result of results) {
  console.log(`\n${result.passed ? "PASS" : "FAIL"} ${result.scenario} run ${result.run}`);
  for (const item of result.checks) {
    console.log(`  ${item.passed ? "✓" : "✗"} ${item.name}: ${JSON.stringify(item.observed)}`);
  }
}
console.log(`\n${summary.passed}/${summary.total} scenario runs passed`);
console.log(`Evidence: ${outputRoot}`);

if (strict && summary.passed !== summary.total) process.exitCode = 1;
