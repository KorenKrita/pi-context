#!/usr/bin/env bun
// Resumable live evaluation matrix runner.
//
// Preview the default declaration (no provider calls):
//   bun eval/run-matrix.mjs
// Execute it with bounded parallelism:
//   bun eval/run-matrix.mjs --execute --concurrency 2
// Resume incomplete/provider-failed jobs from a prior matrix directory:
//   bun eval/run-matrix.mjs --resume eval/.runs/matrix-... --concurrency 2
// Use a different declaration:
//   bun eval/run-matrix.mjs --matrix eval/matrix.default.mjs --execute

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyRunnerReport,
  compactMatrixReport,
  createMatrixState,
  expandMatrixManifest,
  formatMatrixMarkdown,
  shouldSkipExisting,
  writeJsonAtomic,
} from "./matrix.mjs";
import { RUNS_DIR } from "./setup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const stateFileName = "matrix-state.json";
const compactFileName = "matrix-report.json";
const markdownFileName = "matrix-report.md";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "usage: bun eval/run-matrix.mjs [--matrix FILE] [--execute] [--concurrency N] [--output DIR] [--resume DIR] [--cell ID] [--skip-existing]",
    "",
    "Without --execute, the runner writes a planned compact report only; it never starts models by default.",
  ].join("\n");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function makeOutputDir(matrixId) {
  const safe = matrixId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const output = join(RUNS_DIR, `matrix-${timestampLabel()}-${safe}-p${process.pid}`);
  mkdirSync(output, { recursive: true });
  return output;
}

