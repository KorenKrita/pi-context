#!/usr/bin/env node
// Paired long-run replay: the same 30-turn script, ACM triggers ON vs OFF,
// same model / thinking / fixture / turn order. The only experimental variable
// is the ACM_TRIGGERS_DISABLED switch read by the extension.
//
// Unlike the retired showroom runner there is no scripted session prefix: the
// survey phase reads 87K tokens of real fixture logs, so context mass is
// produced by the run itself. That keeps the billed usage authentic — the whole
// point is to measure real dollars, and a synthetic prefix cannot be billed.
//
// The window is clamped to 400K rather than 40K. A smoke run measured ~13.6K
// tokens of prompt growth per survey turn, putting the settling turn near 121K
// and leaving headroom so native compaction never fires. A 40K clamp forced
// compaction in both arms and masked the effect being measured; a 200K clamp
// would have been crossed before the settling turn.
//
// Usage:
//   node run-pair.mjs --model <provider/model> [--thinking high]
//     [--turns 30] [--arm on|off|both] [--out eval/.runs/longrun]
//     [--window 200000] [--max-tokens 16000] [--label <name>]
//
// Each arm produces <out>/<label>/<arm>/: the workspace, transcript.json (raw
// JSONL events from pi --mode json), and outcome.json (the fixture's own
// verify.mjs result). Judging is a separate pass so re-judging never reruns a
// model.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SCENARIO, buildTurnsTruncated, phaseRanges } from "./scenario.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, "..", "..");
const FIXTURE_ROOT = join(CHECKOUT, "eval", "fixtures", SCENARIO.fixture);

export function parseArgs(argv) {
  const out = {
    thinking: "high",
    arm: "both",
    turns: 30,
    window: 400_000,
    maxTokens: 16_000,
    out: join(CHECKOUT, "eval", ".runs", "longrun"),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--thinking") out.thinking = argv[++i];
    else if (a === "--turns") out.turns = Number(argv[++i]);
    else if (a === "--arm") out.arm = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--window") out.window = Number(argv[++i]);
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i]);
    else if (a === "--label") out.label = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.model) throw new Error("usage: run-pair.mjs --model <provider/model> [--arm on|off|both]");
  out.out = resolve(out.out);
  out.label ??= `${out.model.replace(/[^a-z0-9]+/gi, "-")}-${out.thinking}-t${out.turns}`;
  return out;
}

/**
 * Derive a harness agent dir from the real ~/.pi/agent with each model's window
 * clamped, packages emptied, and auth copied so the selected provider works.
 * Same mechanism as the showroom runner.
 */
function buildHarnessAgentDir({ window, maxTokens, harnessRoot }) {
  const realDir = join(homedir(), ".pi", "agent");
  const agentDir = join(harnessRoot, `agent-cw${window}`);
  rmSync(agentDir, { recursive: true, force: true });
  mkdirSync(agentDir, { recursive: true });

  const models = JSON.parse(readFileSync(join(realDir, "models.json"), "utf8"));
  for (const provider of Object.values(models.providers)) {
    for (const model of provider.models ?? []) {
      model.contextWindow = Math.min(model.contextWindow ?? window, window);
      model.maxTokens = Math.min(model.maxTokens ?? maxTokens, maxTokens);
    }
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        quietStartup: true,
        defaultProjectTrust: "always",
        enableInstallTelemetry: false,
        enableAnalytics: false,
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
        packages: [],
      },
      null,
      2,
    ),
  );
  const auth = join(realDir, "auth.json");
  if (existsSync(auth)) cpSync(auth, join(agentDir, "auth.json"));
  return agentDir;
}

/** Run the fixture's own outcome gate against an arm's workspace. */
export function checkOutcome(workspace) {
  const [command, ...args] = SCENARIO.outcomeCommand;
  const res = spawnSync(command, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 60_000,
    stdio: "pipe",
  });
  return {
    command: SCENARIO.outcomeCommand.join(" "),
    exitStatus: res.status,
    delivered: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function runArm({ armDir, arm, turns, model, thinking, agentDir }) {
  const workspace = join(armDir, "workspace");
  const sessionPath = join(armDir, "session.jsonl");
  const records = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const args = [
      "--session",
      sessionPath,
      "--mode",
      "json",
      "--model",
      model,
      "--thinking",
      thinking,
      // The product under test, loaded explicitly so the harness dir stays
      // package-free.
      "-e",
      join(CHECKOUT, "src", "index.ts"),
      "--no-context-files",
      "-p",
      turn.prompt,
    ];
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(armDir, "sessions"),
    };
    if (arm === "off") env.ACM_TRIGGERS_DISABLED = "1";
    else delete env.ACM_TRIGGERS_DISABLED;

    const startedAt = Date.now();
    const res = spawnSync("pi", args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
      env,
    });
    const events = [];
    for (const line of (res.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    }
    records.push({
      turn: index + 1,
      phase: turn.phase,
      prompt: turn.prompt,
      exitStatus: res.status,
      timedOut: res.signal === "SIGTERM",
      elapsedMs: Date.now() - startedAt,
      stderrTail: (res.stderr ?? "").split("\n").slice(-8).join("\n"),
      events,
    });
    process.stderr.write(
      `[${arm}] turn ${index + 1}/${turns.length} (${turn.phase}) exit=${res.status} ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
    );
    if (res.status !== 0) break;
  }

  const outcome = checkOutcome(workspace);
  writeFileSync(
    join(armDir, "transcript.json"),
    JSON.stringify(
      {
        arm,
        model,
        thinking,
        scenario: SCENARIO.id,
        settlesAtTurn: SCENARIO.settlesAtTurn,
        phases: phaseRanges(),
        generated: new Date().toISOString(),
        turns: records,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(armDir, "outcome.json"), JSON.stringify(outcome, null, 2));
  return { records, outcome };
}

function main() {
  const args = parseArgs(process.argv);
  const turns = buildTurnsTruncated(args.turns);
  const runDir = join(args.out, args.label);
  mkdirSync(runDir, { recursive: true });

  const agentDir = buildHarnessAgentDir({
    window: args.window,
    maxTokens: args.maxTokens,
    harnessRoot: join(args.out, ".harness"),
  });

  const arms = args.arm === "both" ? ["on", "off"] : [args.arm];
  const summary = {
    scenario: SCENARIO.id,
    label: args.label,
    model: args.model,
    thinking: args.thinking,
    turns: turns.length,
    window: args.window,
    settlesAtTurn: SCENARIO.settlesAtTurn,
    agentDir,
    arms: {},
  };

  for (const arm of arms) {
    const armDir = join(runDir, arm);
    rmSync(armDir, { recursive: true, force: true });
    mkdirSync(armDir, { recursive: true });
    // Each arm gets a pristine copy of the fixture so neither can see the
    // other's edits.
    cpSync(FIXTURE_ROOT, join(armDir, "workspace"), { recursive: true });

    const { records, outcome } = runArm({
      armDir,
      arm,
      turns,
      model: args.model,
      thinking: args.thinking,
      agentDir,
    });
    summary.arms[arm] = {
      turnsRun: records.length,
      completed: records.length === turns.length && records.every((r) => r.exitStatus === 0 && !r.timedOut),
      elapsedMs: records.reduce((total, r) => total + r.elapsedMs, 0),
      outcomeDelivered: outcome.delivered,
    };
  }

  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
