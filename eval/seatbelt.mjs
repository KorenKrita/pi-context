import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

function aliases(path) {
  if (/[\x00-\x1f\x7f]/.test(String(path))) {
    throw new Error(`Seatbelt path contains control characters: ${JSON.stringify(path)}`);
  }
  const absolute = resolve(path);
  const values = new Set([absolute]);
  try { values.add(realpathSync(absolute)); } catch { /* retain the lexical path */ }
  for (const value of [...values]) {
    if (value === "/var" || value.startsWith("/var/")) values.add(`/private${value}`);
    if (value === "/private/var" || value.startsWith("/private/var/")) values.add(value.slice("/private".length));
    if (value === "/tmp" || value.startsWith("/tmp/")) values.add(`/private${value}`);
    if (value === "/private/tmp" || value.startsWith("/private/tmp/")) values.add(value.slice("/private".length));
    if (value === "/etc" || value.startsWith("/etc/")) values.add(`/private${value}`);
    if (value === "/private/etc" || value.startsWith("/private/etc/")) values.add(value.slice("/private".length));
  }
  return [...values];
}

function seatbeltString(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Seatbelt profile value contains control characters: ${JSON.stringify(value)}`);
  }
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function profileFromDeniedRoots(deniedRoots, currentRoots, allowedRoots, metadataRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error("Seatbelt allowedRoots must not be empty");
  }
  if (!Array.isArray(metadataRoots) || metadataRoots.length === 0) {
    throw new Error("Seatbelt metadataRoots must not be empty");
  }
  const rules = deniedRoots.map((entry) => `  (${entry.kind} "${seatbeltString(entry.path)}")`);
  const allowRules = allowedRoots.map((path) => `  (subpath "${seatbeltString(path)}")`);
  const metadataRules = metadataRoots.map((path) => `  (subpath "${seatbeltString(path)}")`);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-read* file-write*",
    ...rules,
    ")",
    "(allow file-read* file-write*",
    ...allowRules,
    ")",
    "(allow file-read-metadata",
    ...metadataRules,
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

  addSubpath(tempRoot, "shared_workspace_root");
  addSubpath(runsRoot, "shared_eval_runs_root");
  addSubpath(harnessRoot, "shared_agent_harness_root");
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
  const outerCurrentRoots = [...new Set([workspace, runDir, agentDir].flatMap(aliases))];
  const metadataRoots = [...new Set([tempRoot, runsRoot, harnessRoot, privateEvalRoot].flatMap(aliases))];
  const toolDenied = [...outerRoots];
  for (const [path, source] of [
    [agentDir, "current_agent_dir"],
    [runDir, "current_run_dir"],
    [harnessRoot, "current_harness_root"],
  ]) {
    for (const alias of aliases(path)) toolDenied.push({ path: alias, kind: "subpath", source });
  }
  const toolCurrentRoots = [...new Set(aliases(workspace))];
  return {
    outer: profileFromDeniedRoots(outerRoots, outerCurrentRoots, outerCurrentRoots, metadataRoots),
    tool: profileFromDeniedRoots(dedupe(toolDenied), toolCurrentRoots, toolCurrentRoots, metadataRoots),
  };
}

function writeProfile(path, result) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.profile);
  const persistedProfile = readFileSync(path, "utf8");
  if (persistedProfile !== result.profile) throw new Error(`Seatbelt profile verification failed: ${path}`);
  return { path, exists: true, ...result };
}

export function writeEvaluationSeatbeltProfiles(options) {
  const result = buildEvaluationSeatbeltProfiles(options);
  return {
    outer: writeProfile(join(options.runDir, "measurement-outer-seatbelt.sb"), result.outer),
    tool: writeProfile(join(options.runDir, "measurement-tool-seatbelt.sb"), result.tool),
  };
}
