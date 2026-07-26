#!/usr/bin/env node
// Single-commit batch orchestration for the paired showroom bank.
//
// Why this exists: hand-running run-pair.mjs and judge.mjs per scenario is what
// made the eval "heavy", and it silently produced cross-commit evidence — the
// 2026-07-25 Opus calibration had to declare itself a merge of three product
// commits, which makes it useless as a causal estimate. This script pins one
// commit for the whole sweep and refuses to mix.
//
// Usage:
//   node run-all.mjs --model <provider/model> [--thinking high] [--seed 7]
//     [--out eval/.runs/showroom/<label>] [--label <name>]
//     [--scenarios P1,P2,...] [--arm on|off|both] [--max-tokens 8000]
//     [--allow-dirty] [--resume]
//
// Output: <out>/evidence.json — one merged, single-commit evidence artifact,
// plus each scenario's own run-summary.json and verdict.json under <out>/<ID>/.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, "..", "..");

export function parseArgs(argv) {
  const out = {
    seed: 7,
    thinking: "high",
    arm: "both",
    maxTokens: 8000,
    allowDirty: false,
    resume: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--thinking") out.thinking = argv[++i];
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--scenarios") out.scenarios = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--arm") out.arm = argv[++i];
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i]);
    else if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--resume") out.resume = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.model) throw new Error("usage: run-all.mjs --model <provider/model> [--scenarios ID,ID] [--allow-dirty]");

  const ids = out.scenarios ?? Object.keys(SCENARIOS);
  const unknown = ids.filter((id) => !SCENARIOS[id]);
  if (unknown.length > 0) {
    throw new Error(`unknown scenario(s): ${unknown.join(", ")}; have: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  out.scenarios = ids;
  return out;
}

/**
 * The whole point of the batch runner: every arm of every scenario must come
 * from one product commit. A dirty tree is refused rather than recorded,
 * because "commit + uncommitted delta" is not a reproducible product state —
 * `--allow-dirty` exists for local iteration and stamps the artifact as
 * non-citable instead of pretending the commit describes it.
 */
export function resolveProductCommit({ allowDirty, git = runGit }) {
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).length > 0;
  if (dirty && !allowDirty) {
    throw new Error(
      "working tree is dirty: a batch sweep must describe one committed product state. " +
      "Commit the change, or pass --allow-dirty to mark the artifact non-citable.",
    );
  }
  return { commit, dirty, citable: !dirty };
}

function runGit(args) {
  return execFileSync("git", args, { cwd: CHECKOUT, encoding: "utf8" }).trim();
}

function runNode(script, args) {
  const res = spawnSync("node", [join(HERE, script), ...args], {
    cwd: CHECKOUT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/** Flatten one scenario's verdict.json into the compact evidence row shape. */
export function buildRow(id, scenario, verdict) {
  const on = verdict?.arms?.on;
  const off = verdict?.arms?.off;
  const pick = (arm, key) => (arm?.diagnostics?.[key] ?? null);
  const kind = (on?.verdict ?? off?.verdict) === "diagnostics" ? "diagnostics" : "outcome";
  return [
    id,
    kind,
    on?.verdict ?? "missing",
    off?.verdict ?? "missing",
    pick(on, "toolCalls"), pick(off, "toolCalls"),
    pick(on, "reads"), pick(off, "reads"),
    pick(on, "writes"), pick(off, "writes"),
    pick(on, "firstAcmCallIndex"), pick(off, "firstAcmCallIndex"),
  ];
}

export const ROW_FIELDS = [
  "scenario", "kind", "onVerdict", "offVerdict",
  "onToolCalls", "offToolCalls", "onReads", "offReads",
  "onWrites", "offWrites", "onFirstAcmCallIndex", "offFirstAcmCallIndex",
];

export function summarizeRows(rows) {
  const tally = (index) => {
    // outcomeDelivered counts every arm that satisfied the user's request,
    // whether or not the expected ACM move happened; moveMissed is the ACM-side
    // signal kept separate so a skipped move never reads as a task failure.
    const counts = { pass: 0, moveMissed: 0, fail: 0, runError: 0, outcomeDelivered: 0 };
    for (const row of rows) {
      if (row[1] !== "outcome") continue;
      if (row[index] === "pass") { counts.pass++; counts.outcomeDelivered++; }
      else if (row[index] === "outcome_pass_move_missed") { counts.moveMissed++; counts.outcomeDelivered++; }
      else if (row[index] === "fail") counts.fail++;
      else if (row[index] === "run_error") counts.runError++;
    }
    return counts;
  };
  return {
    scenarios: rows.length,
    outcomeScenarios: rows.filter((r) => r[1] === "outcome").length,
    diagnosticsOnlyScenarios: rows.filter((r) => r[1] === "diagnostics").length,
    on: tally(2),
    off: tally(3),
  };
}

/**
 * Thrash detection — the paired overhead judgement the outcome gate cannot make.
 *
 * N1 in the 2026-07-25 calibration is the motivating case: both arms passed,
 * but the treated arm burned 62 tool calls across 3 travel attempts against the
 * control's 21. A pass/fail gate records that as a footnote, so the cost of
 * over-triggering never shows up as a signal. These thresholds turn the
 * paired numbers into an explicit red flag while leaving the verdict alone:
 * overhead is reported, never silently converted into a task failure.
 */
export const THRASH_TOOL_CALL_RATIO = 2;
export const THRASH_REREAD_FLOOR = 3;
/**
 * Absolute floor for the ratio judgement. A pure ratio has no scale: the
 * 2026-07-26 dsv4flash sweep flagged D3 for "2 tool calls vs control 1",
 * while the real overhead cases it exists to catch (N1 at 33 vs 20, and the
 * motivating Opus N1 at 62 vs 21) live an order of magnitude higher. Below
 * this floor a doubled ratio is noise, not thrash.
 */
export const THRASH_MIN_TOOL_CALLS = 12;

export function detectThrash(scores) {
  const { on, off, delta } = scores;
  if (!on) return null;
  const flags = [];

  // Overhead only means something against a control that did the same work,
  // and only once the treated arm did enough work for a ratio to have scale.
  if (delta
    && typeof delta.toolCallRatio === "number"
    && delta.toolCallRatio >= THRASH_TOOL_CALL_RATIO
    && on.toolCalls >= THRASH_MIN_TOOL_CALLS) {
    flags.push({
      kind: "paired_overhead",
      detail: `treated arm used ${on.toolCalls} tool calls vs control ${off.toolCalls} (ratio ${delta.toolCallRatio})`,
    });
  }
  // Folding and then re-ingesting the ARCHIVED material inside the window.
  // Read volume alone is not the signal: continuing to work after a fold is
  // the intended behavior (see scorePostFoldReread).
  const rereads = on.postFoldReread ?? {};
  if (typeof rereads.maxRereads === "number" && rereads.maxRereads >= THRASH_REREAD_FLOOR) {
    flags.push({
      kind: "post_fold_reread",
      detail: `${rereads.maxRereads} archived target(s) re-read within ${on.postFoldReread.folds} fold window(s)`,
    });
  }
  // `repeated_acm_attempts` was removed after the 2026-07-26 sol-medium sweep:
  // with ACM_TRIGGERS_DISABLED the control arm's acmCalls is ~always 0, so
  // `delta.acmCalls >= 2` fired on N1/N2/N4/P4 merely because the treated arm
  // used the tools at all. It measured whether the product was active, not
  // whether it thrashed; paired_overhead carries the real overhead signal.
  return flags.length > 0 ? { flagged: true, flags } : null;
}

/**
 * Continuous scoring stays out of the flat rows on purpose: rows are the
 * at-a-glance gate table, while the score block is the AB instrument. Kept as
 * a nested object so a saturated gate (10/10 pass) still produces comparable
 * numbers across models and across product commits.
 */
export function collectScores(id, verdict) {
  const arm = (name) => verdict?.arms?.[name]?.score ?? null;
  const on = arm("on");
  const off = arm("off");
  const entry = { on, off };
  if (on && off) {
    entry.delta = {
      toolCalls: on.toolCalls - off.toolCalls,
      acmCalls: on.acmCalls - off.acmCalls,
      toolCallRatio: off.toolCalls > 0 ? Number((on.toolCalls / off.toolCalls).toFixed(2)) : null,
    };
  }
  const thrash = detectThrash(entry);
  if (thrash) entry.thrash = thrash;
  return entry;
}

function main() {
  const args = parseArgs(process.argv);
  const product = resolveProductCommit({ allowDirty: args.allowDirty });
  const label = args.label ?? `${args.model.replace(/[^\w.-]+/g, "-")}-${product.commit.slice(0, 8)}`;
  const outRoot = resolve(args.out ?? join(CHECKOUT, "eval", ".runs", "showroom", label));
  mkdirSync(outRoot, { recursive: true });

  const rows = [];
  const scores = {};
  const failures = [];
  for (const id of args.scenarios) {
    const scenarioDir = join(outRoot, id);
    const verdictPath = join(scenarioDir, "verdict.json");
    if (args.resume && existsSync(verdictPath)) {
      process.stderr.write(`[run-all] ${id}: resumed from existing verdict\n`);
      const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
      rows.push(buildRow(id, SCENARIOS[id], verdict));
      scores[id] = collectScores(id, verdict);
      continue;
    }

    process.stderr.write(`[run-all] ${id}: replaying arms (${args.arm})\n`);
    const pair = runNode("run-pair.mjs", [
      "--scenario", id,
      "--model", args.model,
      "--thinking", args.thinking,
      "--seed", String(args.seed),
      "--arm", args.arm,
      "--max-tokens", String(args.maxTokens),
      "--out", outRoot,
    ]);
    if (pair.status !== 0) {
      failures.push({ scenario: id, stage: "run-pair", status: pair.status });
      process.stderr.write(`[run-all] ${id}: run-pair failed (exit ${pair.status}), continuing\n`);
      continue;
    }

    const judged = runNode("judge.mjs", ["--run", scenarioDir]);
    if (judged.status !== 0 || !existsSync(verdictPath)) {
      failures.push({ scenario: id, stage: "judge", status: judged.status });
      process.stderr.write(`[run-all] ${id}: judge failed (exit ${judged.status}), continuing\n`);
      continue;
    }
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
    rows.push(buildRow(id, SCENARIOS[id], verdict));
    scores[id] = collectScores(id, verdict);
  }

  const evidence = {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    title: `Showroom paired sweep: ${args.model} @ ${product.commit.slice(0, 8)}`,
    scope: "Single-commit batch sweep. Raw sessions, transcripts, and workspaces stay under the run root and are not duplicated here.",
    productCommit: product.commit,
    citable: product.citable,
    ...(product.dirty ? { warning: "Recorded from a dirty working tree; productCommit does not fully describe the product under test." } : {}),
    model: args.model,
    thinking: args.thinking,
    seed: args.seed,
    maxTokens: args.maxTokens,
    arm: args.arm,
    runRoot: outRoot,
    summary: {
      ...summarizeRows(rows),
      requested: args.scenarios.length,
      completed: rows.length,
      failures,
      // Surfaced at the top level: an all-pass sweep with thrash flags is a
      // different result from a clean all-pass sweep.
      thrashFlagged: Object.entries(scores).filter(([, s]) => s.thrash).map(([id]) => id),
    },
    rowFields: ROW_FIELDS,
    rows,
    scores,
  };
  const evidencePath = join(outRoot, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ evidencePath, ...evidence.summary }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
