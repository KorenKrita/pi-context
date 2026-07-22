// Measurement-only guard for real-Pi full-environment evaluations.
// It registers no tools or commands and never modifies the system prompt.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const BASH_TOKEN_START_BOUNDARY = String.raw`[\s"'=;|&()<>:]`;
const BASH_PATH_START_BOUNDARY = String.raw`[\/\s"'=;|&()<>:]`;
const BASH_TOKEN_END_BOUNDARY = String.raw`[\s"'=;|&()<>]`;
const BASH_PATH_END_BOUNDARY = String.raw`[\/\s"'=;|&()<>]`;
const BASH_TOKEN_START = `(?:^|${BASH_TOKEN_START_BOUNDARY})`;
const BASH_PATH_START = `(?:^|${BASH_PATH_START_BOUNDARY})`;
const BASH_TOKEN_END = `(?=$|${BASH_TOKEN_END_BOUNDARY})`;
const BASH_PATH_END = `(?=$|${BASH_PATH_END_BOUNDARY})`;
const BASH_BOUNDARY_CHARACTER_PATTERN = new RegExp(BASH_TOKEN_START_BOUNDARY);
const BASH_PATH_BOUNDARY_CHARACTER_PATTERN = new RegExp(BASH_PATH_END_BOUNDARY);
const HEREDOC_DELIMITER_TERMINATOR_PATTERN = /[\s;|&()<>]/;
const BASH_ABSOLUTE_PATH_PATTERN = new RegExp(`${BASH_TOKEN_START}/(?!/)`);
const BASH_PARENT_ESCAPE_PATTERN = new RegExp(`${BASH_PATH_START}\\.\\.${BASH_PATH_END}`);
const BASH_SAFE_DEVICE_PATH_PATTERN = new RegExp(`(${BASH_PATH_START})/dev/null${BASH_TOKEN_END}`, "g");
const BASH_NATIVE_TEMP_PATH_PATTERN = /(^|[\s"'=;|&()<>:])(\/private\/tmp|\/tmp)(?=$|[\/\s"'=;|&()<>])/g;
const BASH_HOME_OR_PI_PATTERN = new RegExp(
  `${BASH_TOKEN_START}${String.raw`~(?:[^/\s"'=;|&()<>]+)?`}${BASH_PATH_END}`
  + `|${BASH_PATH_START}(?:\\$HOME|\\$\\{HOME\\}|\\.pi|PI_CODING_AGENT_DIR|CODEX_HOME)${BASH_PATH_END}`,
  "i",
);
const BASH_EVAL_RUN_PATTERN = new RegExp(`${BASH_PATH_START}eval/\\.runs${BASH_PATH_END}`, "i");
const SENSITIVE_ENVIRONMENT_KEY_PATTERN = String.raw`(?:HOME|PI_CODING_AGENT_DIR|CODEX_HOME|ACM_INTEGRITY_[A-Z0-9_]+)`;
const SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN = String.raw`["']${SENSITIVE_ENVIRONMENT_KEY_PATTERN}["']`;
const BASH_SENSITIVE_ENVIRONMENT_KEY_PATTERN = new RegExp([
  String.raw`process\.env\s*(?:\??\.\s*${SENSITIVE_ENVIRONMENT_KEY_PATTERN}|(?:\?\.\s*)?\[\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN}\s*\])`,
  String.raw`os\.environ\s*(?:\[\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN}\s*\]|\.\s*get\s*\(\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN})`,
  String.raw`os\.getenv\s*\(\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN}`,
  String.raw`Deno\.env\s*\.\s*get\s*\(\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN}`,
  String.raw`(?:^|[^\w.])getenv\s*\(\s*${SENSITIVE_ENVIRONMENT_QUOTED_KEY_PATTERN}`,
].join("|"), "i");
const BASH_WHOLE_ENVIRONMENT_PATTERN = /(?:process\.env|os\.environ|Deno\.env)(?=\s*(?:[),;}:]|$))|(?:process\.env|os\.environ|Deno\.env)\s*\.\s*(?:keys|values|items|entries|copy|toObject)\s*\(/i;
const BASH_PROCESS_OR_ENV_DISCOVERY_PATTERN = /(?:^|[;&|()\s])(?:env|printenv|ps|pgrep|top|lsof)(?=$|[;&|()\s])|(?:^|[;&|()\s])export\s+-p(?=$|[;&|()\s])|(?:^|[;&|()\s])declare\s+-x(?=$|[;&|()\s])|\bACM_INTEGRITY_[A-Z0-9_]+\b/i;

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
  // `set` alone exposes shell variables; bare `set -o` and `set +o` expose
  // option state. Named option changes (for example, `set -o errexit`) and
  // interpreter-language calls such as `set(sup)` remain valid evaluation code.
  const tokenStart = String.raw`(?:^|[;&|()\s])set`;
  const commandEnd = String.raw`(?=$|[;|&)]|[ \t]*(?:\r\n?|\n)|[ \t]+(?=$|[#;|&)]))`;
  return new RegExp(`${tokenStart}${commandEnd}`).test(command)
    || new RegExp(`${tokenStart}\\s+[+-]o${commandEnd}`).test(command);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspacePathRoots(workspace) {
  return [...new Set([resolve(workspace), canonicalExistingPath(workspace)])]
    .sort((left, right) => right.length - left.length);
}

function maskWorkspacePaths(command, workspace) {
  if (typeof workspace !== "string" || workspace.length === 0) return command;
  return workspacePathRoots(workspace).reduce((masked, root) => (
    masked.replace(new RegExp(`${escapeRegExp(root)}${BASH_PATH_END}`, "g"), "__ACM_WORKSPACE__")
  ), command);
}

function maskSafeDevicePaths(command) {
  return command.replace(BASH_SAFE_DEVICE_PATH_PATTERN, "$1__ACM_SAFE_DEVICE__");
}

export function workspaceTempDirectory(workspace) {
  const workspaceRoot = resolve(workspace);
  const gitDirectory = join(workspaceRoot, ".git");
  try {
    if (statSync(gitDirectory).isDirectory()) return join(gitDirectory, "acm-eval-tmp");
  } catch {
    // A missing or worktree-file `.git` uses the workspace-local fallback.
  }
  return join(workspaceRoot, ".acm-eval-tmp");
}

export function rewriteWorkspaceTempPaths(command, workspace) {
  if (typeof command !== "string" || typeof workspace !== "string" || workspace.length === 0) return command;
  const rewriteView = maskHttpUris(maskAllHeredocBodies(command));
  const policyCommand = quoteAwarePathCommands(rewriteView).absolutePathCommand;
  const replacements = [];
  for (const match of policyCommand.matchAll(BASH_NATIVE_TEMP_PATH_PATTERN)) {
    const boundaryLength = match[1].length;
    const sourcePath = match[2];
    const start = match.index + boundaryLength;
    const workspacePath = workspacePathRoots(workspace).some((root) => (
      command.slice(start, start + root.length) === root
      && (start + root.length === command.length || BASH_PATH_BOUNDARY_CHARACTER_PATTERN.test(command[start + root.length]))
    ));
    if (!workspacePath && command.slice(start, start + sourcePath.length) === sourcePath) {
      replacements.push({ end: start + sourcePath.length, start });
    }
  }
  if (replacements.length === 0) return command;
  const targetDirectory = workspaceTempDirectory(workspace);
  return replacements.toReversed().reduce((rewritten, replacement) => (
    `${rewritten.slice(0, replacement.start)}${targetDirectory}${rewritten.slice(replacement.end)}`
  ), command);
}

function neutralizeHeredocLine(line) {
  return line.replace(/[^\r]/g, "_");
}

function heredocSpecs(line) {
  const specs = [];
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (quote === '"' && character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (line.slice(index, index + 2) !== "<<") continue;

    let delimiterIndex = index + 2;
    const stripTabs = line[delimiterIndex] === "-";
    if (stripTabs) delimiterIndex += 1;
    while (line[delimiterIndex] === " " || line[delimiterIndex] === "\t") delimiterIndex += 1;
    const delimiterQuote = line[delimiterIndex];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      delimiterIndex += 1;
      let delimiter = "";
      for (; delimiterIndex < line.length; delimiterIndex += 1) {
        const delimiterCharacter = line[delimiterIndex];
        if (delimiterQuote === '"' && delimiterCharacter === "\\" && delimiterIndex + 1 < line.length) {
          delimiter += line[delimiterIndex + 1];
          delimiterIndex += 1;
        } else if (delimiterCharacter === delimiterQuote) {
          specs.push({ delimiter, quoted: true, stripTabs });
          index = delimiterIndex;
          break;
        } else {
          delimiter += delimiterCharacter;
        }
      }
      continue;
    }

    const delimiterStart = delimiterIndex;
    while (
      delimiterIndex < line.length
      && !HEREDOC_DELIMITER_TERMINATOR_PATTERN.test(line[delimiterIndex])
      && line.slice(delimiterIndex, delimiterIndex + 2) !== "<<"
    ) {
      delimiterIndex += 1;
    }
    if (delimiterIndex > delimiterStart) {
      specs.push({
        delimiter: line.slice(delimiterStart, delimiterIndex),
        quoted: false,
        stripTabs,
      });
      index = delimiterIndex - 1;
    }
  }
  return specs;
}

function maskHeredocBodies(command, shouldNeutralize) {
  const lines = command.split("\n");
  const maskedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    maskedLines.push(lines[index]);
    for (const spec of heredocSpecs(lines[index])) {
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        const comparison = (spec.stripTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
        const terminator = comparison === spec.delimiter;
        maskedLines.push(shouldNeutralize(spec) || terminator ? neutralizeHeredocLine(line) : line);
        if (terminator) break;
        index += 1;
      }
    }
  }
  return maskedLines.join("\n");
}

function maskQuotedHeredocBodies(command) {
  return maskHeredocBodies(command, (spec) => spec.quoted);
}

function maskAllHeredocBodies(command) {
  return maskHeredocBodies(command, () => true);
}

function maskHttpUris(command) {
  let masked = "";
  for (let index = 0; index < command.length;) {
    const prefix = command.slice(index, index + "https://".length).toLowerCase();
    const schemeLength = prefix.startsWith("https://") ? "https://".length : prefix.startsWith("http://") ? "http://".length : 0;
    if (schemeLength === 0) {
      masked += command[index];
      index += 1;
      continue;
    }
    let end = index + schemeLength;
    while (end < command.length) {
      const character = command[end];
      if (character === "\\" && end + 1 < command.length) {
        end += 2;
      } else if (/\s|["';|&()<>]/.test(character)) {
        break;
      } else {
        end += 1;
      }
    }
    masked += "_".repeat(end - index);
    index = end;
  }
  return masked;
}

// Quoted prose may contain shell-looking separators. Preserve only a quoted
// word's leading path signal; neutralize its interior delimiters for checks.
function quoteAwarePathCommands(command) {
  let absolutePathCommand = "";
  let pathCommand = "";
  let quote = null;
  let quoteAtWordStart = false;
  let quoteHasContent = false;
  let wordHasContent = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === null) {
      if (character === "\\" && (command[index + 1] === "'" || command[index + 1] === '"')) {
        absolutePathCommand += "__";
        pathCommand += "__";
        wordHasContent = true;
        index += 1;
      } else if (character === "'" || character === '"') {
        quote = character;
        quoteAtWordStart = !wordHasContent;
        quoteHasContent = false;
        const rendered = quoteAtWordStart ? character : "_";
        absolutePathCommand += rendered;
        pathCommand += rendered;
      } else {
        absolutePathCommand += character;
        pathCommand += character;
        wordHasContent = !BASH_BOUNDARY_CHARACTER_PATTERN.test(character);
      }
      continue;
    }

    if (quote === '"' && character === "\\" && index + 1 < command.length) {
      absolutePathCommand += "__";
      pathCommand += "__";
      quoteHasContent = true;
      index += 1;
    } else if (character === quote) {
      pathCommand += character;
      absolutePathCommand += quoteAtWordStart && !quoteHasContent && !wordHasContent ? character : "_";
      wordHasContent ||= quoteHasContent;
      quote = null;
    } else {
      quoteHasContent = true;
      const rendered = BASH_BOUNDARY_CHARACTER_PATTERN.test(character) ? "_" : character;
      absolutePathCommand += rendered;
      pathCommand += rendered;
    }
  }

  return { absolutePathCommand, pathCommand };
}

