#!/usr/bin/env bun
// Resumable orchestration for the real-Pi Saffron long-flow comparison.
//
// This runner intentionally delegates each cell to run-flow.mjs. That keeps
// flow materialization, host actions, compaction, deterministic verification,
// resource audit, and session semantics in the one production evaluation path.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFlowEvidence, collectFlowTelemetry, compareContextArms } from "./flow-telemetry.mjs";
import {
  SAFFRON_FIXTURE_VERSION,
  materializeSaffronFlow,
} from "./saffron-flow.mjs";
import {
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  EXTENSION_PATH,
  RUNS_DIR,
  buildFullEnvAgentDir,
  readFullEnvHarnessAudit,
} from "./setup.mjs";

export const LONG_FLOW_MATRIX_SCHEMA_VERSION = 4;
export const CONTROLLED_MAX_TOKENS = 16_000;
export const CONTROLLED_WINDOWS = Object.freeze([400_000, 1_000_000]);
export const DEFAULT_FLOW_ID = "saffron-cutover-long-flow-v1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const stateFileName = "matrix-state.json";
const compactFileName = "matrix-report.json";
const markdownFileName = "matrix-report.md";
const lockFileName = ".matrix.lock";
const INTEGRITY_GUARD_PATH = join(repoRoot, "eval", "integrity-guard.mjs");
const PINNED_SOURCE_FILES = Object.freeze([
  EXTENSION_PATH,
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  join(repoRoot, "eval", "run-flow.mjs"),
  join(repoRoot, "eval", "flow.mjs"),
  join(repoRoot, "eval", "saffron-flow.mjs"),
  join(repoRoot, "eval", "saffron-verifier.mjs"),
  INTEGRITY_GUARD_PATH,
]);

const MODEL_SPECS = Object.freeze([
  { id: "sol-medium", provider: "local-responses", modelId: "gpt-5.6-sol", thinking: "medium" },
  { id: "terra-high", provider: "local-responses", modelId: "gpt-5.6-terra", thinking: "high" },
  { id: "opus-4-6-max", provider: "local-claude", modelId: "claude-opus-4-6", thinking: "max" },
  { id: "opus-4-8-high", provider: "local-claude", modelId: "claude-opus-4-8", thinking: "high" },
]);

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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

