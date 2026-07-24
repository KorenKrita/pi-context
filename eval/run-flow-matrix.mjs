#!/usr/bin/env bun
// Resumable orchestration for the real-Pi Saffron long-flow comparison.
//
// This runner intentionally delegates each cell to run-flow.mjs. That keeps
// flow materialization, host actions, compaction, deterministic verification,
// resource audit, and session semantics in the one production evaluation path.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
  buildAgentsOnlyAgentDir,
  buildFullEnvAgentDir,
  readAgentsOnlyHarnessAudit,
  readFullEnvHarnessAudit,
} from "./setup.mjs";

export const LONG_FLOW_MATRIX_SCHEMA_VERSION = 10;
export const CONTROLLED_MAX_TOKENS = 16_000;
export const CONTROLLED_WINDOWS = Object.freeze([400_000, 1_000_000]);
export const DEFAULT_FLOW_ID = "saffron-cutover-long-flow-v1";
export const CONTROLLED_ENVIRONMENT_MODE = "agents-only";
export const DEFAULT_MATRIX_PROFILE = "full";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const stateFileName = "matrix-state.json";
const compactFileName = "matrix-report.json";
const markdownFileName = "matrix-report.md";
const lockFileName = ".matrix.lock";
const sourceSnapshotDirName = ".agents-only-source";
const DEFAULT_SOURCE_AGENT_DIR = join(homedir(), ".pi", "agent");
const INTEGRITY_GUARD_PATH = join(repoRoot, "eval", "integrity-guard.mjs");
const FULL_ENV_LINKED_RESOURCE_ROOTS = Object.freeze(["git", "npm", "extensions", "skills", "themes", "agents", "bin"]);
const CONTENT_TREE_IGNORED_BASENAMES = Object.freeze(new Set([".DS_Store"]));
const PINNED_SOURCE_FILES = Object.freeze([
  EXTENSION_PATH,
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  join(repoRoot, "eval", "run-flow.mjs"),
  join(repoRoot, "eval", "flow.mjs"),
  join(repoRoot, "eval", "saffron-flow.mjs"),
  join(repoRoot, "eval", "saffron-verifier.mjs"),
  join(repoRoot, "eval", "saffron-workspace-probe.mjs"),
  INTEGRITY_GUARD_PATH,
]);
const FULL_ENV_SOURCE_CONFIG_FILES = Object.freeze([
  "settings.json",
  "models.json",
  "auth.json",
  "AGENTS.md",
  "thinking-presets.json",
  "subagents-lite.json",
  "pi.env",
]);
const AGENTS_ONLY_SOURCE_INPUT_FILES = Object.freeze([
  "models.json",
  "auth.json",
  "AGENTS.md",
]);

const MODEL_SPECS = Object.freeze([
  { id: "opus-4-6-max", provider: "local-claude", modelId: "claude-opus-4-6", thinking: "max" },
  { id: "opus-4-8-high", provider: "local-claude", modelId: "claude-opus-4-8", thinking: "high" },
  { id: "terra-high", provider: "local-responses", modelId: "gpt-5.6-terra", thinking: "high" },
  { id: "sol-medium", provider: "local-responses", modelId: "gpt-5.6-sol", thinking: "medium" },
]);
const MATRIX_PROFILES = Object.freeze({
  full: Object.freeze(MODEL_SPECS.map((model) => model.id)),
  "core-2x2": Object.freeze(["opus-4-8-high", "sol-medium"]),
});

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
    "usage: bun eval/run-flow-matrix.mjs [--execute] [--profile full|core-2x2] [--concurrency 4] [--output DIR] [--resume DIR] [--flow-seed SECRET] [--recover-stale-lock] [--arm 400k|1m] [--cell ID] [--no-judge] [--timeout-scale N]",
    "",
    "Profiles: full = Sol medium, Terra high, Opus 4.6 max, Opus 4.8 high; core-2x2 = Sol medium + Opus 4.8 high. Every selected model runs at 400K and 1M hard windows.",
    "Cells run through eval/run-flow.mjs using agents-only kernel isolation, Saffron materialization, local Pi, and maxTokensCap=16000.",
  ].join("\n");
}

function modelSpecsForProfile(profile) {
  const modelIds = MATRIX_PROFILES[profile];
  if (!modelIds) throw new Error(`unknown --profile: ${profile}`);
  return MODEL_SPECS.filter((model) => modelIds.includes(model.id));
}

export function createLongFlowMatrixManifest({ flowId = DEFAULT_FLOW_ID, matrixRunId = "preview", profile = DEFAULT_MATRIX_PROFILE } = {}) {
  const cells = modelSpecsForProfile(profile).flatMap((model) => CONTROLLED_WINDOWS.map((contextWindow) => ({
    id: `${model.id}-${contextWindow === 400_000 ? "400k" : "1m"}`,
    pairKey: model.id,
    matrixRunId,
    model: { provider: model.provider, modelId: model.modelId },
    thinking: model.thinking,
    contextWindow,
    maxTokensCap: CONTROLLED_MAX_TOKENS,
    environmentMode: CONTROLLED_ENVIRONMENT_MODE,
    flowId,
    agentLabel: `acm-saffron-${matrixRunId}-${model.id}-${contextWindow}`,
  })));
  return {
    schemaVersion: LONG_FLOW_MATRIX_SCHEMA_VERSION,
    id: `acm-real-pi-saffron-400k-vs-1m-${matrixRunId}`,
    matrixRunId,
    profile,
    flowId,
    environmentMode: CONTROLLED_ENVIRONMENT_MODE,
    controlledDimensions: {
      hardContextWindow: CONTROLLED_WINDOWS,
      maxTokensCap: CONTROLLED_MAX_TOKENS,
      piBinary: "repo-node-modules",
      piContextSource: "current-worktree",
      sessionRecall: "absent_by_agents_only_harness_and_runtime_audit",
      isolation: "darwin_outer_and_nested_tool_seatbelt_with_exclusive_lock",
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

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayTreePath(path) {
  return path.replaceAll(sep, "/");
}

function pathIsInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function treeError(label, path, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`${label} content tree cannot certify ${path}: ${reason}`);
}

function lstatTreeNode(label, path) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw treeError(label, path, error);
  }
}

