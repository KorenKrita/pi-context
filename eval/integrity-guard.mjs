// Measurement-only guard for real-Pi full-environment evaluations.
// It registers no tools or commands and never modifies the system prompt.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";
export const ACM_CORE_HEADING = "## Agentic Context Management CORE";
export const REQUIRED_ACM_TOOLS = Object.freeze(["acm_checkpoint", "acm_timeline", "acm_travel"]);
export const FORBIDDEN_RECALL_TOOLS = Object.freeze(["session_search", "session_query"]);
export const FULL_ENV_DENIED_TOOLS = Object.freeze([
  ...FORBIDDEN_RECALL_TOOLS,
  "bash_bg",
  "Agent",
  "StopAgent",
  "AgentStatus",
  "agent_bg",
  "jobs",
  "job_decide",
  "monitor",
  "mcp",
  "replace",
  "undo_last_replace",
  "ask_user_question",
  "find_roots",
  "observe_ui",
  "search_ui",
  "expand_ui",
  "inspect_ui",
  "act_ui",
  "read_text",
  "wait_for",
  "launch_browser",
  "navigate_browser",
  "evaluate_browser",
]);

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_TOOLS = new Set([...READ_ONLY_TOOLS, "edit", "write"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrences(text, exact) {
  if (!text || !exact) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(exact, offset)) >= 0) {
    count += 1;
    offset += exact.length;
  }
  return count;
}

export function inspectPromptIntegrity({ systemPrompt, activeTools, requiredMarkers = [] }) {
  const markerRequirements = [
    { id: "acm_core_marker", value: ACM_CORE_MARKER, exact: 1 },
    ...requiredMarkers.filter((marker) => marker?.id !== "acm_core_marker"),
  ];
  const markerCounts = Object.fromEntries(markerRequirements.map((marker) => [marker.id, occurrences(systemPrompt ?? "", marker.value)]));
  const coreMarkerCount = markerCounts.acm_core_marker;
  const coreHeadingCount = occurrences(systemPrompt ?? "", ACM_CORE_HEADING);
  const activeToolCounts = Object.fromEntries(REQUIRED_ACM_TOOLS.map((name) => [
    name,
    (activeTools ?? []).filter((candidate) => candidate === name).length,
  ]));
  const forbiddenActiveTools = FULL_ENV_DENIED_TOOLS.filter((name) => (activeTools ?? []).includes(name));
  const violations = [];
  for (const marker of markerRequirements) {
    const count = markerCounts[marker.id];
    if (marker.exact !== undefined && count !== marker.exact) {
      violations.push(`expected exactly ${marker.exact} ${marker.id}, found ${count}`);
    } else if (marker.min !== undefined && count < marker.min) {
      violations.push(`expected at least ${marker.min} ${marker.id}, found ${count}`);
    }
  }
  if (coreHeadingCount !== 1) violations.push(`expected exactly one ACM CORE heading, found ${coreHeadingCount}`);
  for (const [name, count] of Object.entries(activeToolCounts)) {
    if (count !== 1) violations.push(`expected exactly one active ${name}, found ${count}`);
  }
  if (forbiddenActiveTools.length > 0) violations.push(`forbidden active tools: ${forbiddenActiveTools.join(", ")}`);
  return { valid: violations.length === 0, coreMarkerCount, coreHeadingCount, markerCounts, activeToolCounts, forbiddenActiveTools, violations };
}

function pathInside(path, root) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function canonicalExistingPath(path) {
  const suffix = [];
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(path);
    suffix.unshift(basename(candidate));
    candidate = parent;
  }
  try {
    return resolve(realpathSync(candidate), ...suffix);
  } catch {
    return resolve(path);
  }
}

function resolvedToolPath(workspace, rawPath) {
  const candidate = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : ".";
  return canonicalExistingPath(isAbsolute(candidate) ? candidate : resolve(workspace, candidate));
}

