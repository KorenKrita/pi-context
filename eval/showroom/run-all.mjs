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
    const counts = { pass: 0, fail: 0, runError: 0 };
    for (const row of rows) {
      if (row[1] !== "outcome") continue;
      if (row[index] === "pass") counts.pass++;
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

function main() {
  const args = parseArgs(process.argv);
  const product = resolveProductCommit({ allowDirty: args.allowDirty });
  const label = args.label ?? `${args.model.replace(/[^\w.-]+/g, "-")}-${product.commit.slice(0, 8)}`;
  const outRoot = resolve(args.out ?? join(CHECKOUT, "eval", ".runs", "showroom", label));
  mkdirSync(outRoot, { recursive: true });

  const rows = [];
  const failures = [];
  for (const id of args.scenarios) {
    const scenarioDir = join(outRoot, id);
    const verdictPath = join(scenarioDir, "verdict.json");
    if (args.resume && existsSync(verdictPath)) {
      process.stderr.write(`[run-all] ${id}: resumed from existing verdict\n`);
      rows.push(buildRow(id, SCENARIOS[id], JSON.parse(readFileSync(verdictPath, "utf8"))));
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
    rows.push(buildRow(id, SCENARIOS[id], JSON.parse(readFileSync(verdictPath, "utf8"))));
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
    summary: { ...summarizeRows(rows), requested: args.scenarios.length, completed: rows.length, failures },
    rowFields: ROW_FIELDS,
    rows,
  };
  const evidencePath = join(outRoot, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ evidencePath, ...evidence.summary }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
