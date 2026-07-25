#!/usr/bin/env node
// Paired showroom replay: same scenario prefix, triggers ON vs OFF,
// same seed/model/checkout. The only experimental variable is the
// ACM_TRIGGERS_DISABLED environment switch read by the extension.
//
// Window shrinking uses the real mechanism (inherited from the retired
// five-environment harness): a derived PI_CODING_AGENT_DIR whose models.json
// has contextWindow/maxTokens clamped, so working-budget pressure is cheap to
// create. There is no PI_CONTEXT_WINDOW_OVERRIDE in Pi.
//
// Usage:
//   node run-pair.mjs --scenario P1 --model <provider/model> [--thinking high]
//     [--out eval/.runs/showroom] [--seed 7] [--arm on|off|both]
//     [--window 40000] [--max-tokens 8000]
//
// Each arm produces <out>/<scenario>/<arm>/: session copy, transcript.json
// (raw JSONL events from pi --mode json), and the workspace. Judging is a
// separate pass (judge.mjs) so re-judging never reruns models.

import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, "..", "..");

export function parseArgs(argv) {
  const out = {
    seed: 7,
    thinking: "high",
    arm: "both",
    out: join(CHECKOUT, "eval", ".runs", "showroom"),
    maxTokens: 8000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--thinking") out.thinking = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--arm") out.arm = argv[++i];
    else if (a === "--window") out.window = Number(argv[++i]);
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.scenario || !out.model) {
    throw new Error("usage: run-pair.mjs --scenario <ID> --model <provider/model> [--arm on|off|both]");
  }
  out.out = resolve(out.out);
  return out;
}

/**
 * Derive a harness agent dir from the user's real ~/.pi/agent with every
 * model's context window clamped to the scenario window. Models and auth are
 * copied so the selected real provider works; packages are emptied so only
 * the explicitly passed -e extensions load. Same mechanism as the retired
 * buildAgentsOnlyAgentDir (HEAD~1:eval/setup.mjs), reduced to what paired
 * replay needs.
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

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    quietStartup: true,
    defaultProjectTrust: "always",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
    packages: [],
  }, null, 2));

  const auth = join(realDir, "auth.json");
  if (existsSync(auth)) cpSync(auth, join(agentDir, "auth.json"));
  return agentDir;
}

function buildScenario(scenario, seed, dir) {
  execFileSync("node", [join(HERE, "build-scenario.mjs"), "--scenario", scenario, "--out", dir, "--seed", String(seed)], { stdio: ["ignore", "pipe", "inherit"] });
}

// Pi 0.81.1 resumes relative built-in tools from the persisted session header
// cwd via SessionManager.open()/getCwd(), not from the spawning process cwd.
// Keep the exact-host fixture for this contract when advancing the Pi pin.
export function copySessionForWorkspace(sourcePath, targetPath, workspace) {
  const lines = readFileSync(sourcePath, "utf8").trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session") throw new Error(`expected session header in ${sourcePath}`);
  lines[0] = JSON.stringify({ ...header, cwd: resolve(workspace) });
  writeFileSync(targetPath, lines.join("\n") + "\n");
}

function runArm({ armDir, arm, expected, model, thinking, agentDir }) {
  const sessionPath = join(armDir, "session.jsonl");
  const workspace = join(armDir, "workspace");
  const prompts = expected.resumePrompts;
  const events = [];

  for (let turn = 0; turn < prompts.length; turn++) {
    const args = [
      "--session", sessionPath,
      "--mode", "json",
      "--model", model,
      "--thinking", thinking,
      // The product under test: this checkout's ACM extensions, loaded
      // explicitly so the harness agent dir stays package-free.
      "-e", join(CHECKOUT, "src", "index.ts"),
      "--no-context-files",
      // Scenario control: burst detection counts builtin read tools only.
      // A bash `grep -r` sweep would bypass the instrumented tool surface and
      // silently void the scripted read-burst precondition, so bash is
      // excluded unless the scenario explicitly opts back in.
      ...(expected.toolPolicy?.allowBash ? [] : ["--exclude-tools", "bash"]),
      "-p", prompts[turn],
    ];
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Keep session storage inside the arm dir instead of the global tree.
      PI_CODING_AGENT_SESSION_DIR: join(armDir, "sessions"),
    };
    if (arm === "off") env.ACM_TRIGGERS_DISABLED = "1";
    else delete env.ACM_TRIGGERS_DISABLED;

    const res = spawnSync("pi", args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    const turnEvents = [];
    for (const line of (res.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      try { turnEvents.push(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
    events.push({
      turn: turn + 1,
      prompt: prompts[turn],
      exitStatus: res.status,
      timedOut: res.signal === "SIGTERM",
      stderrTail: (res.stderr ?? "").split("\n").slice(-8).join("\n"),
      events: turnEvents,
    });
    if (res.status !== 0) break;
  }
  writeFileSync(join(armDir, "transcript.json"), JSON.stringify({
    arm, model, thinking,
    generated: new Date().toISOString(),
    turns: events,
  }, null, 2));
  return events;
}

function main() {
  const args = parseArgs(process.argv);
  const scenarioDir = join(args.out, args.scenario);
  const baseDir = join(scenarioDir, "base");
  mkdirSync(scenarioDir, { recursive: true });

  // Build the scripted prefix once, then copy per arm. The journal content is
  // identical except that each session header is rebound to its isolated arm
  // workspace; otherwise resumed tools keep operating in base/workspace.
  if (!existsSync(join(baseDir, "session.jsonl"))) {
    buildScenario(args.scenario, args.seed, baseDir);
  }
  const expected = JSON.parse(readFileSync(join(baseDir, "expected.json"), "utf8"));
  const window = args.window ?? expected.window ?? 40000;
  const agentDir = buildHarnessAgentDir({
    window,
    maxTokens: args.maxTokens,
    harnessRoot: join(args.out, ".harness"),
  });

  const arms = args.arm === "both" ? ["on", "off"] : [args.arm];
  const summary = {
    scenario: args.scenario, seed: args.seed, model: args.model,
    thinking: args.thinking, window, agentDir, arms: {},
  };
  for (const arm of arms) {
    const armDir = join(scenarioDir, arm);
    rmSync(armDir, { recursive: true, force: true });
    mkdirSync(armDir, { recursive: true });
    copySessionForWorkspace(join(baseDir, "session.jsonl"), join(armDir, "session.jsonl"), join(armDir, "workspace"));
    cpSync(join(baseDir, "workspace"), join(armDir, "workspace"), { recursive: true });
    cpSync(join(baseDir, "expected.json"), join(armDir, "expected.json"));
    const turns = runArm({ armDir, arm, expected, model: args.model, thinking: args.thinking, agentDir });
    summary.arms[arm] = {
      turns: turns.length,
      completed: turns.every((t) => t.exitStatus === 0 && !t.timedOut),
    };
  }
  writeFileSync(join(scenarioDir, "run-summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