function treeNodeKind(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "dir";
  if (stat.isSymbolicLink()) return "symlink";
  return null;
}

function hashContentTreeRoot({ name, path, boundaryPath = path }) {
  const label = `content tree root ${name}`;
  let boundary;
  try {
    boundary = realpathSync(boundaryPath);
  } catch (error) {
    throw treeError(label, boundaryPath, error);
  }
  const entries = [];

  const visit = (nodePath, nodeName) => {
    const stat = lstatTreeNode(label, nodePath);
    const kind = treeNodeKind(stat);
    if (!kind) throw new Error(`${label} rejects special node ${nodePath}`);
    const normalizedName = displayTreePath(nodeName);
    const mode = stat.mode & 0o777;
    if (kind === "file") {
      let content;
      try {
        content = readFileSync(nodePath);
      } catch (error) {
        throw treeError(label, nodePath, error);
      }
      entries.push({ path: normalizedName, kind, mode, sha256: sha256(content) });
      return;
    }
    if (kind === "symlink") {
      let target;
      let resolved;
      try {
        target = readlinkSync(nodePath);
        resolved = realpathSync(nodePath);
      } catch (error) {
        throw treeError(label, nodePath, error);
      }
      if (!pathIsInside(boundary, resolved)) {
        throw new Error(`${label} rejects symlink escaping its root: ${nodePath} -> ${target}`);
      }
      const targetStat = lstatTreeNode(label, resolved);
      const targetKind = treeNodeKind(targetStat);
      if (!targetKind) throw new Error(`${label} rejects symlink to special node ${nodePath} -> ${target}`);
      entries.push({
        path: normalizedName,
        kind,
        mode,
        target,
        resolved: displayTreePath(relative(boundary, resolved) || "."),
        targetKind,
      });
      return;
    }
    let names;
    try {
      names = readdirSync(nodePath)
        .filter((entry) => !CONTENT_TREE_IGNORED_BASENAMES.has(entry))
        .sort(stableCompare);
    } catch (error) {
      throw treeError(label, nodePath, error);
    }
    entries.push({ path: normalizedName, kind, mode });
    for (const childName of names) visit(join(nodePath, childName), join(nodeName, childName));
  };

  visit(path, ".");
  const root = {
    name,
    path,
    boundaryPath,
    realpath: boundary,
    entryCount: entries.length,
    sha256: sha256(JSON.stringify(entries)),
  };
  return root;
}

/**
 * Fingerprint an auditable content tree without trusting only command discovery.
 * Files contribute bytes and modes; directories and symlinks keep their own
 * identity. Exact OS metadata basenames that cannot affect execution are
 * excluded; all other files remain fail-closed. Symlinks are never traversed
 * and an escape from the declared root is a hard failure, so a link cannot
 * quietly import mutable outside content.
 */
export function hashContentTree(roots) {
  if (!Array.isArray(roots)) throw new Error("content tree roots must be an array");
  const names = new Set();
  const normalizedRoots = roots.map((root) => {
    if (!root?.name || !root?.path) throw new Error("content tree root requires name and path");
    if (names.has(root.name)) throw new Error(`content tree has duplicate root name: ${root.name}`);
    names.add(root.name);
    return {
      name: root.name,
      path: root.path,
      boundaryPath: root.boundaryPath ?? root.path,
    };
  }).sort((left, right) => stableCompare(left.name, right.name));
  const treeRoots = normalizedRoots.map(hashContentTreeRoot);
  const tree = {
    schemaVersion: 1,
    roots: treeRoots,
  };
  return { ...tree, sha256: sha256(JSON.stringify(tree)) };
}

export function rehashContentTree(pinnedTree) {
  if (!pinnedTree?.roots) throw new Error("pinned content tree is missing roots");
  return hashContentTree(pinnedTree.roots.map((root) => ({
    name: root.name,
    path: root.path,
    boundaryPath: root.boundaryPath,
  })));
}

export function hashFullEnvLinkedResourceTree(fullEnvAudit) {
  const linked = fullEnvAudit?.linkedDirectories;
  if (!Array.isArray(linked)) throw new Error("full-env audit lacks linkedDirectories");
  const byName = new Map(linked.map((entry) => [entry?.name, entry]));
  const roots = FULL_ENV_LINKED_RESOURCE_ROOTS.map((name) => {
    const entry = byName.get(name);
    if (!entry?.source || !entry?.target) throw new Error(`full-env audit lacks linked ${name} resource root`);
    const target = lstatTreeNode(`full-env linked root ${name}`, entry.target);
    if (!target.isSymbolicLink()) throw new Error(`full-env audit ${name} target is not a symlink: ${entry.target}`);
    let sourceRealpath;
    let targetRealpath;
    try {
      sourceRealpath = realpathSync(entry.source);
      targetRealpath = realpathSync(entry.target);
    } catch (error) {
      throw treeError(`full-env linked root ${name}`, entry.source, error);
    }
    if (sourceRealpath !== targetRealpath) {
      throw new Error(`full-env audit ${name} target does not resolve to its recorded source`);
    }
    return { name, path: entry.source, boundaryPath: entry.source };
  });
  return hashContentTree(roots);
}

function linkedFullEnvRootRealpaths(fullEnvAudit) {
  const linked = fullEnvAudit?.linkedDirectories;
  if (!Array.isArray(linked)) throw new Error("full-env audit lacks linkedDirectories");
  const byName = new Map(linked.map((entry) => [entry?.name, entry]));
  return FULL_ENV_LINKED_RESOURCE_ROOTS.map((name) => {
    const source = byName.get(name)?.source;
    if (!source) throw new Error(`full-env audit lacks linked ${name} resource root`);
    try {
      return realpathSync(source);
    } catch (error) {
      throw treeError(`full-env linked root ${name}`, source, error);
    }
  });
}