function repeatedOptions(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function asAbsolute(path) {
  return path.startsWith("/") ? path : resolve(process.cwd(), path);
}

function localPiPath() {
  return join(repoRoot, "node_modules", ".bin", "pi");
}

function usage() {
  return [
    "usage: bun eval/run-flow-matrix.mjs [--execute] [--concurrency 4] [--output DIR] [--resume DIR] [--flow-seed SECRET] [--recover-stale-lock] [--arm 400k|1m] [--cell ID] [--no-judge] [--timeout-scale N]",
    "",
    "Fixed matrix: Sol medium, Terra high, Opus 4.6 max, Opus 4.8 high × 400K/1M hard windows.",
    "Cells run through eval/run-flow.mjs using full-env, Saffron materialization, local Pi, and maxTokensCap=16000.",
  ].join("\n");
}

export function createLongFlowMatrixManifest({ flowId = DEFAULT_FLOW_ID, matrixRunId = "preview" } = {}) {
  const cells = MODEL_SPECS.flatMap((model) => CONTROLLED_WINDOWS.map((contextWindow) => ({
    id: `${model.id}-${contextWindow === 400_000 ? "400k" : "1m"}`,
    pairKey: model.id,
    matrixRunId,
    model: { provider: model.provider, modelId: model.modelId },
    thinking: model.thinking,
    contextWindow,
    maxTokensCap: CONTROLLED_MAX_TOKENS,
    environmentMode: "full-env",
    flowId,
    agentLabel: `acm-saffron-${matrixRunId}-${model.id}-${contextWindow}`,
  })));
  return {
    schemaVersion: LONG_FLOW_MATRIX_SCHEMA_VERSION,
    id: `acm-real-pi-saffron-400k-vs-1m-${matrixRunId}`,
    matrixRunId,
    flowId,
    environmentMode: "full-env",
    controlledDimensions: {
      hardContextWindow: CONTROLLED_WINDOWS,
      maxTokensCap: CONTROLLED_MAX_TOKENS,
      piBinary: "repo-node-modules",
      piContextSource: "current-worktree",
      sessionRecall: "sanitized_by_full_env_builder_and_denylist",
    },
    cells,
  };
}

export function createInitialMatrixState({
  manifest = createLongFlowMatrixManifest(),
  outputDir,
  piProvenance,
  matrixRunId = manifest.matrixRunId,
  secretSeedSha256,
  pinnedProvenance,
}) {
  return {
    schemaVersion: LONG_FLOW_MATRIX_SCHEMA_VERSION,
    status: "planned",
    startedAt: new Date().toISOString(),
    outputDir,
    matrixRunId,
    secretSeedSha256,
    pinnedProvenance,
    manifest,
    piProvenance,
    cells: Object.fromEntries(manifest.cells.map((cell) => [cell.id, { ...cell, status: "pending", attempts: 0 }])),
  };
}

/** A provider/RPC error is retriable; durable outcome evidence is not by default. */
export function shouldSkipMatrixCell(cell) {
  return ["certifying_run", "task_failure", "coverage_insufficient", "occupancy_miss", "infrastructure_invalid"].includes(cell?.classification);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function relativeRepoPath(path) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

export function generateMatrixSecret() {
  return randomBytes(32).toString("hex");
}

export function generateMatrixRunId() {
  return randomBytes(8).toString("hex");
}

export function buildSaffronPin(secretSeed, materializeOptions = {}) {
  const common = { seed: secretSeed, ...materializeOptions };
  const constrained = materializeSaffronFlow({ ...common, contextWindow: 400_000 });
  const native = materializeSaffronFlow({ ...common, contextWindow: 1_000_000 });
  if (JSON.stringify(constrained.promptHashes) !== JSON.stringify(native.promptHashes)) {
    throw new Error("Saffron prompt hashes differ between 400K and 1M materialization");
  }
  if (constrained.manifest.fixtureSha256 !== native.manifest.fixtureSha256
    || constrained.manifest.oracleSha256 !== native.manifest.oracleSha256) {
    throw new Error("Saffron fixture/oracle hashes differ between context-window arms");
  }
  return {
    fixtureVersion: SAFFRON_FIXTURE_VERSION,
    fixtureSha256: constrained.manifest.fixtureSha256,
    oracleSha256: constrained.manifest.oracleSha256,
    promptHashes: constrained.promptHashes,
    packet: constrained.manifest.packet,
    earlyDigest: constrained.manifest.earlyDigest,
    supplement: constrained.manifest.supplement,
    secretSeedSha256: sha256(secretSeed),
  };
}

function configHashes(sourceAgentDir) {
  return Object.fromEntries([
    "settings.json",
    "models.json",
    "auth.json",
    "AGENTS.md",
    "thinking-presets.json",
    "subagents-lite.json",
    "pi.env",
  ].map((name) => [name, fileHash(join(sourceAgentDir, name))]));
}

function fullEnvPin(matrixRunId) {
  const arms = {};
  for (const contextWindow of CONTROLLED_WINDOWS) {
    const agentDir = buildFullEnvAgentDir({
      contextWindow,
      maxTokensCap: CONTROLLED_MAX_TOKENS,
      shrink: true,
      label: `matrix-pin-${matrixRunId}-${contextWindow}`,
    });
    const audit = readFullEnvHarnessAudit(agentDir);
    arms[String(contextWindow)] = {
      settingsSha256: fileHash(join(agentDir, "settings.json")),
      modelsSha256: fileHash(join(agentDir, "models.json")),
      sanitizedSettingsSha256: audit.settings?.sanitizedSha256 ?? null,
      sanitizedPackagesSha256: audit.settings?.sanitizedPackagesSha256 ?? null,
      originalSettingsSha256: audit.settings?.originalSha256 ?? null,
      originalPackagesSha256: audit.settings?.originalPackagesSha256 ?? null,
      globalAgentsSha256: audit.globalAgents?.harness?.sha256 ?? null,
      rootConfigHashes: Object.fromEntries((audit.rootConfigs ?? []).map((entry) => [entry.name, entry.harness?.sha256 ?? null])),
      removedPackages: audit.settings?.removedPackages ?? [],
      excludedFiles: audit.excludedFiles ?? [],
    };
    if (!arms.sourceConfigHashes) arms.sourceConfigHashes = configHashes(audit.sourceAgentDir);
  }
  return arms;
}

export function collectPinnedProvenance({ secretSeed, matrixRunId, saffronOptions } = {}) {
  if (!secretSeed || !matrixRunId) throw new Error("secretSeed and matrixRunId are required for pinned provenance");
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const pi = piProvenance();
  return {
    headSha,
    sourceHashes: Object.fromEntries(PINNED_SOURCE_FILES.map((path) => [relativeRepoPath(path), fileHash(path)])),
    saffron: buildSaffronPin(secretSeed, saffronOptions),
    pi: { ...pi, binarySha256: fileHash(pi.path) },
    fullEnv: fullEnvPin(matrixRunId),
    controlled: { contextWindows: CONTROLLED_WINDOWS, maxTokensCap: CONTROLLED_MAX_TOKENS },
  };
}

export function assertPinnedProvenance(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("resume provenance mismatch: HEAD, prompts, fixture, Pi, or full-env configuration changed");
  }
}

export function assertResumeSeed(expectedHash, suppliedSeed) {
  if (!suppliedSeed) throw new Error("resume requires --flow-seed or ACM_FLOW_SEED");
  if (sha256(suppliedSeed) !== expectedHash) throw new Error("resume flow seed does not match matrix state");
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function acquireMatrixLock(outputDir, { recoverStale = false, isPidAlive = defaultPidAlive } = {}) {
  const path = join(outputDir, lockFileName);
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    const holder = existsSync(path) ? readFileSync(path, "utf8").trim() : "unknown";
    if (recoverStale && existsSync(path)) {
      let parsed;
      try { parsed = JSON.parse(holder); } catch { /* malformed locks are never auto-removed */ }
      if (!Number.isInteger(parsed?.pid) || isPidAlive(parsed.pid)) {
        throw new Error(`matrix output is locked by a live or unverifiable holder: ${path}; holder=${holder}`);
      }
      const quarantine = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      let recovered;
      try {
        renameSync(path, quarantine);
        recovered = acquireMatrixLock(outputDir, { recoverStale: false, isPidAlive });
        unlinkSync(quarantine);
        return recovered;
      } catch (recoveryError) {
        if (recovered) releaseMatrixLock(recovered);
        if (existsSync(quarantine)) unlinkSync(quarantine);
        throw new Error(`stale matrix lock recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
    }
    throw new Error(`matrix output is locked: ${path}; holder=${holder}; ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}

export function releaseMatrixLock(path) {
  if (path && existsSync(path)) unlinkSync(path);
}

export function finalMatrixStatus(state) {
  return Object.values(state?.cells ?? {}).some((cell) => cell.status === "pending" || cell.status === "running")
    ? "partial"
    : "completed";
}

function piProvenance() {
  const path = localPiPath();
  const project = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const expectedProjectVersion = project.devDependencies?.["@earendil-works/pi-coding-agent"]
    ?? project.peerDependencies?.["@earendil-works/pi-coding-agent"]
    ?? null;
  let version = null;
  let error = null;
  try {
    version = execFileSync(path, ["--version"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { path, exists: existsSync(path), version, expectedProjectVersion, exact: version !== null && version === expectedProjectVersion, error };
}

function assertPiProvenance(provenance) {
  if (!provenance.exists || !provenance.exact) {
    throw new Error(`repo-local Pi mismatch: expected ${provenance.expectedProjectVersion ?? "unknown"}, got ${provenance.version ?? provenance.error ?? "unavailable"} at ${provenance.path}`);
  }
}

export function buildRunFlowArgs(cell, {
  timeoutScale = 1,
  doJudge = true,
  judgeModel,
  judgeThinking,
  piBinary = localPiPath(),
  secretSeed,
  auditOnly = false,
} = {}) {
  const args = [
    "eval/run-flow.mjs",
    "--full-env",
    "--flow", cell.flowId,
    "--model", `${cell.model.provider}/${cell.model.modelId}`,
    "--thinking", cell.thinking,
    "--context-window", String(cell.contextWindow),
    "--max-tokens-cap", String(cell.maxTokensCap),
    "--pi-binary", piBinary,
    "--agent-label", cell.agentLabel,
    "--variant", cell.id,
    "--matrix-id", cell.matrixRunId,
    "--timeout-scale", String(timeoutScale),
  ];
  if (!doJudge || auditOnly) args.push("--no-judge");
  if (auditOnly) args.push("--audit-only");
  if (judgeModel) args.push("--judge-model", judgeModel);
  if (judgeThinking) args.push("--judge-thinking", judgeThinking);
  // The seed is passed to the orchestration process as an argv value, not an
  // environment variable inherited by the Pi worker. run-flow owns the final
  // scrub boundary before it starts Pi.
  if (secretSeed) args.push("--flow-seed", secretSeed);
  return args;
}

function reportPathFromOutput(output) {
  return output.match(/^report:\s*(.+)\s*$/m)?.[1]?.trim() ?? null;
}

function stableSourcePath(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  try { return realpathSync(path); } catch { return null; }
}

export function normalizeGlobalCommandInventory(commands = []) {
  const globalCommands = commands
    .filter((command) => (command?.source === "extension" || command?.source === "skill") && command?.sourceInfo?.scope !== "temporary")
    .map((command) => {
      const declaredPath = command.sourceInfo?.path ?? null;
      const realpath = stableSourcePath(declaredPath);
      return {
        name: command.name ?? null,
        source: command.source,
        scope: command.sourceInfo?.scope ?? null,
        origin: command.sourceInfo?.origin ?? null,
        packageSource: command.sourceInfo?.source ?? null,
        sourceKey: realpath ?? `nonfile:${declaredPath ?? command.name ?? "unknown"}`,
      };
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const sources = [...new Set(globalCommands.map((command) => command.sourceKey))]
    .sort()
    .map((sourceKey) => sourceKey.startsWith("nonfile:")
      ? { kind: "nonfile", key: sourceKey, sha256: null }
      : { kind: "file", key: sourceKey, sha256: fileHash(sourceKey) });
  const inventory = { commands: globalCommands, sources };
  return { ...inventory, sha256: sha256(JSON.stringify(inventory)) };
}

export function rehashGlobalCommandInventory(pinned) {
  const sources = (pinned?.sources ?? []).map((source) => source.kind === "file"
    ? { ...source, sha256: fileHash(source.key) }
    : source);
  const inventory = { commands: pinned?.commands ?? [], sources };
  return { ...inventory, sha256: sha256(JSON.stringify(inventory)) };
}

function preflightCell(manifest) {
  const base = manifest.cells.find((cell) => cell.contextWindow === 400_000) ?? manifest.cells[0];
  return {
    ...base,
    id: `${manifest.matrixRunId}-preflight`,
    agentLabel: `acm-saffron-${manifest.matrixRunId}-preflight`,
  };
}

export async function runAuditPreflight({ manifest, secretSeed, piBinary, timeoutScale = 1, spawnImpl = spawn } = {}) {
  const cell = preflightCell(manifest);
  const child = await runFlowChild({
    cell,
    options: { timeoutScale, doJudge: false, auditOnly: true, piBinary, secretSeed },
    spawnImpl,
  });
  const reportPath = reportPathFromOutput(`${child.stdout}\n${child.stderr}`);
  if (!reportPath || !existsSync(reportPath)) {
    throw new Error(`audit preflight produced no readable report: ${child.error ?? child.stderr ?? "unknown"}`);
  }
  const report = readJson(reportPath);
  if (report.status !== "completed" || report.infrastructureInvalid) {
    throw new Error(`audit preflight failed: ${report.infrastructureInvalid?.reason ?? report.status}`);
  }
  return {
    reportPath,
    reportSha256: fileHash(reportPath),
    commandInventory: normalizeGlobalCommandInventory(report.commands ?? []),
    piBinary: report.piBinary ?? null,
    resources: report.resources ?? null,
  };
}

/** Injectable child process seam for deterministic orchestration tests. */
export function runFlowChild({ cell, options = {}, spawnImpl = spawn, bunBinary = process.execPath } = {}) {
  const args = buildRunFlowArgs(cell, options);
  return new Promise((resolveResult) => {
    const piBinary = options.piBinary ?? localPiPath();
    const childEnv = { ...process.env };
    delete childEnv.ACM_FLOW_SEED;
    delete childEnv.SAFFRON_FLOW_SEED;
    const child = spawnImpl(bunBinary, args, {
      cwd: repoRoot,
      env: {
        ...childEnv,
        ACM_PI_BINARY: piBinary,
        ACM_JUDGE_LABEL: `${cell.agentLabel}-judge`,
        PATH: `${dirname(piBinary)}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveResult({ args, stdout, stderr, exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, signal) => resolveResult({ args, stdout, stderr, exitCode, signal, error: null }));
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSessionEntries(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  const entries = [];
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(sessionDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* partial JSONL line is not evidence */ }
    }
  }
  return entries;
}

function integrityFromReport(report) {
  const audit = report?.resources?.fullEnvHarness ?? null;
  const sanitized = audit?.settings?.sanitizedPackages ?? [];
  const identities = new Set(sanitized.map((entry) => entry?.identity));
  return {
    sessionRecallPackagePresent: identities.has("npm:@ogulcancelik/pi-session-recall"),
    sessionRecallConfigPresent: !audit?.excludedFiles?.includes("session-recall.json"),
    audit: audit === null ? { present: false } : {
      present: true,
      removedPackages: audit.settings?.removedPackages ?? [],
      excludedFiles: audit.excludedFiles ?? [],
      globalAgentsIncluded: audit.globalAgents?.source?.exists === true
        && audit.globalAgents?.harness?.exists === true
        && audit.globalAgents?.source?.sha256 === audit.globalAgents?.harness?.sha256,
    },
  };
}

function runtimeCellProvenance(report, runDir) {
  const saffronManifestPath = join(runDir, "saffron-manifest.json");
  const saffron = existsSync(saffronManifestPath) ? readJson(saffronManifestPath) : null;
  const audit = report?.resources?.fullEnvHarness ?? null;
  const configuredModel = report?.runtimeAudit?.configuredModel ?? null;
  return {
    productGitHead: report?.gitHead ?? null,
    flowId: report?.flowId ?? null,
    promptHashes: saffron?.promptHashes ?? null,
    fixtureVersion: saffron?.fixtureVersion ?? null,
    fixtureSha256: saffron?.fixtureSha256 ?? null,
    oracleSha256: saffron?.oracleSha256 ?? null,
    secretSeedSha256: saffron?.seedSha256 ?? (saffron?.seed ? sha256(saffron.seed) : null),
    sourceHashes: {
      extensions: (report?.resources?.extensions ?? []).map((entry) => ({ path: relativeRepoPath(entry.path), sha256: entry.sha256 })),
      skills: (report?.resources?.skill ?? []).map((entry) => ({ path: relativeRepoPath(entry.path), sha256: entry.sha256 })),
    },
    globalCommands: normalizeGlobalCommandInventory(report?.commands ?? []),
    pi: {
      realpath: report?.piBinary?.realpath ?? null,
      version: report?.piBinary?.version ?? null,
      binarySha256: report?.piBinary?.realpath ? fileHash(report.piBinary.realpath) : null,
    },
    fullEnv: audit ? {
      sanitizedSettingsSha256: audit.settings?.sanitizedSha256 ?? null,
      sanitizedPackagesSha256: audit.settings?.sanitizedPackagesSha256 ?? null,
      originalSettingsSha256: audit.settings?.originalSha256 ?? null,
      originalPackagesSha256: audit.settings?.originalPackagesSha256 ?? null,
      globalAgentsSha256: audit.globalAgents?.harness?.sha256 ?? null,
      rootConfigHashes: Object.fromEntries((audit.rootConfigs ?? []).map((entry) => [entry.name, entry.harness?.sha256 ?? null])),
    } : null,
    runtime: {
      contextWindow: configuredModel?.contextWindow ?? report?.contextWindow ?? null,
      maxTokens: configuredModel?.maxTokens ?? report?.maxTokensCap ?? null,
      model: report?.model ?? null,
      thinkingLevel: report?.thinkingLevel ?? null,
    },
  };
}

export function validateCellProvenance(cell, runtime, pinned) {
  const reasons = [];
  const arm = pinned?.fullEnv?.[String(cell.contextWindow)] ?? null;
  if (!runtime) reasons.push("runtime_provenance_missing");
  if (runtime && !pinned.headSha.startsWith(runtime.productGitHead ?? "(missing)")) reasons.push("product_head_mismatch");
  if (JSON.stringify(runtime?.promptHashes) !== JSON.stringify(pinned?.saffron?.promptHashes)) reasons.push("prompt_hash_mismatch");
  if (runtime?.fixtureVersion !== pinned?.saffron?.fixtureVersion) reasons.push("fixture_version_mismatch");
  if (runtime?.fixtureSha256 !== pinned?.saffron?.fixtureSha256) reasons.push("fixture_hash_mismatch");
  if (runtime?.oracleSha256 !== pinned?.saffron?.oracleSha256) reasons.push("oracle_hash_mismatch");
  if (runtime?.secretSeedSha256 !== pinned?.saffron?.secretSeedSha256) reasons.push("secret_seed_mismatch");
  const runtimeSources = [...(runtime?.sourceHashes?.extensions ?? []), ...(runtime?.sourceHashes?.skills ?? [])];
  const runtimeSourceMap = Object.fromEntries(runtimeSources.map((entry) => [entry.path, entry.sha256]));
  for (const expectedPath of [EXTENSION_PATH, CONTEXT_EXTENSION_PATH, INTEGRITY_GUARD_PATH, CONTEXT_MANAGEMENT_SKILL_PATH].map(relativeRepoPath)) {
    if (runtimeSourceMap[expectedPath] !== pinned?.sourceHashes?.[expectedPath]) reasons.push(`runtime_source_mismatch:${expectedPath}`);
  }
  for (const entry of runtimeSources) {
    if (pinned?.sourceHashes?.[entry.path] !== entry.sha256) reasons.push(`runtime_source_mismatch:${entry.path}`);
  }
  if (runtime?.pi?.version !== pinned?.pi?.version || runtime?.pi?.binarySha256 !== pinned?.pi?.binarySha256) reasons.push("pi_binary_mismatch");
  if (runtime?.globalCommands?.sha256 !== pinned?.globalCommands?.sha256) reasons.push("global_command_inventory_mismatch");
  if (runtime?.fullEnv?.sanitizedSettingsSha256 !== arm?.sanitizedSettingsSha256) reasons.push("sanitized_settings_mismatch");
  if (runtime?.fullEnv?.sanitizedPackagesSha256 !== arm?.sanitizedPackagesSha256) reasons.push("sanitized_packages_mismatch");
  if (runtime?.fullEnv?.globalAgentsSha256 !== arm?.globalAgentsSha256) reasons.push("global_agents_mismatch");
  if (JSON.stringify(runtime?.fullEnv?.rootConfigHashes) !== JSON.stringify(arm?.rootConfigHashes)) reasons.push("global_config_hash_mismatch");
  if (runtime?.runtime?.contextWindow !== cell.contextWindow) reasons.push("context_window_mismatch");
  if (runtime?.runtime?.maxTokens !== cell.maxTokensCap) reasons.push("max_tokens_mismatch");
  if (runtime?.runtime?.model?.provider !== cell.model.provider || runtime?.runtime?.model?.modelId !== cell.model.modelId) reasons.push("selected_model_mismatch");
  if (runtime?.runtime?.thinkingLevel !== cell.thinking) reasons.push("thinking_level_mismatch");
  return { valid: reasons.length === 0, reasons };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function compactMatrix(state) {
  const cells = Object.values(state.cells);
  const pairCandidates = MODEL_SPECS.map((model) => compareContextArms({
    pairKey: model.id,
    constrained400k: state.cells[`${model.id}-400k`],
    native1m: state.cells[`${model.id}-1m`],
  }));
  return {
    schemaVersion: LONG_FLOW_MATRIX_SCHEMA_VERSION,
    matrixId: state.manifest.id,
    generatedAt: new Date().toISOString(),
    status: state.status,
    outputDir: state.outputDir,
    piProvenance: state.piProvenance,
    pinnedProvenance: state.pinnedProvenance,
    preflightRuns: (state.preflightRuns ?? []).map((preflight) => ({
      reportPath: preflight.reportPath,
      reportSha256: preflight.reportSha256,
      commandInventorySha256: preflight.commandInventory?.sha256 ?? null,
    })),
    manifest: state.manifest,
    classifications: Object.fromEntries(["pending", "running", "certifying_run", "occupancy_miss", "infrastructure_invalid", "run_error", "task_failure", "coverage_insufficient"].map((kind) => [kind, cells.filter((cell) => (cell.classification ?? cell.status) === kind).length])),
    cells: cells.map((cell) => ({
      id: cell.id,
      pairKey: cell.pairKey,
      model: cell.model,
      thinking: cell.thinking,
      contextWindow: cell.contextWindow,
      maxTokensCap: cell.maxTokensCap,
      status: cell.status,
      classification: cell.classification ?? null,
      reason: cell.reason ?? null,
      attempts: cell.attempts,
      reportPath: cell.reportPath ?? null,
      telemetryPath: cell.telemetryPath ?? null,
      deterministicVerification: cell.report?.deterministicVerification ?? null,
      productGitHead: cell.provenance?.productGitHead ?? null,
      provenance: cell.provenance ?? null,
      provenanceCheck: cell.provenanceCheck ?? null,
      peak: cell.telemetry?.peak ?? null,
      crossedLevels: cell.telemetry?.coverage?.crossedLevels ?? [],
      reminderLevels: cell.telemetry?.coverage?.reminderLevels ?? [],
      integrity: cell.telemetry?.integrity ?? null,
    })),
    pairs: pairCandidates.filter((pair) => pair.comparable),
    unpaired: pairCandidates.filter((pair) => !pair.comparable),
  };
}

function markdown(compact) {
  return [
    `# Real Pi Saffron long-flow matrix: ${compact.matrixId}`,
    "",
    `- Generated: ${compact.generatedAt}`,
    `- Status: **${compact.status}**`,
    `- Pi: \`${compact.piProvenance.path}\` @ ${compact.piProvenance.version ?? "unavailable"} (expected ${compact.piProvenance.expectedProjectVersion ?? "unknown"})`,
    `- Fixed maxTokensCap: ${CONTROLLED_MAX_TOKENS}`,
    "",
    "| Cell | Model / effort | Hard window | Cap | Classification | Deterministic verify | Peak hard / pressure | Crossed | Reminders |",
    "| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |",
    ...compact.cells.map((cell) => `| ${cell.id} | ${cell.model.provider}/${cell.model.modelId} : ${cell.thinking} | ${cell.contextWindow} | ${cell.maxTokensCap} | ${cell.classification ?? cell.status} | ${cell.deterministicVerification?.passed === undefined ? "—" : cell.deterministicVerification.passed ? "pass" : "FAIL"} | ${cell.peak?.hardUsagePercent?.toFixed?.(1) ?? "—"}% / ${cell.peak?.pressurePercent?.toFixed?.(1) ?? "—"}% | ${(cell.crossedLevels ?? []).join(",") || "—"} | ${(cell.reminderLevels ?? []).join(",") || "—"} |`),
    "",
    "## 400K vs 1M paired cards",
    "",
    ...compact.pairs.flatMap((pair) => [
      `### ${pair.pairKey}`,
      "",
      `- 400K: ${pair.constrained400k.classification ?? "pending"}; hard=${pair.constrained400k.hardUsagePercent ?? "—"}%, pressure=${pair.constrained400k.pressurePercent ?? "—"}%`,
      `- 1M: ${pair.native1m.classification ?? "pending"}; hard=${pair.native1m.hardUsagePercent ?? "—"}%, pressure=${pair.native1m.pressurePercent ?? "—"}%`,
      `- ${pair.interpretation}`,
      "",
    ]),
    ...(compact.unpaired.length === 0 ? [] : [
      "## Unpaired arms",
      "",
      ...compact.unpaired.map((pair) => `- ${pair.pairKey}: ${pair.mismatchReasons.join(", ")}`),
      "",
    ]),
  ].join("\n");
}

function writeArtifacts(outputDir, state) {
  const compact = compactMatrix(state);
  writeJsonAtomic(join(outputDir, stateFileName), state);
  writeJsonAtomic(join(outputDir, compactFileName), compact);
  writeFileSync(join(outputDir, markdownFileName), markdown(compact));
  return compact;
}

function selectCells(manifest, { ids, arm }) {
  if (arm !== undefined && arm !== "400k" && arm !== "1m") throw new Error("--arm must be 400k or 1m");
  const unknown = ids.filter((id) => !manifest.cells.some((cell) => cell.id === id));
  if (unknown.length) throw new Error(`unknown --cell: ${unknown.join(", ")}`);
  return manifest.cells.filter((cell) => {
    const idMatch = ids.length === 0 || ids.includes(cell.id);
    const armMatch = arm === undefined || (arm === "400k" ? cell.contextWindow === 400_000 : cell.contextWindow === 1_000_000);
    return idMatch && armMatch;
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  }));
}

async function executeCell(cell, options, pinnedProvenance) {
  const child = await runFlowChild({ cell, options });
  const reportedPath = reportPathFromOutput(`${child.stdout}\n${child.stderr}`);
  const reportPath = reportedPath && existsSync(reportedPath) ? reportedPath : null;
  if (!reportPath) {
    const report = {
      status: "run_error",
      runError: child.error ?? (child.signal ? `run-flow terminated by ${child.signal}` : `run-flow produced no readable report (exit ${child.exitCode ?? "unknown"})`),
      fullEnv: true,
      contextWindow: cell.contextWindow,
      maxTokensCap: cell.maxTokensCap,
      deterministicVerification: null,
    };
    const telemetry = collectFlowTelemetry({ report, contextWindow: cell.contextWindow, integrity: { audit: { present: false } } });
    return { child, report, telemetry, reportPath: null, telemetryPath: null, provenance: null, provenanceCheck: { valid: false, reasons: ["run_report_missing"] } };
  }
  const report = readJson(reportPath);
  const runDir = dirname(reportPath);
  const eventsPath = join(runDir, "events.jsonl");
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\n").flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    })
    : [];
  const telemetry = collectFlowTelemetry({
    events,
    report,
    sessionEntries: readSessionEntries(join(runDir, "sessions")),
    contextWindow: cell.contextWindow,
    integrity: integrityFromReport(report),
    target: { provider: cell.model.provider, modelId: cell.model.modelId, thinking: cell.thinking },
  });
  const provenance = runtimeCellProvenance(report, runDir);
  const provenanceCheck = validateCellProvenance(cell, provenance, pinnedProvenance);
  const telemetryPath = join(runDir, "telemetry.json");
  writeFileSync(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`);
  return { child, report, telemetry, reportPath, telemetryPath, provenance, provenanceCheck };
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(usage());
    return;
  }
  const execute = flag("--execute");
  const concurrency = Number(option("--concurrency") ?? "4");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4");
  const timeoutScale = Number(option("--timeout-scale") ?? "1");
  if (!Number.isFinite(timeoutScale) || timeoutScale <= 0) throw new Error("--timeout-scale must be positive");
  const arm = option("--arm");
  const resume = option("--resume");
  const output = option("--output");
  const suppliedFlowSeed = option("--flow-seed") ?? process.env.ACM_FLOW_SEED;
  if (execute && !suppliedFlowSeed) throw new Error("--execute requires --flow-seed or ACM_FLOW_SEED");
  if (resume && output) throw new Error("--resume and --output are mutually exclusive");
  const flowId = option("--flow") ?? DEFAULT_FLOW_ID;
  const newMatrixRunId = resume ? null : generateMatrixRunId();
  const outputDir = resume
    ? asAbsolute(resume)
    : output
      ? asAbsolute(output)
      : join(RUNS_DIR, `saffron-flow-matrix-${timestampLabel()}-${newMatrixRunId}`);
  mkdirSync(outputDir, { recursive: true });
  const lockPath = acquireMatrixLock(outputDir, { recoverStale: flag("--recover-stale-lock") });
  try {
    const statePath = join(outputDir, stateFileName);
    let state;
    let manifest;
    let pinnedProvenance;
    let secretSeed;
    if (resume) {
      if (!existsSync(statePath)) throw new Error(`no matrix state to resume: ${statePath}`);
      state = readJson(statePath);
      if (!state.secretSeedSha256 || !state.matrixRunId || !state.pinnedProvenance) {
        throw new Error("resume state lacks secretSeedSha256, matrixRunId, or pinnedProvenance");
      }
      assertResumeSeed(state.secretSeedSha256, suppliedFlowSeed);
      secretSeed = suppliedFlowSeed;
      manifest = createLongFlowMatrixManifest({ flowId, matrixRunId: state.matrixRunId });
      if (JSON.stringify(state.manifest) !== JSON.stringify(manifest)) throw new Error("resume manifest differs from this runner's fixed declaration");
      const baseProvenance = collectPinnedProvenance({ secretSeed, matrixRunId: state.matrixRunId });
      assertPiProvenance(baseProvenance.pi);
      const rehashedCommands = rehashGlobalCommandInventory(state.pinnedProvenance.globalCommands);
      const originalPreflight = state.pinnedProvenance.preflight;
      const rehashedPreflight = {
        ...originalPreflight,
        reportSha256: originalPreflight?.reportPath ? fileHash(originalPreflight.reportPath) : null,
      };
      const recomputedPinned = {
        ...baseProvenance,
        globalCommands: rehashedCommands,
        preflight: rehashedPreflight,
      };
      assertPinnedProvenance(state.pinnedProvenance, recomputedPinned);
      const resumePreflight = await runAuditPreflight({
        manifest,
        secretSeed,
        piBinary: baseProvenance.pi.path,
        timeoutScale,
      });
      if (resumePreflight.commandInventory.sha256 !== state.pinnedProvenance.globalCommands.sha256) {
        throw new Error("resume global command inventory mismatch");
      }
      state.preflightRuns = [...(state.preflightRuns ?? []), resumePreflight];
      pinnedProvenance = state.pinnedProvenance;
      for (const cell of Object.values(state.cells)) if (cell.status === "running") cell.status = "pending";
    } else {
      if (existsSync(statePath)) throw new Error(`output already contains ${stateFileName}; use --resume`);
      secretSeed = suppliedFlowSeed ?? generateMatrixSecret();
      manifest = createLongFlowMatrixManifest({ flowId, matrixRunId: newMatrixRunId });
      const baseProvenance = collectPinnedProvenance({ secretSeed, matrixRunId: newMatrixRunId });
      assertPiProvenance(baseProvenance.pi);
      const preflight = await runAuditPreflight({
        manifest,
        secretSeed,
        piBinary: baseProvenance.pi.path,
        timeoutScale,
      });
      pinnedProvenance = {
        ...baseProvenance,
        globalCommands: preflight.commandInventory,
        preflight: { reportPath: preflight.reportPath, reportSha256: preflight.reportSha256 },
      };
      state = createInitialMatrixState({
        manifest,
        outputDir,
        matrixRunId: newMatrixRunId,
        secretSeedSha256: sha256(secretSeed),
        pinnedProvenance,
        piProvenance: pinnedProvenance.pi,
      });
      state.preflightRuns = [preflight];
      if (!suppliedFlowSeed) {
        console.log("matrix seed is ephemeral and only its hash is persisted; resume requires starting a new matrix unless --flow-seed was supplied");
      }
    }
    state.status = execute ? "running" : "planned";
    const selected = selectCells(manifest, { ids: repeatedOptions("--cell"), arm });
    writeArtifacts(outputDir, state);
    console.log(`matrix=${manifest.id} cells=${selected.length} output=${outputDir}`);
    if (!execute) {
      console.log("Preview only: no providers started. Add --execute to launch.");
      return;
    }
    assertPiProvenance(pinnedProvenance.pi);
    const options = {
      timeoutScale,
      doJudge: !flag("--no-judge"),
      judgeModel: option("--judge-model"),
      judgeThinking: option("--judge-thinking"),
      piBinary: pinnedProvenance.pi.path,
      secretSeed,
    };
    // Running arms sequentially avoids interleaving the comparative rounds while
    // retaining up to four independent model cells per arm.
    for (const contextWindow of CONTROLLED_WINDOWS) {
      const armCells = selected
        .filter((cell) => cell.contextWindow === contextWindow)
        .map((cell) => state.cells[cell.id])
        .filter((cell) => flag("--retry-all") || !shouldSkipMatrixCell(cell));
      if (armCells.length === 0) continue;
      console.log(`arm=${contextWindow} launching=${armCells.length} concurrency=${concurrency}`);
      await runWithConcurrency(armCells, concurrency, async (cell) => {
        cell.status = "running";
        cell.attempts += 1;
        cell.startedAt = new Date().toISOString();
        writeArtifacts(outputDir, state);
        console.log(`START ${cell.id}`);
        const result = await executeCell(cell, options, pinnedProvenance);
        cell.report = result.report;
        cell.telemetry = result.telemetry;
        cell.reportPath = result.reportPath;
        cell.telemetryPath = result.telemetryPath;
        cell.provenance = result.provenance;
        cell.provenanceCheck = result.provenanceCheck;
        cell.child = { exitCode: result.child.exitCode, signal: result.child.signal, error: result.child.error, stderr: result.child.stderr.slice(-2_000) };
        Object.assign(cell, result.provenanceCheck.valid
          ? classifyFlowEvidence({ report: result.report, telemetry: result.telemetry })
          : { classification: "infrastructure_invalid", reason: `runtime_provenance_mismatch:${result.provenanceCheck.reasons.join(",")}` });
        cell.status = "completed";
        cell.finishedAt = new Date().toISOString();
        writeArtifacts(outputDir, state);
        console.log(`DONE ${cell.id} -> ${cell.classification}`);
      });
    }
    state.status = finalMatrixStatus(state);
    writeArtifacts(outputDir, state);
    console.log(`report=${join(outputDir, compactFileName)}`);
    console.log(`markdown=${join(outputDir, markdownFileName)}`);
  } finally {
    releaseMatrixLock(lockPath);
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
