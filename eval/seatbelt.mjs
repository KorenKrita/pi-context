import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function classifySeatbeltSupport({ agentsOnly, platform, executableExists, profilesExist }) {
  if (!agentsOnly) {
    return { required: false, supported: platform === "darwin", enabled: false, enforcement: "not_requested", formalEvidenceEligible: true, failureStatus: null };
  }
  const supported = platform === "darwin";
  const enabled = supported && executableExists && profilesExist;
  return {
    required: true,
    supported,
    enabled,
    enforcement: supported ? "kernel_enforced" : "unsupported",
    formalEvidenceEligible: enabled,
    failureStatus: !supported
      ? "agents_only_sandbox_unsupported"
      : enabled
        ? null
        : "agents_only_sandbox_profile_missing",
  };
}

function existingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function aliases(path) {
  const absolute = resolve(path);
  const values = new Set([absolute]);
  try { values.add(realpathSync(absolute)); } catch { /* retain the lexical path */ }
  for (const value of [...values]) {
    if (value === "/var" || value.startsWith("/var/")) values.add(`/private${value}`);
    if (value === "/private/var" || value.startsWith("/private/var/")) values.add(value.slice("/private".length));
    if (value === "/tmp" || value.startsWith("/tmp/")) values.add(`/private${value}`);
    if (value === "/private/tmp" || value.startsWith("/private/tmp/")) values.add(value.slice("/private".length));
  }
  return [...values];
}

function siblingDirectories(root, predicate, excludedPaths) {
  if (!existingDirectory(root)) return [];
  const excluded = new Set(excludedPaths.flatMap(aliases));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && predicate(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((path) => aliases(path).every((candidate) => !excluded.has(candidate)));
}

function seatbeltString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function profileFromDeniedRoots(deniedRoots, currentRoots) {
  const rules = deniedRoots.map((entry) => `  (${entry.kind} "${seatbeltString(entry.path)}")`);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-read* file-write*",
    ...rules,
    ")",
    "",
  ].join("\n");
  return { profile, profileSha256: sha256(profile), deniedRoots, currentRoots };
}

export function buildEvaluationSeatbeltProfiles({
  workspace,
  runDir,
  agentDir,
  harnessRoot = dirname(agentDir),
  runsRoot = dirname(runDir),
  tempRoot = dirname(workspace),
  homeDir,
  evalRoot,
  privateEvalRoot = join(homeDir, ".codex", "private", "pi-context-eval"),
}) {
  const outerDenied = [];
  const addSubpath = (path, source) => {
    for (const alias of aliases(path)) outerDenied.push({ path: alias, kind: "subpath", source });
  };
  const addLiteral = (path, source) => {
    for (const alias of aliases(path)) outerDenied.push({ path: alias, kind: "literal", source });
  };

  for (const path of siblingDirectories(tempRoot, (name) => name.startsWith("acm-"), [workspace])) {
    addSubpath(path, "sibling_temp_workspace");
  }
  for (const path of siblingDirectories(runsRoot, () => true, [runDir])) {
    addSubpath(path, "sibling_eval_run");
  }
  for (const path of siblingDirectories(harnessRoot, () => true, [agentDir])) {
    addSubpath(path, "sibling_agent_harness");
  }
  addSubpath(join(homeDir, ".pi"), "pi_private_state");
  addSubpath(join(homeDir, ".codex", "sessions"), "codex_sessions");
  addSubpath(join(homeDir, ".codex", "archived_sessions"), "codex_archived_sessions");
  addSubpath(join(homeDir, ".codex", "memories"), "codex_memories");
  addSubpath(privateEvalRoot, "private_eval_root");
  addSubpath(join(evalRoot, "fixtures"), "task_fixture_source");
  addLiteral("/private/etc/passwd", "private_account_database");
  addLiteral("/private/etc/master.passwd", "private_account_database");

  const dedupe = (entries) => entries.filter((entry, index, all) => (
    all.findIndex((candidate) => candidate.path === entry.path && candidate.kind === entry.kind) === index
  ));
  const outerRoots = dedupe(outerDenied);
  const toolDenied = [...outerRoots];
  for (const [path, source] of [
    [agentDir, "current_agent_dir"],
    [runDir, "current_run_dir"],
    [harnessRoot, "current_harness_root"],
  ]) {
    for (const alias of aliases(path)) toolDenied.push({ path: alias, kind: "subpath", source });
  }
  return {
    outer: profileFromDeniedRoots(outerRoots, [...new Set([workspace, runDir, agentDir].flatMap(aliases))]),
    tool: profileFromDeniedRoots(dedupe(toolDenied), [...new Set(aliases(workspace))]),
  };
}

function writeProfile(path, result) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.profile);
  return { path, exists: existsSync(path), ...result };
}

export function writeEvaluationSeatbeltProfiles(options) {
  const result = buildEvaluationSeatbeltProfiles(options);
  return {
    outer: writeProfile(join(options.runDir, "measurement-outer-seatbelt.sb"), result.outer),
    tool: writeProfile(join(options.runDir, "measurement-tool-seatbelt.sb"), result.tool),
  };
}