function commandSourceRealpath(command) {
  const path = command?.sourceInfo?.path;
  if (typeof path !== "string" || path.length === 0) return null;
  try {
    return realpathSync(path);
  } catch (error) {
    throw treeError(`advertised ${command?.source ?? "command"} resource`, path, error);
  }
}

function externalCommandResourceRoots(commands, fullEnvAudit) {
  const linkedRoots = linkedFullEnvRootRealpaths(fullEnvAudit);
  const candidates = [];
  for (const command of commands ?? []) {
    if ((command?.source !== "skill" && command?.source !== "extension") || command?.sourceInfo?.scope === "temporary") continue;
    const sourcePath = commandSourceRealpath(command);
    if (sourcePath === null || linkedRoots.some((root) => pathIsInside(root, sourcePath))) continue;
    if (command.source === "skill") {
      const skillDir = dirname(sourcePath);
      candidates.push({ kind: "skill", path: skillDir, boundaryPath: skillDir });
      continue;
    }
    const declaredBase = command.sourceInfo?.baseDir;
    let baseDir = null;
    if (typeof declaredBase === "string" && declaredBase.length > 0) {
      try {
        const resolvedBase = realpathSync(declaredBase);
        if (pathIsInside(resolvedBase, sourcePath)) baseDir = resolvedBase;
      } catch {
        // baseDir is optional source metadata; preserve the direct-file fallback.
      }
    }
    candidates.push(baseDir === null
      ? { kind: "extension-file", path: sourcePath, boundaryPath: dirname(sourcePath) }
      : { kind: "extension-base", path: baseDir, boundaryPath: baseDir });
  }
  candidates.sort((left, right) => stableCompare(JSON.stringify(left), JSON.stringify(right)));
  const roots = [];
  const seenPaths = new Set();
  for (const candidate of candidates) {
    const identity = `${candidate.path}\u0000${candidate.boundaryPath}`;
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    roots.push({
      name: `${candidate.kind}:${displayTreePath(candidate.path)}`,
      path: candidate.path,
      boundaryPath: candidate.boundaryPath,
    });
  }
  return roots;
}

/**
 * Hash model-visible resources that are advertised by get_commands yet sit
 * outside the audited full-env linked roots. Skills use their own directory
 * (so references and scripts travel with SKILL.md); external extensions use a
 * usable package/baseDir and otherwise fall back to the advertised file.
 */
export function hashExternalCommandResourceTree(commands, fullEnvAudit) {
  return hashContentTree(externalCommandResourceRoots(commands, fullEnvAudit));
}

export function hashRepoLocalPiRuntimeTree({ nodeModules = join(repoRoot, "node_modules") } = {}) {
  return hashContentTree([
    // Pi resolves hoisted runtime packages such as openai, typebox, and yaml
    // directly from this root, not only from @earendil-works subtrees.
    { name: "node_modules", path: nodeModules, boundaryPath: nodeModules },
    { name: "pi-wrapper", path: join(nodeModules, ".bin", "pi"), boundaryPath: nodeModules },
  ]);
}