function hasShellOptionOrEnvironmentDump(command) {
  // `set` alone exposes shell variables; `set -o` and `set +o` expose option
  // state. Named option changes (for example, `set -o errexit`) are normal
  // shell setup and must remain available to evaluation flows.
  return /(?:^|[;&|()\s])set(?:\s*(?=$|[;&|()\n#])|\s+[+-]o\s*(?=$|[;&|()\n#]))/.test(command);
}

function bashViolation(command) {
  const checks = [
    ["bash_absolute_path", /(^|[\s"'=;|&(])\/(?!\/)/],
    ["bash_parent_escape", /(^|[\/\s"'=])\.\.([\/\s"'=]|$)/],
    ["bash_home_or_pi_discovery", /(^|[\s"'=;|&(])(?:~(?:\/|$)|\$HOME\b|\$\{HOME\}|\.pi(?:\/|\b)|PI_CODING_AGENT_DIR\b|CODEX_HOME\b)/i],
    ["bash_eval_run_discovery", /(^|[\/\s"'=])eval\/\.runs(?:[\/\s"'=]|$)/i],
    ["bash_process_or_env_discovery", /(?:^|[;&|()\s])(?:env|printenv|ps|pgrep|top|lsof)(?:\s|$)|(?:^|[;&|()\s])export\s+-p(?:\s|$)|(?:^|[;&|()\s])declare\s+-x(?:\s|$)|process\.env\b|os\.environ\b|Deno\.env\b|getenv\s*\(|\bACM_INTEGRITY_[A-Z0-9_]+\b/i],
  ];
  for (const [code, pattern] of checks) {
    if (pattern.test(command)) return code;
  }
  if (hasShellOptionOrEnvironmentDump(command)) return "bash_process_or_env_discovery";
  return null;
}

/** Pure policy seam used by the extension and focused tests. */
export function evaluateToolCall({ toolName, input, workspace, approvedSkillRoots = [] }) {
  if (FULL_ENV_DENIED_TOOLS.includes(toolName)) {
    return {
      block: true,
      code: "escape_capable_tool_denied",
      reason: `measurement integrity guard denies escape-capable tool ${toolName}`,
    };
  }
  if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    const code = bashViolation(command);
    return code
      ? { block: true, code, reason: `measurement integrity guard blocked bash command (${code})` }
      : { block: false };
  }
  if (!FILE_TOOLS.has(toolName)) return { block: false };
  const requestedPath = resolvedToolPath(workspace, input?.path);
  const workspaceRoot = canonicalExistingPath(workspace);
  if (pathInside(requestedPath, workspaceRoot)) return { block: false };
  if (READ_ONLY_TOOLS.has(toolName)) {
    const approved = approvedSkillRoots
      .map(canonicalExistingPath)
      .some((root) => pathInside(requestedPath, root));
    if (approved) return { block: false };
    return {
      block: true,
      code: "path_outside_allowed_roots",
      reason: "measurement integrity guard permits read-only tools only inside the workspace or an advertised Skill root",
    };
  }
  return {
    block: true,
    code: "path_outside_workspace",
    reason: "measurement integrity guard permits mutation only inside the flow workspace",
  };
}

function parseApprovedRoots(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((path) => typeof path === "string" && path.length > 0) : [];
  } catch {
    return [];
  }
}

function parseRequiredMarkers(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((marker) => (
      marker
      && typeof marker.id === "string"
      && typeof marker.value === "string"
      && marker.value.length > 0
      && (Number.isInteger(marker.exact) || Number.isInteger(marker.min))
    ));
  } catch {
    return [];
  }
}

function appendAudit(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
}

export function readIntegrityAudit(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export default function integrityGuard(pi) {
  const integrityEnvironmentNames = [
    "ACM_INTEGRITY_APPROVED_SKILL_ROOTS",
    "ACM_INTEGRITY_AUDIT_PATH",
    "ACM_INTEGRITY_REQUIRED_MARKERS",
    "ACM_INTEGRITY_WORKSPACE",
  ];
  const integrityEnvironment = Object.fromEntries(integrityEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of integrityEnvironmentNames) delete process.env[name];
  const auditPath = integrityEnvironment.ACM_INTEGRITY_AUDIT_PATH;
  const workspace = integrityEnvironment.ACM_INTEGRITY_WORKSPACE;
  if (!auditPath || !workspace) {
    throw new Error("ACM integrity guard requires ACM_INTEGRITY_AUDIT_PATH and ACM_INTEGRITY_WORKSPACE");
  }
  const approvedSkillRoots = new Set(parseApprovedRoots(integrityEnvironment.ACM_INTEGRITY_APPROVED_SKILL_ROOTS));
  const requiredMarkers = parseRequiredMarkers(integrityEnvironment.ACM_INTEGRITY_REQUIRED_MARKERS);
  appendAudit(auditPath, {
    type: "extension_loaded",
    workspaceSha256: sha256(canonicalExistingPath(workspace)),
  });

  pi.on("session_start", () => {
    appendAudit(auditPath, {
      type: "session_start",
      activeTools: pi.getActiveTools(),
      allTools: pi.getAllTools().map((tool) => tool.name),
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    for (const skill of event.systemPromptOptions?.skills ?? []) {
      if (typeof skill?.baseDir === "string" && skill.baseDir.length > 0) approvedSkillRoots.add(skill.baseDir);
    }
    const result = inspectPromptIntegrity({
      systemPrompt: event.systemPrompt,
      activeTools: pi.getActiveTools(),
      requiredMarkers,
    });
    appendAudit(auditPath, {
      type: "before_agent_start",
      valid: result.valid,
      coreMarkerCount: result.coreMarkerCount,
      coreHeadingCount: result.coreHeadingCount,
      markerCounts: result.markerCounts,
      markerHashes: Object.fromEntries(requiredMarkers.map((marker) => [marker.id, sha256(marker.value)])),
      activeToolCounts: result.activeToolCounts,
      forbiddenActiveTools: result.forbiddenActiveTools,
      violations: result.violations,
      systemPromptSha256: sha256(event.systemPrompt ?? ""),
      approvedSkillRootCount: approvedSkillRoots.size,
    });
    if (!result.valid) {
      ctx.abort();
      throw new Error(`measurement integrity failure: ${result.violations.join("; ")}`);
    }
  });

  pi.on("tool_call", (event) => {
    const decision = evaluateToolCall({
      toolName: event.toolName,
      input: event.input,
      workspace,
      approvedSkillRoots: [...approvedSkillRoots],
    });
    if (!decision.block) return undefined;
    appendAudit(auditPath, {
      type: "tool_blocked",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      code: decision.code,
      inputSha256: sha256(JSON.stringify(event.input ?? {})),
    });
    return { block: true, reason: decision.reason };
  });
}