function bashViolation(command, workspace) {
  // Evaluation agents normally enter their isolated workspace by absolute path.
  // Mask only that exact root (and its realpath alias) before path-escape
  // checks; paths below it still expose `..`, and every other absolute path
  // remains subject to the existing policy.
  const quotedHeredocMaskedCommand = maskQuotedHeredocBodies(command);
  const maskedPathCommand = maskSafeDevicePaths(maskWorkspacePaths(quotedHeredocMaskedCommand, workspace));
  const { absolutePathCommand, pathCommand } = quoteAwarePathCommands(maskedPathCommand);
  if (BASH_ABSOLUTE_PATH_PATTERN.test(absolutePathCommand)) return "bash_absolute_path";
  if (BASH_PARENT_ESCAPE_PATTERN.test(pathCommand)) return "bash_parent_escape";
  const pathSensitiveChecks = [
    ["bash_home_or_pi_discovery", BASH_HOME_OR_PI_PATTERN],
    ["bash_eval_run_discovery", BASH_EVAL_RUN_PATTERN],
  ];
  for (const [code, pattern] of pathSensitiveChecks) {
    if (pattern.test(pathCommand)) return code;
  }
  const checks = [
    ["bash_process_or_env_discovery", BASH_SENSITIVE_ENVIRONMENT_KEY_PATTERN],
    ["bash_process_or_env_discovery", BASH_WHOLE_ENVIRONMENT_PATTERN],
    ["bash_process_or_env_discovery", BASH_PROCESS_OR_ENV_DISCOVERY_PATTERN],
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
    const code = bashViolation(command, workspace);
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
    if (event.toolName === "bash" && typeof event.input.command === "string") {
      const originalCommand = event.input.command;
      const rewrittenCommand = rewriteWorkspaceTempPaths(originalCommand, workspace);
      if (rewrittenCommand !== originalCommand) {
        const tempDirectory = workspaceTempDirectory(workspace);
        mkdirSync(tempDirectory, { recursive: true });
        event.input.command = rewrittenCommand;
        appendAudit(auditPath, {
          type: "bash_temp_rewritten",
          toolCallId: event.toolCallId,
          originalCommandSha256: sha256(originalCommand),
          rewrittenCommandSha256: sha256(rewrittenCommand),
          workspaceTempSha256: sha256(tempDirectory),
        });
      }
    }
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