function resolvePathFromCwd(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trimCommandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Exact host-fixture dependencies and the executable that performs live eval
 * intentionally have separate provenance: a local `pi` may be newer than the
 * package contract being verified by test/host-fixture.
 */
function collectPiProvenance() {
  const cliPath = trimCommandOutput("which", ["pi"]);
  const versionOutput = cliPath ? trimCommandOutput(cliPath, ["--version"]) : null;
  const packageJson = loadJson(join(repoRoot, "package.json"), "project package manifest");
  const contract = packageJson.devDependencies?.["@earendil-works/pi-agent-core"]
    ?? packageJson.peerDependencies?.["@earendil-works/pi-agent-core"]
    ?? null;
  return {
    cliPath,
    versionOutput,
    version: versionOutput?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? versionOutput,
    projectExactHostContract: contract,
  };
}

async function loadManifest(path) {
  const absolute = resolvePathFromCwd(path);
  if (!existsSync(absolute)) throw new Error(`matrix declaration does not exist: ${absolute}`);
  if (absolute.endsWith(".json")) return { source: absolute, manifest: loadJson(absolute, "matrix declaration") };
  const module = await import(`${pathToFileURL(absolute).href}?matrix-load=${Date.now()}`);
  const manifest = module.matrix ?? module.default;
  if (!manifest) throw new Error(`matrix declaration ${absolute} must export 'matrix' or default`);
  return { source: absolute, manifest };
}

function writeArtifacts(outputDir, state) {
  const compact = compactMatrixReport(state);
  writeJsonAtomic(join(outputDir, stateFileName), state);
  writeJsonAtomic(join(outputDir, compactFileName), compact);
  writeFileSync(join(outputDir, markdownFileName), formatMatrixMarkdown(compact));
  return compact;
}

function reportPathFromOutput(output) {
  const match = output.match(/^report:\s*(.+)\s*$/m);
  return match?.[1]?.trim() || null;
}

function spawnRunner(job) {
  const args = [
    "eval/run.mjs",
    "--model", job.model,
    "--thinking", job.thinking,
    "--environment-mode", job.environment,
    "--id", job.scenarioId,
  ];
  if (job.contextWindow !== undefined) args.push("--context-window", String(job.contextWindow));
  return new Promise((resolveResult) => {
    const child = spawn("bun", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      resolveResult({ exitCode: null, signal: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      resolveResult({ exitCode, signal, stdout, stderr, error: null });
    });
  });
}

function readChildReport(child) {
  const reportPath = reportPathFromOutput(`${child.stdout}\n${child.stderr}`);
  if (!reportPath || !existsSync(reportPath)) return { reportPath, report: null };
  try {
    return { reportPath, report: JSON.parse(readFileSync(reportPath, "utf8")) };
  } catch (error) {
    return { reportPath, report: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

async function executeJob({ state, outputDir, jobKey }) {
  const job = state.jobs[jobKey];
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.attempts += 1;
  writeArtifacts(outputDir, state);
  console.log(`START ${job.key} (${job.model}, ${job.thinking}, ${job.environment}, ${job.scenarioId}, repeat ${job.repeat})`);
  const started = Date.now();
  const child = await spawnRunner(job);
  const { reportPath, report, parseError } = readChildReport(child);
  const classified = classifyRunnerReport(report, {
    exitCode: child.exitCode,
    error: child.error ?? parseError ?? (child.signal ? `runner terminated by ${child.signal}` : null),
  });
  Object.assign(job, classified, {
    reportPath,
    report,
    childExitCode: child.exitCode,
    childSignal: child.signal,
    durationMs: Date.now() - started,
    finishedAt: new Date().toISOString(),
    ...(child.stderr.trim().length === 0 ? {} : { childStderr: child.stderr.slice(-2000) }),
  });
  writeArtifacts(outputDir, state);
  console.log(`${job.status === "passed" ? "PASS" : "DONE"} ${job.key} -> ${job.status}${reportPath ? ` (${reportPath})` : ""}`);
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (index < items.length) {
      const next = items[index];
      index += 1;
      await worker(next);
    }
  }));
}

function selectCells(expanded, selectedCellIds) {
  if (selectedCellIds.length === 0) return expanded;
  const known = new Set(expanded.manifest.cells.map((cell) => cell.id));
  for (const id of selectedCellIds) {
    if (!known.has(id)) throw new Error(`unknown matrix cell: ${id}`);
  }
  const wanted = new Set(selectedCellIds);
  return { ...expanded, jobs: expanded.jobs.filter((job) => wanted.has(job.cellId)) };
}

function repeatedOptionValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function rebuildStateFromManifest({ source, expanded, outputDir }) {
  return createMatrixState({ matrixSource: source, manifest: expanded.manifest, jobs: expanded.jobs, outputDir });
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(usage());
    return;
  }
  const execute = flag("--execute");
  const resumeArg = option("--resume");
  const outputArg = option("--output");
  if (resumeArg && outputArg) throw new Error("--resume and --output are mutually exclusive");
  const rawConcurrency = option("--concurrency") ?? "1";
  const concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
  const matrixArg = option("--matrix") ?? join("eval", "matrix.default.mjs");
  const selectedCellIds = repeatedOptionValues("--cell");
  const { source, manifest } = await loadManifest(matrixArg);
  const selected = selectCells(expandMatrixManifest(manifest), selectedCellIds);

  const outputDir = resumeArg
    ? resolvePathFromCwd(resumeArg)
    : outputArg
      ? resolvePathFromCwd(outputArg)
      : makeOutputDir(selected.manifest.id);
  mkdirSync(outputDir, { recursive: true });
  const statePath = join(outputDir, stateFileName);
  let state;
  const canResumeExistingOutput = Boolean(resumeArg) || (Boolean(outputArg) && flag("--skip-existing") && existsSync(statePath));
  if (canResumeExistingOutput) {
    state = loadJson(statePath, "matrix state");
    if (state?.manifest?.id !== selected.manifest.id) {
      throw new Error(`resume matrix id ${state?.manifest?.id ?? "(missing)"} does not match declaration ${selected.manifest.id}`);
    }
    if (JSON.stringify(state.manifest) !== JSON.stringify(selected.manifest)) {
      throw new Error("resume declaration does not exactly match the persisted matrix manifest");
    }
    // A process interruption leaves `running`; no child remains under this
    // runner, so make it deliberately eligible for a fresh retry.
    for (const job of Object.values(state.jobs ?? {})) {
      if (job.status === "running") job.status = "pending";
    }
  } else {
    if (existsSync(statePath)) throw new Error(`output already contains ${stateFileName}; use --resume ${outputDir}`);
    state = rebuildStateFromManifest({ source, expanded: selected, outputDir });
    state.piProvenance = collectPiProvenance();
  }
  state.outputDir = outputDir;
  state.status = execute ? "running" : "planned";
  const initial = writeArtifacts(outputDir, state);
  console.log(`matrix=${state.manifest.id} jobs=${initial.summary.total} output=${outputDir}`);

  if (!execute) {
    console.log("Preview only: no providers started. Add --execute to launch the matrix.");
    return;
  }

  const resume = canResumeExistingOutput || flag("--skip-existing");
  const selectedKeys = new Set(selected.jobs.map((job) => job.key));
  const runnable = Object.values(state.jobs)
    .filter((job) => selectedKeys.has(job.key))
    .filter((job) => !(resume && shouldSkipExisting(job)))
    .map((job) => job.key);
  const skipped = Object.values(state.jobs)
    .filter((job) => selectedKeys.has(job.key))
    .filter((job) => resume && shouldSkipExisting(job));
  state.lastInvocation = {
    startedAt: new Date().toISOString(),
    selectedCellIds,
    skippedExistingKeys: skipped.map((job) => job.key),
  };
  if (skipped.length > 0) writeArtifacts(outputDir, state);
  console.log(`launching=${runnable.length} skipped_existing=${skipped.length} concurrency=${concurrency}`);
  await runWithConcurrency(runnable, concurrency, async (jobKey) => executeJob({ state, outputDir, jobKey }));
  state.status = Object.values(state.jobs).every((job) => job.status !== "pending" && job.status !== "running")
    ? "completed"
    : "partial";
  const compact = writeArtifacts(outputDir, state);
  console.log(`completed=${compact.summary.completed}/${compact.summary.total} passed=${compact.summary.passed} pass_rate=${compact.summary.passRate === null ? "n/a" : `${(compact.summary.passRate * 100).toFixed(1)}%`}`);
  console.log(`json=${join(outputDir, compactFileName)}`);
  console.log(`markdown=${join(outputDir, markdownFileName)}`);
  // Preserve all completed evidence, then match eval/run.mjs semantics: a
  // failed score or infrastructure/run failure is visible to automation.
  if (compact.summary.scenarioFailures || compact.summary.providerFailures || compact.summary.terminalFailures
    || compact.summary.runnerFailures || compact.summary.infrastructureInvalid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