export function bunRuntimeProvenance({ executable = process.execPath } = {}) {
  let realpath;
  let version;
  try {
    realpath = realpathSync(executable);
    version = execFileSync(realpath, ["--version"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw treeError("Bun runtime", executable, error);
  }
  return {
    realpath,
    version,
    binarySha256: fileHash(realpath),
    binaryTree: hashContentTree([{
      name: "bun-executable",
      path: realpath,
      boundaryPath: dirname(realpath),
    }]),
  };
}

function bunRuntimeMatches(expected, actual) {
  return expected?.realpath === actual?.realpath
    && expected?.version === actual?.version
    && expected?.binarySha256 === actual?.binarySha256
    && expected?.binaryTree?.sha256 === actual?.binaryTree?.sha256;
}

function captureContentTree(makeTree) {
  try {
    return { tree: makeTree(), error: null };
  } catch (error) {
    return { tree: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyPinnedRuntimeTrees(pinnedProvenance) {
  const reasons = [];
  const globalResources = captureContentTree(() => rehashContentTree(pinnedProvenance?.globalResourceTree));
  const externalCommandResources = captureContentTree(() => rehashContentTree(pinnedProvenance?.externalCommandResourceTree));
  const piRuntime = captureContentTree(() => rehashContentTree(pinnedProvenance?.piRuntimeTree));
  const bunRuntime = captureContentTree(bunRuntimeProvenance);
  if (globalResources.error) reasons.push(`global_resource_tree_unavailable:${globalResources.error}`);
  else if (globalResources.tree.sha256 !== pinnedProvenance?.globalResourceTree?.sha256) reasons.push("global_resource_tree_mismatch");
  if (externalCommandResources.error) reasons.push(`external_command_resource_tree_unavailable:${externalCommandResources.error}`);
  else if (externalCommandResources.tree.sha256 !== pinnedProvenance?.externalCommandResourceTree?.sha256) reasons.push("external_command_resource_tree_mismatch");
  if (piRuntime.error) reasons.push(`pi_runtime_tree_unavailable:${piRuntime.error}`);
  else if (piRuntime.tree.sha256 !== pinnedProvenance?.piRuntimeTree?.sha256) reasons.push("pi_runtime_tree_mismatch");
  if (bunRuntime.error) reasons.push(`bun_runtime_unavailable:${bunRuntime.error}`);
  else if (!bunRuntimeMatches(pinnedProvenance?.bunRuntime, bunRuntime.tree)) reasons.push("bun_runtime_mismatch");
  return { valid: reasons.length === 0, reasons, globalResources, externalCommandResources, piRuntime, bunRuntime };
}

export function assertCleanGitWorktree({ cwd = repoRoot, execFileSyncImpl = execFileSync } = {}) {
  let status;
  try {
    status = execFileSyncImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`matrix execution requires a verifiable clean Git worktree: ${reason}`);
  }
  if (status.trim()) {
    throw new Error(`matrix execution requires a clean Git worktree, including non-ignored untracked files:\n${status.trim()}`);
  }
}

/**
 * Recheck the exact checkout contract around every provider child. The source
 * list deliberately includes late-loaded verifier/judge/driver modules, so a
 * run cannot be certified after a mid-cell edit or commit changed its code.
 */
export function verifyPinnedCheckout(pinnedProvenance, {
  cwd = repoRoot,
  execFileSyncImpl = execFileSync,
  sourceFiles = PINNED_SOURCE_FILES,
  hashFile = fileHash,
} = {}) {
  const reasons = [];
  let worktreeStatus = null;
  let currentHeadSha = null;
  try {
    worktreeStatus = execFileSyncImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" });
    if (worktreeStatus.trim()) reasons.push("git_worktree_dirty");
  } catch (error) {
    reasons.push(`git_worktree_unverifiable:${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    currentHeadSha = execFileSyncImpl("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    if (currentHeadSha !== pinnedProvenance?.headSha) reasons.push("git_head_mismatch");
  } catch (error) {
    reasons.push(`git_head_unverifiable:${error instanceof Error ? error.message : String(error)}`);
  }
  const sourceHashes = {};
  for (const sourcePath of sourceFiles) {
    const key = relativeRepoPath(sourcePath);
    let actualHash;
    try {
      actualHash = hashFile(sourcePath);
    } catch (error) {
      reasons.push(`pinned_source_unreadable:${key}:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    sourceHashes[key] = actualHash;
    if (actualHash !== pinnedProvenance?.sourceHashes?.[key]) reasons.push(`pinned_source_mismatch:${key}`);
  }
  return { valid: reasons.length === 0, reasons, currentHeadSha, worktreeStatus, sourceHashes };
}

export function mergeCheckoutProvenanceCheck(provenanceCheck, checkout, phase) {
  const base = provenanceCheck ?? { valid: false, reasons: ["runtime_provenance_missing"] };
  const checks = { ...(base.checkout ?? {}), [phase]: checkout };
  if (checkout?.valid) return { ...base, checkout: checks };
  return {
    ...base,
    valid: false,
    reasons: [...(base.reasons ?? []), ...(checkout?.reasons ?? ["checkout_verification_missing"]).map((reason) => `checkout_${phase}:${reason}`)],
    checkout: checks,
  };
}

export function assertMatrixWorktreeClean({ execute = false, resume = false, assertClean = assertCleanGitWorktree } = {}) {
  if (execute || resume) assertClean();
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

function configHashes(sourceAgentDir, names = FULL_ENV_SOURCE_CONFIG_FILES) {
  return Object.fromEntries(names.map((name) => [name, fileHash(join(sourceAgentDir, name))]));
}

export function agentsOnlySourceConfigHashes(sourceAgentDir) {
  return configHashes(sourceAgentDir, AGENTS_ONLY_SOURCE_INPUT_FILES);
}

export function createAgentsOnlySourceSnapshot({
  sourceAgentDir = DEFAULT_SOURCE_AGENT_DIR,
  snapshotDir,
} = {}) {
  if (!snapshotDir) throw new Error("agents-only source snapshot requires snapshotDir");
  if (existsSync(snapshotDir)) throw new Error(`agents-only source snapshot already exists: ${snapshotDir}`);
  mkdirSync(snapshotDir, { mode: 0o700 });
  try {
    for (const name of AGENTS_ONLY_SOURCE_INPUT_FILES) {
      const source = join(sourceAgentDir, name);
      if (!existsSync(source)) {
        if (name === "models.json") throw new Error(`agents-only source snapshot requires ${source}`);
        continue;
      }
      writeFileSync(join(snapshotDir, name), readFileSync(source), { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
  const path = realpathSync(snapshotDir);
  return { path, hashes: agentsOnlySourceConfigHashes(path) };
}

export function assertPinnedSourceSnapshot(pinnedProvenance, snapshotDir) {
  if (pinnedProvenance?.environmentMode !== "agents-only") return;
  if (!pinnedProvenance?.sourceAgentSnapshot) {
    throw new Error("agents-only matrix state lacks source-agent snapshot provenance; cannot resume");
  }
  if (!existsSync(snapshotDir)) {
    throw new Error(`source-agent snapshot missing from matrix output: ${snapshotDir}; restore the output or start a new matrix`);
  }
  const actualPath = realpathSync(snapshotDir);
  if (actualPath !== pinnedProvenance.sourceAgentSnapshot.path) {
    throw new Error(`source-agent snapshot path mismatch: expected ${pinnedProvenance.sourceAgentSnapshot.path}, got ${actualPath}`);
  }
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

function agentsOnlyPin(matrixRunId, sourceAgentDir = DEFAULT_SOURCE_AGENT_DIR) {
  const arms = {};
  for (const contextWindow of CONTROLLED_WINDOWS) {
    const agentDir = buildAgentsOnlyAgentDir({
      contextWindow,
      maxTokensCap: CONTROLLED_MAX_TOKENS,
      shrink: true,
      label: `matrix-agents-pin-${matrixRunId}-${contextWindow}`,
      sourceAgentDir,
    });
    const audit = readAgentsOnlyHarnessAudit(agentDir);
    arms[String(contextWindow)] = {
      settingsSha256: audit.settings?.harness?.sha256 ?? null,
      modelsSha256: audit.models?.harness?.sha256 ?? null,
      sourceModelsSha256: audit.models?.source?.sha256 ?? null,
      authSha256: audit.auth?.harness?.sha256 ?? null,
      sourceAuthSha256: audit.auth?.source?.sha256 ?? null,
      globalAgentsSha256: audit.globalAgents?.harness?.sha256 ?? null,
      excludedAmbientResources: audit.excludedAmbientResources ?? [],
      sessionRecall: audit.sessionRecall ?? null,
    };
    if (!arms.sourceConfigHashes) arms.sourceConfigHashes = agentsOnlySourceConfigHashes(audit.sourceAgentDir);
  }
  return arms;
}

export function collectPinnedProvenance({
  secretSeed,
  matrixRunId,
  saffronOptions,
  environmentMode = CONTROLLED_ENVIRONMENT_MODE,
  sourceAgentDir = DEFAULT_SOURCE_AGENT_DIR,
} = {}) {
  if (!secretSeed || !matrixRunId) throw new Error("secretSeed and matrixRunId are required for pinned provenance");
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const pi = piProvenance();
  return {
    headSha,
    sourceHashes: Object.fromEntries(PINNED_SOURCE_FILES.map((path) => [relativeRepoPath(path), fileHash(path)])),
    saffron: buildSaffronPin(secretSeed, saffronOptions),
    pi: { ...pi, binarySha256: fileHash(pi.path) },
    environmentMode,
    ...(environmentMode === "agents-only"
      ? {
        agentsOnly: agentsOnlyPin(matrixRunId, sourceAgentDir),
        sourceAgentSnapshot: {
          path: realpathSync(sourceAgentDir),
          hashes: agentsOnlySourceConfigHashes(sourceAgentDir),
        },
      }
      : { fullEnv: fullEnvPin(matrixRunId) }),
    controlled: { contextWindows: CONTROLLED_WINDOWS, maxTokensCap: CONTROLLED_MAX_TOKENS },
  };
}

export function assertPinnedProvenance(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("resume provenance mismatch: HEAD, prompts, fixture, Pi, environment configuration, or resource trees changed");
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
  sourceAgentDir,
} = {}) {
  const environmentArgs = cell.environmentMode === "agents-only"
    ? ["--environment-mode", "agents-only"]
    : ["--full-env"];
  const args = [
    "eval/run-flow.mjs",
    ...environmentArgs,
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
  if (sourceAgentDir) args.push("--source-agent-dir", sourceAgentDir);
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

export async function runAuditPreflight({
  manifest,
  secretSeed,
  piBinary,
  timeoutScale = 1,
  spawnImpl = spawn,
  bunBinary,
  collectPiRuntimeTree = hashRepoLocalPiRuntimeTree,
  collectBunRuntime = bunRuntimeProvenance,
  sourceAgentDir,
} = {}) {
  const cell = preflightCell(manifest);
  const child = await runFlowChild({
    cell,
    options: { timeoutScale, doJudge: false, auditOnly: true, piBinary, secretSeed, sourceAgentDir },
    spawnImpl,
    bunBinary,
  });
  const reportPath = reportPathFromOutput(`${child.stdout}\n${child.stderr}`);
  if (!reportPath || !existsSync(reportPath)) {
    throw new Error(`audit preflight produced no readable report: ${child.error ?? child.stderr ?? "unknown"}`);
  }
  const report = readJson(reportPath);
  if (report.agentsOnly && report.sandbox?.formalEvidenceEligible !== true) {
    report.status = "infrastructure_invalid";
    report.infrastructureInvalid = {
      status: "agents_only_sandbox_ineligible",
      reason: "agents-only report lacks kernel-enforced Seatbelt evidence",
      failures: [{
        status: "agents_only_sandbox_ineligible",
        reason: "agents-only report lacks kernel-enforced Seatbelt evidence",
      }],
    };
  }
  if (report.status !== "completed" || report.infrastructureInvalid) {
    throw new Error(`audit preflight failed: ${report.infrastructureInvalid?.reason ?? report.status}`);
  }
  const fullEnvAudit = report.resources?.fullEnvHarness ?? null;
  const agentsOnlyAudit = report.resources?.agentsOnlyHarness ?? null;
  const commands = report.commands ?? [];
  const isolatedResources = report.agentsOnly === true;
  if (isolatedResources && !agentsOnlyAudit) {
    throw new Error("audit preflight failed: agents-only harness audit missing");
  }
  return {
    reportPath,
    reportSha256: fileHash(reportPath),
    commandInventory: normalizeGlobalCommandInventory(commands),
    piBinary: report.piBinary ?? null,
    resources: report.resources ?? null,
    globalResourceTree: isolatedResources ? hashContentTree([]) : hashFullEnvLinkedResourceTree(fullEnvAudit),
    externalCommandResourceTree: isolatedResources ? hashContentTree([]) : hashExternalCommandResourceTree(commands, fullEnvAudit),
    piRuntimeTree: collectPiRuntimeTree(),
    bunRuntime: collectBunRuntime(),
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
  const agentsOnlyAudit = report?.resources?.agentsOnlyHarness ?? null;
  if (report?.agentsOnly) {
    return {
      sessionRecallPackagePresent: agentsOnlyAudit?.sessionRecall?.packagePresent === true,
      sessionRecallConfigPresent: agentsOnlyAudit?.sessionRecall?.configPresent === true,
      audit: agentsOnlyAudit === null ? { present: false } : {
        present: true,
        removedPackages: [],
        excludedFiles: agentsOnlyAudit.excludedAmbientResources ?? [],
        globalAgentsIncluded: agentsOnlyAudit.globalAgents?.source?.exists === true
          && agentsOnlyAudit.globalAgents?.harness?.exists === true
          && agentsOnlyAudit.globalAgents?.source?.sha256 === agentsOnlyAudit.globalAgents?.harness?.sha256,
      },
    };
  }
  const fullEnvAudit = report?.resources?.fullEnvHarness ?? null;
  const sanitized = fullEnvAudit?.settings?.sanitizedPackages ?? [];
  const identities = new Set(sanitized.map((entry) => entry?.identity));
  return {
    sessionRecallPackagePresent: identities.has("npm:@ogulcancelik/pi-session-recall"),
    sessionRecallConfigPresent: !fullEnvAudit?.excludedFiles?.includes("session-recall.json"),
    audit: fullEnvAudit === null ? { present: false } : {
      present: true,
      removedPackages: fullEnvAudit.settings?.removedPackages ?? [],
      excludedFiles: fullEnvAudit.excludedFiles ?? [],
      globalAgentsIncluded: fullEnvAudit.globalAgents?.source?.exists === true
        && fullEnvAudit.globalAgents?.harness?.exists === true
        && fullEnvAudit.globalAgents?.source?.sha256 === fullEnvAudit.globalAgents?.harness?.sha256,
    },
  };
}

function runtimeCellProvenance(report, runDir) {
  const saffronManifestPath = join(runDir, "saffron-manifest.json");
  const saffron = existsSync(saffronManifestPath) ? readJson(saffronManifestPath) : null;
  const fullEnvAudit = report?.resources?.fullEnvHarness ?? null;
  const agentsOnlyAudit = report?.resources?.agentsOnlyHarness ?? null;
  const agentsOnly = report?.agentsOnly === true;
  const configuredModel = report?.runtimeAudit?.configuredModel ?? null;
  const globalResourceTree = agentsOnly
    ? { tree: hashContentTree([]), error: null }
    : fullEnvAudit === null
      ? { tree: null, error: "full-env audit missing" }
      : captureContentTree(() => hashFullEnvLinkedResourceTree(fullEnvAudit));
  const externalCommandResourceTree = agentsOnly
    ? { tree: hashContentTree([]), error: null }
    : fullEnvAudit === null
      ? { tree: null, error: "full-env audit missing" }
      : captureContentTree(() => hashExternalCommandResourceTree(report?.commands ?? [], fullEnvAudit));
  const piRuntimeTree = captureContentTree(hashRepoLocalPiRuntimeTree);
  const bunRuntime = captureContentTree(bunRuntimeProvenance);
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
      runtimeTree: piRuntimeTree.tree,
      runtimeTreeError: piRuntimeTree.error,
    },
    bun: {
      evidence: bunRuntime.tree,
      error: bunRuntime.error,
    },
    fullEnv: fullEnvAudit ? {
      sanitizedSettingsSha256: fullEnvAudit.settings?.sanitizedSha256 ?? null,
      sanitizedPackagesSha256: fullEnvAudit.settings?.sanitizedPackagesSha256 ?? null,
      originalSettingsSha256: fullEnvAudit.settings?.originalSha256 ?? null,
      originalPackagesSha256: fullEnvAudit.settings?.originalPackagesSha256 ?? null,
      globalAgentsSha256: fullEnvAudit.globalAgents?.harness?.sha256 ?? null,
      rootConfigHashes: Object.fromEntries((fullEnvAudit.rootConfigs ?? []).map((entry) => [entry.name, entry.harness?.sha256 ?? null])),
      linkedResourceTree: globalResourceTree.tree,
      linkedResourceTreeError: globalResourceTree.error,
      externalCommandResourceTree: externalCommandResourceTree.tree,
      externalCommandResourceTreeError: externalCommandResourceTree.error,
    } : null,
    agentsOnly: agentsOnlyAudit ? {
      settingsSha256: agentsOnlyAudit.settings?.harness?.sha256 ?? null,
      modelsSha256: agentsOnlyAudit.models?.harness?.sha256 ?? null,
      sourceModelsSha256: agentsOnlyAudit.models?.source?.sha256 ?? null,
      authSha256: agentsOnlyAudit.auth?.harness?.sha256 ?? null,
      sourceAuthSha256: agentsOnlyAudit.auth?.source?.sha256 ?? null,
      globalAgentsSha256: agentsOnlyAudit.globalAgents?.harness?.sha256 ?? null,
      excludedAmbientResources: agentsOnlyAudit.excludedAmbientResources ?? [],
      sessionRecall: agentsOnlyAudit.sessionRecall ?? null,
    } : null,
    sandbox: report?.sandbox ?? null,
    lock: report?.lock ?? null,
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
  const fullEnvArm = pinned?.fullEnv?.[String(cell.contextWindow)] ?? null;
  const agentsOnlyArm = pinned?.agentsOnly?.[String(cell.contextWindow)] ?? null;
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
  if (runtime?.pi?.runtimeTreeError) reasons.push("pi_runtime_tree_unavailable");
  if (runtime?.pi?.runtimeTree?.sha256 !== pinned?.piRuntimeTree?.sha256) reasons.push("pi_runtime_tree_mismatch");
  if (runtime?.bun?.error) reasons.push("bun_runtime_unavailable");
  if (!bunRuntimeMatches(pinned?.bunRuntime, runtime?.bun?.evidence)) reasons.push("bun_runtime_mismatch");
  if (runtime?.globalCommands?.sha256 !== pinned?.globalCommands?.sha256) reasons.push("global_command_inventory_mismatch");
  if (cell.environmentMode === "agents-only") {
    for (const key of ["settingsSha256", "modelsSha256", "sourceModelsSha256", "authSha256", "sourceAuthSha256", "globalAgentsSha256"]) {
      if (runtime?.agentsOnly?.[key] !== agentsOnlyArm?.[key]) reasons.push(`agents_only_${key}_mismatch`);
    }
    if (JSON.stringify(runtime?.agentsOnly?.excludedAmbientResources) !== JSON.stringify(agentsOnlyArm?.excludedAmbientResources)) reasons.push("agents_only_excluded_resources_mismatch");
    if (JSON.stringify(runtime?.agentsOnly?.sessionRecall) !== JSON.stringify(agentsOnlyArm?.sessionRecall)) reasons.push("agents_only_session_recall_mismatch");
    if (runtime?.sandbox?.formalEvidenceEligible !== true
      || runtime?.sandbox?.enforcement !== "kernel_enforced"
      || runtime?.sandbox?.hostProcessSandboxed !== false
      || runtime?.sandbox?.toolSubprocessSandboxed !== true
      || runtime?.sandbox?.toolProfile?.applied !== true) {
      reasons.push("agents_only_sandbox_ineligible");
    }
    if (runtime?.lock?.acquired !== true || runtime?.lock?.released !== true) reasons.push("agents_only_lock_incomplete");
  } else {
    if (runtime?.fullEnv?.sanitizedSettingsSha256 !== fullEnvArm?.sanitizedSettingsSha256) reasons.push("sanitized_settings_mismatch");
    if (runtime?.fullEnv?.sanitizedPackagesSha256 !== fullEnvArm?.sanitizedPackagesSha256) reasons.push("sanitized_packages_mismatch");
    if (runtime?.fullEnv?.globalAgentsSha256 !== fullEnvArm?.globalAgentsSha256) reasons.push("global_agents_mismatch");
    if (JSON.stringify(runtime?.fullEnv?.rootConfigHashes) !== JSON.stringify(fullEnvArm?.rootConfigHashes)) reasons.push("global_config_hash_mismatch");
    if (runtime?.fullEnv?.linkedResourceTreeError) reasons.push("global_resource_tree_unavailable");
    if (runtime?.fullEnv?.linkedResourceTree?.sha256 !== pinned?.globalResourceTree?.sha256) reasons.push("global_resource_tree_mismatch");
    if (runtime?.fullEnv?.externalCommandResourceTreeError) reasons.push("external_command_resource_tree_unavailable");
    if (runtime?.fullEnv?.externalCommandResourceTree?.sha256 !== pinned?.externalCommandResourceTree?.sha256) reasons.push("external_command_resource_tree_mismatch");
  }
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
  const pairKeys = [...new Set(state.manifest.cells.map((cell) => cell.pairKey))];
  const pairCandidates = pairKeys.map((pairKey) => compareContextArms({
    pairKey,
    constrained400k: state.cells[`${pairKey}-400k`],
    native1m: state.cells[`${pairKey}-1m`],
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
      globalResourceTreeSha256: preflight.globalResourceTree?.sha256 ?? null,
      externalCommandResourceTreeSha256: preflight.externalCommandResourceTree?.sha256 ?? null,
      piRuntimeTreeSha256: preflight.piRuntimeTree?.sha256 ?? null,
      bunRuntimeSha256: preflight.bunRuntime?.binaryTree?.sha256 ?? null,
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

export function effectiveRunFlowConcurrency(cells, requestedConcurrency) {
  return cells.some((cell) => cell.environmentMode === "agents-only") ? 1 : requestedConcurrency;
}

async function executeCell(cell, options, pinnedProvenance) {
  // The preflight itself is gated in main. Recheck the complete checkout
  // contract immediately before and after each provider child so late-loaded
  // flow/verifier/judge modules cannot change without invalidating the cell.
  const checkoutBefore = verifyPinnedCheckout(pinnedProvenance);
  if (!checkoutBefore.valid) {
    const report = {
      status: "infrastructure_invalid",
      infrastructureInvalid: {
        reason: `prelaunch_checkout_mismatch:${checkoutBefore.reasons.join(",")}`,
      },
      fullEnv: true,
      contextWindow: cell.contextWindow,
      maxTokensCap: cell.maxTokensCap,
      deterministicVerification: null,
    };
    const telemetry = collectFlowTelemetry({ report, contextWindow: cell.contextWindow, integrity: { audit: { present: false } } });
    return {
      child: { exitCode: null, signal: null, error: null, stderr: "" },
      report,
      telemetry,
      reportPath: null,
      telemetryPath: null,
      provenance: null,
      provenanceCheck: mergeCheckoutProvenanceCheck({ valid: false, reasons: checkoutBefore.reasons }, checkoutBefore, "prelaunch"),
    };
  }
  const runtimeTreeCheck = verifyPinnedRuntimeTrees(pinnedProvenance);
  if (!runtimeTreeCheck.valid) {
    const report = {
      status: "infrastructure_invalid",
      infrastructureInvalid: {
        reason: `prelaunch_runtime_tree_mismatch:${runtimeTreeCheck.reasons.join(",")}`,
      },
      fullEnv: true,
      contextWindow: cell.contextWindow,
      maxTokensCap: cell.maxTokensCap,
      deterministicVerification: null,
    };
    const telemetry = collectFlowTelemetry({ report, contextWindow: cell.contextWindow, integrity: { audit: { present: false } } });
    return {
      child: { exitCode: null, signal: null, error: null, stderr: "" },
      report,
      telemetry,
      reportPath: null,
      telemetryPath: null,
      provenance: null,
      provenanceCheck: { valid: false, reasons: runtimeTreeCheck.reasons },
    };
  }
  const child = await runFlowChild({ cell, options, bunBinary: options.bunBinary });
  const checkoutAfter = verifyPinnedCheckout(pinnedProvenance);
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
    return {
      child,
      report,
      telemetry,
      reportPath: null,
      telemetryPath: null,
      provenance: null,
      provenanceCheck: mergeCheckoutProvenanceCheck({ valid: false, reasons: ["run_report_missing"] }, checkoutAfter, "post_child"),
    };
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
  const provenanceCheck = mergeCheckoutProvenanceCheck(
    validateCellProvenance(cell, provenance, pinnedProvenance),
    checkoutAfter,
    "post_child",
  );
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
  const requestedProfile = option("--profile");
  const suppliedFlowSeed = option("--flow-seed") ?? process.env.ACM_FLOW_SEED;
  if (execute && !suppliedFlowSeed) throw new Error("--execute requires --flow-seed or ACM_FLOW_SEED");
  // A resume always starts an audit Pi process, so it has the same immutable
  // checkout requirement as execution. Plain previews remain available for
  // inspection from a dirty worktree.
  assertMatrixWorktreeClean({ execute, resume });
  if (resume && output) throw new Error("--resume and --output are mutually exclusive");
  const flowId = option("--flow") ?? DEFAULT_FLOW_ID;
  const newMatrixRunId = resume ? null : generateMatrixRunId();
  const outputDir = resume
    ? asAbsolute(resume)
    : output
      ? asAbsolute(output)
      : join(RUNS_DIR, `saffron-flow-matrix-${timestampLabel()}-${newMatrixRunId}`);
  mkdirSync(outputDir, { recursive: true });
  const sourceSnapshotDir = join(outputDir, sourceSnapshotDirName);
  const matrixSourceAgentDir = CONTROLLED_ENVIRONMENT_MODE === "agents-only" ? sourceSnapshotDir : undefined;
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
      if (!state.secretSeedSha256 || !state.matrixRunId || !state.pinnedProvenance?.globalResourceTree || !state.pinnedProvenance?.externalCommandResourceTree || !state.pinnedProvenance?.piRuntimeTree || !state.pinnedProvenance?.bunRuntime) {
        throw new Error("resume state lacks secretSeedSha256, matrixRunId, or pinned resource-tree provenance");
      }
      assertResumeSeed(state.secretSeedSha256, suppliedFlowSeed);
      secretSeed = suppliedFlowSeed;
      const persistedProfile = state.manifest?.profile ?? DEFAULT_MATRIX_PROFILE;
      if (requestedProfile !== undefined && requestedProfile !== persistedProfile) {
        throw new Error(`resume profile differs from persisted matrix: requested ${requestedProfile}, expected ${persistedProfile}`);
      }
      manifest = createLongFlowMatrixManifest({ flowId, matrixRunId: state.matrixRunId, profile: persistedProfile });
      if (JSON.stringify(state.manifest) !== JSON.stringify(manifest)) throw new Error("resume manifest differs from this runner's fixed declaration");
      assertPinnedSourceSnapshot(state.pinnedProvenance, sourceSnapshotDir);
      const baseProvenance = collectPinnedProvenance({ secretSeed, matrixRunId: state.matrixRunId, sourceAgentDir: matrixSourceAgentDir });
      assertPiProvenance(baseProvenance.pi);
      const runtimeTrees = verifyPinnedRuntimeTrees(state.pinnedProvenance);
      if (!runtimeTrees.valid) throw new Error(`resume runtime tree mismatch: ${runtimeTrees.reasons.join(",")}`);
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
        globalResourceTree: runtimeTrees.globalResources.tree,
        externalCommandResourceTree: runtimeTrees.externalCommandResources.tree,
        piRuntimeTree: runtimeTrees.piRuntime.tree,
        bunRuntime: runtimeTrees.bunRuntime.tree,
      };
      assertPinnedProvenance(state.pinnedProvenance, recomputedPinned);
      const resumePreflight = await runAuditPreflight({
        manifest,
        secretSeed,
        piBinary: baseProvenance.pi.path,
        bunBinary: state.pinnedProvenance.bunRuntime.realpath,
        timeoutScale,
        sourceAgentDir: matrixSourceAgentDir,
      });
      if (resumePreflight.commandInventory.sha256 !== state.pinnedProvenance.globalCommands.sha256) {
        throw new Error("resume global command inventory mismatch");
      }
      if (resumePreflight.globalResourceTree.sha256 !== state.pinnedProvenance.globalResourceTree.sha256) {
        throw new Error("resume global resource tree mismatch");
      }
      if (resumePreflight.externalCommandResourceTree.sha256 !== state.pinnedProvenance.externalCommandResourceTree.sha256) {
        throw new Error("resume external command resource tree mismatch");
      }
      if (resumePreflight.piRuntimeTree.sha256 !== state.pinnedProvenance.piRuntimeTree.sha256) {
        throw new Error("resume Pi runtime tree mismatch");
      }
      if (!bunRuntimeMatches(state.pinnedProvenance.bunRuntime, resumePreflight.bunRuntime)) {
        throw new Error("resume Bun runtime mismatch");
      }
      state.preflightRuns = [...(state.preflightRuns ?? []), resumePreflight];
      pinnedProvenance = state.pinnedProvenance;
      for (const cell of Object.values(state.cells)) if (cell.status === "running") cell.status = "pending";
    } else {
      if (existsSync(statePath)) throw new Error(`output already contains ${stateFileName}; use --resume`);
      secretSeed = suppliedFlowSeed ?? generateMatrixSecret();
      manifest = createLongFlowMatrixManifest({
        flowId,
        matrixRunId: newMatrixRunId,
        profile: requestedProfile ?? DEFAULT_MATRIX_PROFILE,
      });
      if (matrixSourceAgentDir) createAgentsOnlySourceSnapshot({ snapshotDir: matrixSourceAgentDir });
      const baseProvenance = collectPinnedProvenance({ secretSeed, matrixRunId: newMatrixRunId, sourceAgentDir: matrixSourceAgentDir });
      assertPiProvenance(baseProvenance.pi);
      const preflight = await runAuditPreflight({
        manifest,
        secretSeed,
        piBinary: baseProvenance.pi.path,
        timeoutScale,
        sourceAgentDir: matrixSourceAgentDir,
      });
      pinnedProvenance = {
        ...baseProvenance,
        globalCommands: preflight.commandInventory,
        preflight: { reportPath: preflight.reportPath, reportSha256: preflight.reportSha256 },
        globalResourceTree: preflight.globalResourceTree,
        externalCommandResourceTree: preflight.externalCommandResourceTree,
        piRuntimeTree: preflight.piRuntimeTree,
        bunRuntime: preflight.bunRuntime,
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
      bunBinary: pinnedProvenance.bunRuntime.realpath,
      secretSeed,
      sourceAgentDir: matrixSourceAgentDir,
    };
    // Keep each same-model pair adjacent and deterministic: constrained 400K
    // first, then native 1M, before advancing to the next model.
    const manifestPairKeys = new Set(manifest.cells.map((cell) => cell.pairKey));
    for (const model of MODEL_SPECS.filter((candidate) => manifestPairKeys.has(candidate.id))) {
      const pairCells = selected
        .filter((cell) => cell.pairKey === model.id)
        .sort((left, right) => left.contextWindow - right.contextWindow)
        .map((cell) => state.cells[cell.id])
        .filter((cell) => flag("--retry-all") || !shouldSkipMatrixCell(cell));
      if (pairCells.length === 0) continue;
      const pairConcurrency = effectiveRunFlowConcurrency(pairCells, concurrency);
      console.log(`pair=${model.id} launching=${pairCells.length} concurrency=${pairConcurrency}`);
      await runWithConcurrency(pairCells, pairConcurrency, async (cell) => {
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
