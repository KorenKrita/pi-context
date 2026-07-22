#!/usr/bin/env bun
// Run the standard long ACM activation flow, then LLM-judge it.
//
// Usage:
//   bun eval/run-flow.mjs [--model provider/id] [--thinking level] [--variant label]
//                         [--context-window N] [--max-tokens-cap N] [--pi-binary path]
//                         [--agent-label label] [--flow-seed seed] [--matrix-id id]
//                         [--judge-model provider/id] [--judge-agent-label label]
//                         [--judge-thinking level] [--no-judge] [--extension path]
//                         [--skill path] [--environment-mode core-only|product-isolated|agents-only|full-env]
//                         [--source-agent-dir path] [--harness-dir path] [--runs-dir path]
//                         [--audit-only]
//
// Two comparison axes both come from this one command:
//   • same models × different code/prompt versions — hold --model, change what
//     is checked out in the repo (or point --extension at a different build),
//     vary --variant to label the run;
//   • same prompt × different models — hold --variant, vary --model.
//
// Writes eval/.runs/<stamp>-flow-<model>/{report.json, transcript.txt, verdict.json}.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  buildAgentDir,
  buildAgentsOnlyAgentDir,
  buildEvaluationExtensionPlan,
  buildFullEnvAgentDir,
  assertAgentsOnlyCheckoutResources,
  assertFullEnvCheckoutExtensions,
  CONTEXT_EXTENSION_PATH,
  CONTEXT_MANAGEMENT_SKILL_PATH,
  captureProjectAgentsEvidence,
  createRunDir,
  EVAL_ROOT,
  EXTENSION_PATH,
  INTEGRITY_GUARD_PATH,
  readAgentsOnlyHarnessAudit,
  readFullEnvHarnessAudit,
} from "./setup.mjs";
import {
  buildPiRpcArgs,
  classifySkillAvailability,
  finalAssistantOutcome,
  FULL_ENV_DENIED_TOOLS,
  normalizeEnvironmentMode,
  PiRpcDriver,
} from "./driver.mjs";
import { extractAssistantTranscript, extractToolCalls, extractTranscriptSegments } from "./scenarios.mjs";
import { createFlowWorkspace } from "./scenario-workspace.mjs";
import { getFlow, listFlows } from "./flow.mjs";
import { buildTranscript, JUDGE_MODEL, judgeRun, RUBRIC_VERSION, writeJsonAtomically } from "./judge.mjs";
import { ACM_CORE_MARKER, integrityAuditFailures, readIntegrityAudit, workspaceTempDirectory } from "./integrity-guard.mjs";
import { classifySeatbeltSupport, writeEvaluationSeatbeltProfiles } from "./seatbelt.mjs";
import { acquireExclusiveEvaluationLock } from "./exclusive-lock.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function flag(name) {
  return process.argv.includes(name);
}
function parseModel(raw, dflt) {
  if (!raw) return dflt;
  const slash = raw.indexOf("/");
  return slash < 0
    ? { provider: "local-openai", modelId: raw }
    : { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileEvidence(path) {
  if (!path || !existsSync(path)) return { path: path ?? null, exists: false, realpath: null, sha256: null };
  const content = readFileSync(path, "utf8");
  return { path, exists: true, realpath: realpathSync(path), sha256: sha256(content) };
}

function firstMarkdownHeading(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split(/\r?\n/).find((line) => /^#\s+\S/.test(line)) ?? null;
}

function resolveExecutable(binary) {
  if (binary.includes("/")) {
    try {
      return realpathSync(binary);
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, binary);
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

function piBinaryEvidence(binary) {
  let version = null;
  let versionError = null;
  try {
    version = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch (error) {
    versionError = error instanceof Error ? error.message : String(error);
  }
  return { requested: binary, realpath: resolveExecutable(binary), version, versionError };
}

function harnessModelEntry(agentDir, model) {
  const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
  return models.providers?.[model.provider]?.models?.find((entry) => entry.id === model.modelId) ?? null;
}

function classifyCheckoutContextCommand(commands) {
  const expectsContextExtension = extensionPaths.some((path) => {
    try {
      return realpathSync(path) === realpathSync(CONTEXT_EXTENSION_PATH);
    } catch {
      return path === CONTEXT_EXTENSION_PATH;
    }
  });
  if (!expectsContextExtension) return { valid: true, status: "not_requested", matches: [] };
  const matches = (commands ?? []).filter((command) => command?.name === "context");
  if (matches.length !== 1) {
    return {
      valid: false,
      status: matches.length === 0 ? "missing" : "duplicate",
      reason: `expected exactly one checkout context command, found ${matches.length}`,
      matches,
    };
  }
  const command = matches[0];
  if (command.source !== "extension") {
    return { valid: false, status: "wrong_source", reason: "context command must have source=extension", matches };
  }
  try {
    const expectedPath = realpathSync(CONTEXT_EXTENSION_PATH);
    const actualPath = realpathSync(command.sourceInfo?.path);
    if (actualPath !== expectedPath) {
      return { valid: false, status: "path_mismatch", reason: `context command path ${actualPath} does not match ${expectedPath}`, matches };
    }
    return { valid: true, status: "available_from_expected_checkout", matches, expectedPath, actualPath };
  } catch (error) {
    return {
      valid: false,
      status: "provenance_unresolved",
      reason: error instanceof Error ? error.message : String(error),
      matches,
    };
  }
}

function hookFunction(holder, name) {
  const hook = holder?.[name];
  if (hook === undefined) return null;
  if (typeof hook !== "function") throw new Error(`${name} must be a function when supplied by a flow`);
  return hook;
}

async function invokeHook(holder, name, context) {
  const hook = hookFunction(holder, name);
  return hook ? await hook(context) : null;
}

async function runHostActions(actions, context) {
  if (!actions) return [];
  const list = Array.isArray(actions) ? actions : [actions];
  const results = [];
  for (const action of list) {
    if (typeof action === "function") {
      results.push({ type: "function", result: await action(context) });
      continue;
    }
    if (action?.type === "compact") {
      results.push({
        type: "compact",
        result: await context.driver.compact(action.customInstructions),
      });
      continue;
    }
    throw new Error(`unknown flow host action: ${String(action?.type)}`);
  }
  return results;
}

async function captureTurnTelemetry(driver) {
  const [state, sessionStats] = await Promise.all([driver.getState(), driver.getSessionStats()]);
  return { state, sessionStats };
}

const modelSpec = parseModel(option("--model") ?? process.env.ACM_EVAL_MODEL, {
  provider: "local-openai",
  modelId: "mimo-v2.5",
});
const thinkingLevel = option("--thinking") ?? process.env.ACM_EVAL_THINKING ?? "off";
const variant = option("--variant") ?? process.env.ACM_EVAL_VARIANT ?? "HEAD";
const contextWindow = positiveInteger(option("--context-window") ?? 60000, "--context-window");
const maxTokensCap = positiveInteger(option("--max-tokens-cap") ?? process.env.ACM_EVAL_MAX_TOKENS_CAP ?? 16000, "--max-tokens-cap");
const shrink = !flag("--native"); // --native keeps the model's real window; the % nudge then rarely fires
const piBinary = option("--pi-binary") ?? process.env.ACM_PI_BINARY ?? "pi";
const auditOnly = flag("--audit-only");
const requestedEnvironmentMode = option("--environment-mode");
const fullEnvAlias = flag("--full-env");
if (requestedEnvironmentMode && fullEnvAlias && requestedEnvironmentMode !== "full-env") {
  throw new Error("--full-env conflicts with --environment-mode other than full-env");
}
const environmentMode = normalizeEnvironmentMode({
  environmentMode: requestedEnvironmentMode ?? (fullEnvAlias ? "full-env" : undefined),
});
const fullEnv = environmentMode === "full-env";
const agentsOnly = environmentMode === "agents-only";
const judgeModel = parseModel(option("--judge-model"), JUDGE_MODEL);
const judgeThinking = option("--judge-thinking") ?? "high";
const requestedJudgeAgentLabel = option("--judge-agent-label") ?? process.env.ACM_JUDGE_LABEL;
const doJudge = !flag("--no-judge");
const extensionPath = option("--extension") ?? EXTENSION_PATH;
const skillPath = option("--skill") ?? CONTEXT_MANAGEMENT_SKILL_PATH;
const { productExtensionPaths, measurementExtensionPaths, extensionPaths } = buildEvaluationExtensionPlan({
  environmentMode,
  coreExtensionPath: extensionPath,
  contextExtensionPath: CONTEXT_EXTENSION_PATH,
  integrityGuardPath: INTEGRITY_GUARD_PATH,
});
const checkoutExtensionConstraint = assertFullEnvCheckoutExtensions({
  environmentMode,
  coreExtensionPath: extensionPath,
  contextExtensionPath: CONTEXT_EXTENSION_PATH,
  expectedCoreExtensionPath: EXTENSION_PATH,
  expectedContextExtensionPath: CONTEXT_EXTENSION_PATH,
});
const agentsOnlyCheckoutConstraint = assertAgentsOnlyCheckoutResources({
  environmentMode,
  coreExtensionPath: extensionPath,
  contextExtensionPath: CONTEXT_EXTENSION_PATH,
  measurementGuardPath: INTEGRITY_GUARD_PATH,
  skillPath,
  expectedCoreExtensionPath: EXTENSION_PATH,
  expectedContextExtensionPath: CONTEXT_EXTENSION_PATH,
  expectedMeasurementGuardPath: INTEGRITY_GUARD_PATH,
  expectedSkillPath: CONTEXT_MANAGEMENT_SKILL_PATH,
});
const skillPaths = environmentMode === "core-only" || environmentMode === "raw-control" ? [] : [skillPath];
const expectedSkillPath = (() => {
  try {
    return realpathSync(skillPath);
  } catch {
    return null;
  }
})();
const timeoutScale = Number(option("--timeout-scale") ?? 1);
const flowSeed = option("--flow-seed") ?? process.env.ACM_FLOW_SEED;
const matrixId = option("--matrix-id") ?? process.env.ACM_MATRIX_ID ?? null;
const declaredFlow = getFlow(option("--flow") ?? process.env.ACM_EVAL_FLOW ?? "exprlang-long-flow");
if (!declaredFlow) {
  throw new Error(`unknown --flow; known flows: ${listFlows().map((f) => f.id).join(", ")}`);
}

let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: join(extensionPath, "..", ".."), encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }

const requestedAgentLabel = option("--agent-label") ?? process.env.ACM_AGENT_LABEL;
const sourceAgentDir = option("--source-agent-dir");
const harnessDir = option("--harness-dir");
const runsDir = option("--runs-dir");
const agentsLockTimeoutMs = Number(option("--agents-lock-timeout-ms") ?? 5000);
const agentLabel = requestedAgentLabel
  ?? `flow-${declaredFlow.id}-${modelSpec.modelId.replace(/[^a-z0-9]+/gi, "-")}-cw${contextWindow}-p${process.pid}`;
const judgeAgentLabel = `${requestedJudgeAgentLabel ?? `${agentLabel}-judge`}-p${process.pid}`;
const agentDir = fullEnv
  ? buildFullEnvAgentDir({ contextWindow, maxTokensCap, shrink, label: agentLabel })
  : agentsOnly
    ? buildAgentsOnlyAgentDir({
        contextWindow,
        maxTokensCap,
        shrink,
        label: agentLabel,
        ...(sourceAgentDir ? { sourceAgentDir } : {}),
        ...(harnessDir ? { harnessDir } : {}),
      })
    : buildAgentDir({ contextWindow, maxTokensCap, shrink, label: agentLabel });
const runDir = createRunDir(`flow-${modelSpec.modelId}`, runsDir ? { runsDir } : undefined);
const integrityAuditPath = fullEnv || agentsOnly ? join(runDir, "integrity-audit.jsonl") : null;
const privateEvalRoot = join(homedir(), ".codex", "private", "pi-context-eval");
const evaluationLock = agentsOnly
  ? await acquireExclusiveEvaluationLock({
      path: join(privateEvalRoot, "agents-only-formal.lock"),
      owner: { agentLabel, flowId: declaredFlow.id, matrixId, runDir },
      timeoutMs: Number.isFinite(agentsLockTimeoutMs) && agentsLockTimeoutMs >= 0 ? agentsLockTimeoutMs : 5000,
    })
  : null;
const lockEvidence = () => evaluationLock ? {
  acquired: evaluationLock.acquired,
  path: evaluationLock.path,
  owner: evaluationLock.owner,
  currentOwner: evaluationLock.currentOwner ?? null,
  recovered: evaluationLock.recovered ?? false,
  recoveredOwners: evaluationLock.recoveredOwners ?? [],
  released: evaluationLock.released,
  releasedAt: evaluationLock.releasedAt,
} : null;
if (agentsOnly && !evaluationLock.acquired) {
  const reason = `agents-only formal lock is held by ${evaluationLock.currentOwner?.agentLabel ?? evaluationLock.currentOwner?.pid ?? "another cell"}`;
  const earlyReport = {
    status: "infrastructure_invalid",
    flowId: declaredFlow.id,
    matrixId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: modelSpec,
    thinkingLevel,
    variant,
    environmentMode,
    agentsOnly: true,
    agentLabel,
    lock: lockEvidence(),
    workspace: null,
    turns: [],
    infrastructureInvalid: {
      status: "agents_only_lock_unavailable",
      reason,
      failures: [{ status: "agents_only_lock_unavailable", reason }],
    },
    runError: null,
    judge: { skipped: true, reason: "infrastructure_invalid" },
  };
  writeJsonAtomically(join(runDir, "report.json"), earlyReport);
  writeFileSync(join(runDir, "transcript.txt"), "");
  console.log(`\n=== infrastructure invalid: agents_only_lock_unavailable ===`);
  console.log(`  ${reason}`);
  console.log(`\nreport: ${join(runDir, "report.json")}`);
  console.log(`transcript: ${join(runDir, "transcript.txt")}`);
  process.exit(1);
}
const releaseEvaluationLock = () => evaluationLock?.release();
const releaseOnSignal = (signal) => {
  releaseEvaluationLock();
  process.off(signal, signalHandlers[signal]);
  process.kill(process.pid, signal);
};
const signalHandlers = {
  SIGINT: () => releaseOnSignal("SIGINT"),
  SIGTERM: () => releaseOnSignal("SIGTERM"),
};
if (evaluationLock?.acquired) {
  process.once("exit", releaseEvaluationLock);
  process.once("SIGINT", signalHandlers.SIGINT);
  process.once("SIGTERM", signalHandlers.SIGTERM);
}
// Keep every model-visible workspace out of eval/.runs. Otherwise a flow can
// traverse into persisted events/session artifacts from an earlier phase and
// invalidate environment isolation. Retain the directory for post-run evidence.
const workspace = createFlowWorkspace({ flowId: declaredFlow.id, environmentMode });
cpSync(declaredFlow.seedDir, workspace, { recursive: true });
// Context discovery remains on in agents-only. Preserve the fixture/project
// AGENTS.md as its task contract alongside the copied global AGENTS.md, then
// retain independent hash evidence for both context layers in the report.
const agentsOnlyProjectAgents = agentsOnly ? captureProjectAgentsEvidence(workspace) : null;
const materializedFlow = await invokeHook(declaredFlow, "materialize", {
  flow: declaredFlow,
  seed: flowSeed,
  flowSeed,
  matrixId,
  variant,
  runDir,
  workspace,
  contextWindow,
  maxTokensCap,
  environmentMode,
  model: modelSpec,
  thinkingLevel,
});
const flow = materializedFlow && typeof materializedFlow === "object"
  ? { ...declaredFlow, ...materializedFlow }
  : declaredFlow;
if (!Array.isArray(flow.turns) || flow.turns.length === 0) {
  throw new Error(`materialized flow ${flow.id} must provide a non-empty turns array`);
}
const sandboxRequired = agentsOnly;
const sandboxSupported = process.platform === "darwin";
const sandboxExecutable = "/usr/bin/sandbox-exec";
const sandboxExecutableExists = existsSync(sandboxExecutable);
const sandboxProfiles = sandboxRequired && sandboxSupported
  ? writeEvaluationSeatbeltProfiles({
      workspace,
      runDir,
      agentDir,
      harnessRoot: dirname(agentDir),
      runsRoot: dirname(runDir),
      tempRoot: dirname(workspace),
      homeDir: homedir(),
      evalRoot: EVAL_ROOT,
      privateEvalRoot,
    })
  : null;
const sandboxSupport = classifySeatbeltSupport({
  agentsOnly,
  platform: process.platform,
  executableExists: sandboxExecutableExists,
  profilesExist: sandboxProfiles?.outer.exists === true && sandboxProfiles?.tool.exists === true,
});
const sandboxEvidence = agentsOnly
  ? {
      ...sandboxSupport,
      executable: sandboxExecutable,
      executableExists: sandboxExecutableExists,
      profilePath: sandboxProfiles?.outer.path ?? null,
      profileSha256: sandboxProfiles?.outer.profileSha256 ?? null,
      deniedRoots: sandboxProfiles?.outer.deniedRoots ?? [],
      currentRoots: sandboxProfiles?.outer.currentRoots ?? [],
      outerProfile: sandboxProfiles ? {
        path: sandboxProfiles.outer.path,
        sha256: sandboxProfiles.outer.profileSha256,
        deniedRoots: sandboxProfiles.outer.deniedRoots,
        currentRoots: sandboxProfiles.outer.currentRoots,
      } : null,
      toolProfile: sandboxProfiles ? {
        path: sandboxProfiles.tool.path,
        sha256: sandboxProfiles.tool.profileSha256,
        deniedRoots: sandboxProfiles.tool.deniedRoots,
        currentRoots: sandboxProfiles.tool.currentRoots,
      } : null,
      privateEvalRoot,
      scope: "evaluation-sensitive filesystem roots present before this sequential run",
    }
  : null;
const workspaceTmpDir = agentsOnly ? workspaceTempDirectory(workspace) : null;
if (workspaceTmpDir) mkdirSync(workspaceTmpDir, { recursive: true });
const fullEnvHarnessAudit = fullEnv ? readFullEnvHarnessAudit(agentDir) : null;
const agentsOnlyHarnessAudit = agentsOnly ? readAgentsOnlyHarnessAudit(agentDir) : null;
const integrityRequiredMarkers = fullEnv || agentsOnly
  ? [
      { id: "acm_core_marker", value: ACM_CORE_MARKER, exact: 1 },
      ...(
        firstMarkdownHeading(join(agentDir, "AGENTS.md"))
          ? [{ id: "global_agents_heading", value: firstMarkdownHeading(join(agentDir, "AGENTS.md")), min: 1 }]
          : []
      ),
      ...(
        firstMarkdownHeading(join(workspace, "AGENTS.md"))
          ? [{ id: "project_agents_heading", value: firstMarkdownHeading(join(workspace, "AGENTS.md")), min: 1 }]
          : []
      ),
    ]
  : [];
const resourceEvidence = {
  extensions: extensionPaths.map(fileEvidence),
  productExtensions: productExtensionPaths.map(fileEvidence),
  measurementExtensions: measurementExtensionPaths.map(fileEvidence),
  measurementGuard: measurementExtensionPaths.length === 1 ? fileEvidence(measurementExtensionPaths[0]) : null,
  sandbox: sandboxEvidence,
  skill: skillPaths.map(fileEvidence),
  fullEnvHarness: fullEnvHarnessAudit,
  checkoutExtensionConstraint,
  promptMarkers: integrityRequiredMarkers.map((marker) => ({
    id: marker.id,
    exact: marker.exact,
    min: marker.min,
    sha256: sha256(marker.value),
  })),
  ...(agentsOnly
    ? {
        agentsOnlyHarness: agentsOnlyHarnessAudit,
        agentsOnlyProjectAgents,
        agentsOnlyCheckoutConstraint,
      }
    : {}),
};
const binaryEvidence = piBinaryEvidence(piBinary);
const driverArgs = buildPiRpcArgs({
  cwd: workspace,
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPaths,
  skillPaths,
  environmentMode,
  provider: modelSpec.provider,
  modelId: modelSpec.modelId,
  thinkingLevel,
});

console.log(`flow=${flow.id} model=${modelSpec.provider}/${modelSpec.modelId} thinking=${thinkingLevel}`);
console.log(`variant=${variant} gitHead=${gitHead} context=${shrink ? contextWindow : "native"} maxTokensCap=${maxTokensCap} environment=${environmentMode}`);
console.log(`pi=${binaryEvidence.realpath ?? binaryEvidence.requested} version=${binaryEvidence.version ?? "unavailable"} agentLabel=${agentLabel}`);
console.log(`run dir: ${runDir}`);

const driver = new PiRpcDriver({
  cwd: workspace,
  agentDir,
  sessionDir: join(runDir, "sessions"),
  extensionPaths,
  skillPaths,
  environmentMode,
  provider: modelSpec.provider,
  modelId: modelSpec.modelId,
  thinkingLevel,
  piBinary,
  sandboxProfilePath: sandboxEvidence?.enabled ? sandboxEvidence.profilePath : undefined,
  eventLogPath: join(runDir, "events.jsonl"),
  env: fullEnv || agentsOnly
    ? {
        ACM_INTEGRITY_AUDIT_PATH: integrityAuditPath,
        ACM_INTEGRITY_REQUIRED_MARKERS: JSON.stringify(integrityRequiredMarkers),
        ...(sandboxEvidence?.toolProfile?.path ? { ACM_INTEGRITY_TOOL_SANDBOX_PROFILE: sandboxEvidence.toolProfile.path } : {}),
        ACM_INTEGRITY_WORKSPACE: workspace,
        ACM_INTEGRITY_APPROVED_SKILL_ROOTS: JSON.stringify(skillPaths.map((path) => dirname(path))),
        ...(workspaceTmpDir ? { TMPDIR: workspaceTmpDir } : {}),
      }
    : undefined,
});

const turnRecords = [];
let runError = null;
let commands = null;
let skillAvailability = null;
let extensionAvailability = null;
let infrastructureInvalid = null;
let runtimeAudit = null;
let deterministicVerification = null;
let integrityAudit = [];
let afterStopResult = null;
const started = Date.now();

function appendConstraintFailure(failures, condition, status, reason) {
  if (!condition) failures.push({ status, reason });
}

function mergeInfrastructureFailures(current, failures) {
  if (failures.length === 0) return current;
  const existingFailures = current?.failures ?? (current ? [{ status: current.status, reason: current.reason }] : []);
  const combined = [...existingFailures, ...failures].filter((failure, index, all) => (
    all.findIndex((candidate) => candidate.status === failure.status && candidate.reason === failure.reason) === index
  ));
  const primary = current ?? failures[0];
  return { status: primary.status, reason: primary.reason, failures: combined };
}

function staticAuditFailures() {
  const failures = [];
  appendConstraintFailure(failures, binaryEvidence.version !== null, "pi_binary_unavailable", binaryEvidence.versionError ?? `could not execute ${piBinary}`);
  for (const extension of resourceEvidence.extensions) {
    appendConstraintFailure(failures, extension.exists, "extension_missing", `checkout extension missing: ${extension.path ?? "unknown"}`);
  }
  for (const skill of resourceEvidence.skill) {
    appendConstraintFailure(failures, skill.exists, "skill_missing", `checkout Skill missing: ${skill.path ?? "unknown"}`);
  }
  if (agentsOnly) {
    const audit = agentsOnlyHarnessAudit;
    appendConstraintFailure(failures, audit !== null, "agents_only_audit_missing", "agents-only harness did not record its resource audit");
    if (!audit) return failures;
    appendConstraintFailure(failures, audit.environmentMode === "agents-only", "agents_only_audit_mode_mismatch", "agents-only harness audit recorded the wrong mode");
    appendConstraintFailure(failures, audit.globalAgents?.source?.exists === true && audit.globalAgents?.harness?.exists === true, "agents_only_global_agents_missing", "agents-only requires a copied global AGENTS.md");
    appendConstraintFailure(failures, audit.globalAgents?.source?.sha256 === audit.globalAgents?.harness?.sha256, "agents_only_global_agents_hash_mismatch", "agents-only harness AGENTS.md does not match its global source");
    appendConstraintFailure(failures, audit.auth?.source?.exists === true && audit.auth?.harness?.exists === true, "agents_only_auth_missing", "agents-only requires copied real authentication");
    appendConstraintFailure(failures, audit.auth?.source?.sha256 === audit.auth?.harness?.sha256, "agents_only_auth_hash_mismatch", "agents-only harness auth does not match its global source");
    appendConstraintFailure(failures, Array.isArray(audit.settings?.packages) && audit.settings.packages.length === 0, "agents_only_packages_present", "agents-only settings must contain no packages");
    appendConstraintFailure(failures, audit.sessionRecall?.packagePresent === false && audit.sessionRecall?.configPresent === false, "agents_only_session_recall_present", "agents-only must exclude session recall by construction");
    appendConstraintFailure(failures, !existsSync(join(agentDir, "session-recall.json")), "agents_only_session_recall_config_present", "agents-only harness contains session-recall.json");
    for (const ambientResource of ["extensions", "skills", "themes", "agents", "git", "npm", "bin", "mcp.json", "mcp-cache.json", "pi.env"]) {
      appendConstraintFailure(failures, !existsSync(join(agentDir, ambientResource)), "agents_only_ambient_resource_present", `agents-only harness contains ambient resource ${ambientResource}`);
    }
    const expectedGuards = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];
    for (const guard of expectedGuards) {
      appendConstraintFailure(failures, driverArgs.includes(guard), "agents_only_discovery_guard_missing", `agents-only must pass ${guard}`);
    }
    appendConstraintFailure(failures, !driverArgs.includes("--no-context-files"), "agents_only_context_files_disabled", "agents-only must retain context-file discovery for global AGENTS.md");
    const measurementGuardCount = extensionPaths.filter((path) => path === INTEGRITY_GUARD_PATH).length;
    const measurementGuardArgCount = driverArgs.filter((arg) => arg === INTEGRITY_GUARD_PATH).length;
    appendConstraintFailure(failures, measurementGuardCount === 1, "agents_only_integrity_guard_load_mismatch", `agents-only must configure exactly one measurement guard, found ${measurementGuardCount}`);
    appendConstraintFailure(failures, measurementGuardArgCount === 1, "agents_only_integrity_guard_arg_mismatch", `agents-only must pass exactly one measurement guard CLI path, found ${measurementGuardArgCount}`);
    if (!sandboxSupported) {
      appendConstraintFailure(failures, false, "agents_only_sandbox_unsupported", `agents-only formal evidence requires macOS Seatbelt; platform is ${process.platform}`);
    } else if (sandboxRequired) {
      appendConstraintFailure(failures, sandboxExecutableExists, "agents_only_sandbox_executable_missing", `${sandboxExecutable} is required for agents-only on Darwin`);
      appendConstraintFailure(failures, sandboxEvidence?.enabled === true, "agents_only_sandbox_profile_missing", "agents-only requires an enabled Seatbelt profile on Darwin");
    }
    return failures;
  }
  if (!fullEnv) return failures;

  const audit = fullEnvHarnessAudit;
  appendConstraintFailure(failures, audit !== null, "full_env_audit_missing", "full-env harness did not record its resource audit");
  if (!audit) return failures;
  const sanitizedIdentities = new Set(audit.settings?.sanitizedPackages?.map((entry) => entry.identity));
  const removedIdentities = new Set(audit.settings?.removedPackages?.map((entry) => entry.identity));
  appendConstraintFailure(failures, !sanitizedIdentities.has("github.com/korenkrita/pi-context") && !sanitizedIdentities.has("npm:pi-context"), "installed_pi_context_present", "sanitized full-env settings still include installed pi-context");
  appendConstraintFailure(failures, !sanitizedIdentities.has("npm:@ogulcancelik/pi-session-recall"), "session_recall_present", "sanitized full-env settings still include pi-session-recall");
  appendConstraintFailure(failures, removedIdentities.has("github.com/korenkrita/pi-context"), "installed_pi_context_not_removed", "installed pi-context package was not removed from full-env settings");
  appendConstraintFailure(failures, removedIdentities.has("npm:@ogulcancelik/pi-session-recall"), "session_recall_not_removed", "pi-session-recall package was not removed from full-env settings");
  appendConstraintFailure(failures, !existsSync(join(agentDir, "session-recall.json")), "session_recall_config_copied", "session-recall.json must not be copied into a sanitized full-env harness");
  appendConstraintFailure(failures, audit.globalAgents?.source?.exists === true && audit.globalAgents?.harness?.exists === true, "global_agents_missing", "full-env requires a copied global AGENTS.md");
  appendConstraintFailure(failures, audit.globalAgents?.source?.sha256 === audit.globalAgents?.harness?.sha256, "global_agents_hash_mismatch", "harness AGENTS.md does not match the global source");
  appendConstraintFailure(failures, audit.excludedFiles?.includes("mcp.json") === true, "mcp_boundary_missing", "full-env-minus-MCP audit must record mcp.json exclusion");
  appendConstraintFailure(failures, audit.excludedFiles?.includes("mcp-cache.json") === true, "mcp_cache_boundary_missing", "full-env-minus-MCP audit must record mcp-cache.json exclusion");
  for (const requiredConfig of ["command-blacklist.json", "pi-autoname.json", "pistatusline.json"]) {
    const config = audit.rootConfigs?.find((entry) => entry.name === requiredConfig);
    appendConstraintFailure(failures, config !== undefined, "global_extension_config_missing", `full-env did not copy ${requiredConfig}`);
    if (config) {
      appendConstraintFailure(failures, config.source?.sha256 === config.harness?.sha256, "global_extension_config_hash_mismatch", `${requiredConfig} hash changed in the harness`);
    }
  }
  const exclusionIndex = driverArgs.indexOf("--exclude-tools");
  appendConstraintFailure(
    failures,
    exclusionIndex >= 0 && driverArgs[exclusionIndex + 1] === FULL_ENV_DENIED_TOOLS.join(","),
    "full_env_tool_denylist_missing",
    `full-env must deny ${FULL_ENV_DENIED_TOOLS.join(",")}`,
  );
  return failures;
}

function commandInventoryFrom(commands) {
  const globalExtensions = (commands ?? [])
    .filter((command) => command?.source === "extension" && command.sourceInfo?.scope !== "temporary")
    .map((command) => ({ name: command.name, sourceInfo: command.sourceInfo }));
  const globalSkills = (commands ?? [])
    .filter((command) => command?.source === "skill" && command.sourceInfo?.scope !== "temporary")
    .map((command) => ({ name: command.name, sourceInfo: command.sourceInfo }));
  return { globalExtensions, globalSkills };
}

function effectiveRuntimeFailures(state, availableModels, availableThinkingLevels, configuredModel, commandInventory) {
  const failures = [];
  const selectedModel = state?.model;
  appendConstraintFailure(
    failures,
    selectedModel?.provider === modelSpec.provider && selectedModel?.id === modelSpec.modelId,
    "model_mismatch",
    `Pi selected ${selectedModel?.provider ?? "unknown"}/${selectedModel?.id ?? "unknown"}, expected ${modelSpec.provider}/${modelSpec.modelId}`,
  );
  appendConstraintFailure(failures, Array.isArray(availableModels), "model_catalog_unavailable", "get_available_models did not return a model array");
  appendConstraintFailure(failures, Array.isArray(availableThinkingLevels), "thinking_levels_unavailable", "get_available_thinking_levels did not return an array");
  appendConstraintFailure(
    failures,
    Array.isArray(availableThinkingLevels) && availableThinkingLevels.includes(thinkingLevel),
    "thinking_level_unavailable",
    `requested thinking level ${thinkingLevel} is not available for ${modelSpec.provider}/${modelSpec.modelId}`,
  );
  appendConstraintFailure(
    failures,
    state?.thinkingLevel === thinkingLevel,
    "thinking_level_mismatch",
    `Pi selected thinking level ${state?.thinkingLevel ?? "unknown"}, expected ${thinkingLevel}`,
  );
  appendConstraintFailure(failures, configuredModel !== null, "configured_model_missing", `harness models.json lacks ${modelSpec.provider}/${modelSpec.modelId}`);
  if (configuredModel && selectedModel) {
    appendConstraintFailure(
      failures,
      selectedModel.contextWindow === configuredModel.contextWindow,
      "context_window_mismatch",
      `Pi effective contextWindow ${selectedModel.contextWindow ?? "unknown"} differs from harness ${configuredModel.contextWindow ?? "unknown"}`,
    );
    appendConstraintFailure(
      failures,
      selectedModel.maxTokens === configuredModel.maxTokens,
      "max_tokens_mismatch",
      `Pi effective maxTokens ${selectedModel.maxTokens ?? "unknown"} differs from harness ${configuredModel.maxTokens ?? "unknown"}`,
    );
  }
  if (shrink && selectedModel) {
    appendConstraintFailure(
      failures,
      selectedModel.contextWindow === contextWindow,
      "requested_context_window_mismatch",
      `requested contextWindow ${contextWindow}, got ${selectedModel.contextWindow ?? "unknown"}`,
    );
    appendConstraintFailure(
      failures,
      selectedModel.maxTokens === maxTokensCap,
      "requested_max_tokens_mismatch",
      `requested maxTokensCap ${maxTokensCap}, got ${selectedModel.maxTokens ?? "unknown"}`,
    );
  }
  if (fullEnv) {
    appendConstraintFailure(failures, commandInventory.globalExtensions.length > 0, "global_extensions_missing", "full-env discovered no global extension commands");
    appendConstraintFailure(failures, commandInventory.globalSkills.length > 0, "global_skills_missing", "full-env discovered no global Skill commands");
  }
  if (agentsOnly) {
    appendConstraintFailure(failures, commandInventory.globalExtensions.length === 0, "agents_only_global_extensions_present", "agents-only discovered an ambient extension command");
    appendConstraintFailure(failures, commandInventory.globalSkills.length === 0, "agents_only_global_skills_present", "agents-only discovered an ambient Skill command");
  }
  return failures;
}

let driverStarted = false;
try {
  const staticFailures = staticAuditFailures();
  if (staticFailures.length > 0) {
    infrastructureInvalid = {
      status: staticFailures[0].status,
      reason: staticFailures[0].reason,
      failures: staticFailures,
    };
    console.log(`\n=== infrastructure invalid: ${infrastructureInvalid.status} ===`);
    console.log(`  ${infrastructureInvalid.reason}`);
  } else {
    driver.start();
    driverStarted = true;
    try {
      commands = await driver.getCommands();
      skillAvailability = classifySkillAvailability({
        environmentMode,
        expectedSkillPath,
        commands,
        realpath: realpathSync,
      });
    } catch (error) {
      skillAvailability = classifySkillAvailability({
        environmentMode,
        expectedSkillPath,
        rpcError: error instanceof Error ? error.message : String(error),
        realpath: realpathSync,
      });
    }
    extensionAvailability = classifyCheckoutContextCommand(commands);
    if (!skillAvailability.valid || !extensionAvailability.valid) {
      infrastructureInvalid = {
        status: !skillAvailability.valid ? skillAvailability.status : extensionAvailability.status,
        reason: !skillAvailability.valid
          ? skillAvailability.reason ?? skillAvailability.status
          : extensionAvailability.reason ?? extensionAvailability.status,
      };
      console.log(`\n=== infrastructure invalid: ${infrastructureInvalid.status} ===`);
      console.log(`  ${infrastructureInvalid.reason}`);
    } else {
      const [state, availableModels, availableThinkingLevels] = await Promise.all([
        driver.getState(),
        driver.getAvailableModels(),
        driver.getThinkingLevels(),
      ]);
      const configuredModel = harnessModelEntry(agentDir, modelSpec);
      const commandInventory = commandInventoryFrom(commands);
      integrityAudit = integrityAuditPath ? readIntegrityAudit(integrityAuditPath) : [];
      runtimeAudit = {
        initialState: state,
        availableModels: Array.isArray(availableModels)
          ? availableModels.filter((model) => model.provider === modelSpec.provider && model.id === modelSpec.modelId)
          : availableModels,
        availableThinkingLevels,
        configuredModel,
        requested: { contextWindow, maxTokensCap, thinkingLevel },
        commandInventory,
      };
      const runtimeFailures = [
        ...effectiveRuntimeFailures(state, availableModels, availableThinkingLevels, configuredModel, commandInventory),
        ...integrityAuditFailures(integrityAudit, { enabled: fullEnv || agentsOnly }),
      ];
      if (runtimeFailures.length > 0) {
        infrastructureInvalid = {
          status: runtimeFailures[0].status,
          reason: runtimeFailures[0].reason,
          failures: runtimeFailures,
        };
        console.log(`\n=== infrastructure invalid: ${infrastructureInvalid.status} ===`);
        console.log(`  ${infrastructureInvalid.reason}`);
      } else if (auditOnly) {
        console.log("\n=== audit-only: infrastructure valid; no model task was sent ===");
      } else {
        const runContext = { driver, flow, workspace, runDir, model: modelSpec, thinkingLevel, contextWindow, maxTokensCap, environmentMode, turnRecords };
        await invokeHook(flow, "beforeRun", runContext);
        await runHostActions(flow.beforeHostActions, runContext);
        for (const [turnIndex, turn] of flow.turns.entries()) {
          console.log(`\n=== ${turn.phase} ===`);
          const turnContext = { ...runContext, turn, turnIndex };
          const beforeTelemetry = await captureTurnTelemetry(driver);
          const beforeFlowHook = await invokeHook(flow, "beforeTurn", turnContext);
          const beforeTurnHook = await invokeHook(turn, "before", turnContext);
          const beforeHostActions = await runHostActions(turn.beforeHostActions, turnContext);
          const events = await driver.prompt(turn.prompt, { timeoutMs: Math.round((turn.timeoutMs ?? 300000) * timeoutScale) });
          const toolCalls = extractToolCalls(events);
          const assistantText = extractAssistantTranscript(events);
          const segments = extractTranscriptSegments(events);
          const outcome = finalAssistantOutcome(events);
          const settledTurnContext = { ...turnContext, events, toolCalls, assistantText, segments, outcome };
          const afterHostActions = await runHostActions(turn.afterHostActions, settledTurnContext);
          const afterTurnHook = await invokeHook(turn, "after", settledTurnContext);
          const afterFlowHook = await invokeHook(flow, "afterTurn", settledTurnContext);
          const afterTelemetry = await captureTurnTelemetry(driver);
          turnRecords.push({
            phase: turn.phase,
            prompt: turn.prompt,
            toolCalls,
            assistantText,
            segments,
            ...outcome,
            telemetry: { before: beforeTelemetry, after: afterTelemetry },
            hooks: { beforeFlowHook, beforeTurnHook, afterTurnHook, afterFlowHook },
            hostActions: { before: beforeHostActions, after: afterHostActions },
          });
          const acm = toolCalls.filter((c) => c.name.startsWith("acm_"));
          console.log(`  tools: ${toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
          if (acm.length) console.log(`  ACM: ${acm.map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(", ")}`);
          integrityAudit = integrityAuditPath ? readIntegrityAudit(integrityAuditPath) : [];
          const turnIntegrityFailures = integrityAuditFailures(integrityAudit, { enabled: fullEnv || agentsOnly, requirePromptAudit: true });
          if (turnIntegrityFailures.length > 0) {
            infrastructureInvalid = {
              status: turnIntegrityFailures[0].status,
              reason: turnIntegrityFailures[0].reason,
              failures: turnIntegrityFailures,
            };
            console.log(`\n=== infrastructure invalid: ${infrastructureInvalid.status} ===`);
            console.log(`  ${infrastructureInvalid.reason}`);
            break;
          }
        }
        if (!infrastructureInvalid) {
          await runHostActions(flow.afterHostActions, { ...runContext, turnRecords });
          await invokeHook(flow, "afterRun", { ...runContext, turnRecords });
          const verification = await invokeHook(flow, "verify", { ...runContext, turnRecords, driver });
          if (verification !== null) {
            const passed = verification !== false && verification?.pass !== false;
            deterministicVerification = { passed, result: verification };
          }
        }
      }
    }
  }
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  console.log(`  run error: ${runError}`);
} finally {
  if (driverStarted) {
    try {
      await driver.stop();
    } catch (error) {
      runError ??= `Pi stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  try {
    afterStopResult = await invokeHook(flow, "afterStop", {
      flow,
      workspace,
      runDir,
      model: modelSpec,
      thinkingLevel,
      contextWindow,
      maxTokensCap,
      environmentMode,
      turnRecords,
      infrastructureInvalid,
      runError,
    });
  } catch (error) {
    runError ??= `afterStop hook failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  integrityAudit = integrityAuditPath ? readIntegrityAudit(integrityAuditPath) : [];
  const finalIntegrityFailures = integrityAuditFailures(integrityAudit, { enabled: driverStarted && (fullEnv || agentsOnly) });
  infrastructureInvalid = mergeInfrastructureFailures(infrastructureInvalid, finalIntegrityFailures);
  releaseEvaluationLock();
  process.off("exit", releaseEvaluationLock);
  process.off("SIGINT", signalHandlers.SIGINT);
  process.off("SIGTERM", signalHandlers.SIGTERM);
}

const verificationFailed = deterministicVerification?.passed === false;
const report = {
  status: infrastructureInvalid
    ? "infrastructure_invalid"
    : runError
      ? "run_error"
      : verificationFailed
        ? "verification_failed"
        : "completed",
  flowId: flow.id,
  matrixId,
  flowSeedSha256: flowSeed ? sha256(flowSeed) : null,
  rubricVersion: RUBRIC_VERSION,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  model: modelSpec,
  thinkingLevel,
  variant,
  gitHead,
  contextWindow,
  maxTokensCap,
  shrink,
  auditOnly,
  fullEnv,
  fullEnvMinusMcp: fullEnv,
  ...(agentsOnly ? { agentsOnly: true } : {}),
  environmentMode,
  agentLabel,
  judgeAgentLabel,
  piBinary: binaryEvidence,
  driverArgs,
  extensionPaths,
  productExtensionPaths,
  measurementExtensionPaths,
  skillPaths,
  expectedSkillPath,
  resources: resourceEvidence,
  runtimeAudit,
  commands,
  skillAvailability,
  extensionAvailability,
  integrity: {
    auditPath: integrityAuditPath,
    measurementGuard: resourceEvidence.measurementGuard,
    records: integrityAudit,
  },
  sandbox: sandboxEvidence,
  lock: lockEvidence(),
  infrastructureInvalid,
  runError,
  deterministicVerification,
  afterStopResult,
  workspace, // kept outside eval/.runs for post-hoc inspection
  turns: turnRecords.map((t) => ({
    phase: t.phase,
    toolCallCount: t.toolCalls.length,
    acmCalls: t.toolCalls
      .filter((c) => c.name.startsWith("acm_"))
      .map((c) => ({
        name: c.name,
        completed: c.completed ?? false,
        isError: c.isError ?? false,
        domainError: c.details?.error ?? null,
        args: c.args,
      })),
    assistantPreview: t.assistantText.slice(0, 300),
    stopReason: t.stopReason,
    errorMessage: t.errorMessage,
    telemetry: t.telemetry,
    hooks: t.hooks,
    hostActions: t.hostActions,
  })),
};

// Build + persist the human-readable transcript regardless of judging.
const transcript = buildTranscript(turnRecords);
writeFileSync(join(runDir, "transcript.txt"), transcript);

if (!infrastructureInvalid && !runError && !verificationFailed && !auditOnly && doJudge) {
  console.log(`\n=== judging with ${judgeModel.provider}/${judgeModel.modelId} (thinking=${judgeThinking}) ===`);
  const judgeAgentDir = buildAgentDir({ shrink: false, label: judgeAgentLabel });
  const judgeSessions = join(runDir, "judge-sessions");
  const judgeWorkspace = join(runDir, "judge-workspace");
  mkdirSync(judgeSessions, { recursive: true });
  mkdirSync(judgeWorkspace, { recursive: true });
  const previousPiBinary = process.env.ACM_PI_BINARY;
  process.env.ACM_PI_BINARY = piBinary;
  try {
    const result = await judgeRun({
      turnRecords,
      opportunities: flow.turns.map((t) => ({ phase: t.phase, intent: t.intent })),
      taskCompletionDesc: flow.taskCompletionDesc,
      judgeAgentDir,
      sessionDir: judgeSessions,
      cwd: judgeWorkspace,
      model: judgeModel,
      thinkingLevel: judgeThinking,
    });
    writeJsonAtomically(join(runDir, "verdict.json"), result);
    report.judge = result.ok
      ? {
        model: judgeModel,
        piBinary: binaryEvidence,
        agentLabel: judgeAgentLabel,
        rubricVersion: result.rubricVersion,
        attempts: result.attempts,
        verdict: result.verdict,
      }
      : {
        model: judgeModel,
        piBinary: binaryEvidence,
        agentLabel: judgeAgentLabel,
        rubricVersion: result.rubricVersion,
        attempts: result.attempts,
        error: result.error,
        errors: result.errors,
        raw: result.raw,
      };
    if (result.ok) {
      const v = result.verdict;
      console.log(`\n=== verdict (${RUBRIC_VERSION}) ===`);
      for (const [dim, d] of Object.entries(v.dimensions ?? {})) {
        console.log(`  ${dim}: ${d.score}/3 [${d.attribution}] ${d.note ?? ""}`);
      }
      console.log(`  overall: ${v.overall?.score}/3 tier=${v.overall?.modelTier}`);
      console.log(`  topAttributions: ${(v.topAttributions ?? []).join(", ")}`);
      console.log(`  summary: ${v.overall?.summary ?? ""}`);
    } else {
      console.log(`  judge invalid after ${result.attempts.length} attempts: ${result.error}`);
    }
  } catch (error) {
    report.judge = { model: judgeModel, piBinary: binaryEvidence, agentLabel: judgeAgentLabel, error: error instanceof Error ? error.message : String(error) };
    console.log(`  judge error: ${report.judge.error}`);
  } finally {
    if (previousPiBinary === undefined) delete process.env.ACM_PI_BINARY;
    else process.env.ACM_PI_BINARY = previousPiBinary;
  }
} else {
  report.judge = infrastructureInvalid
    ? { skipped: true, reason: "infrastructure_invalid" }
    : runError
      ? { skipped: true, reason: "run_error" }
    : verificationFailed
      ? { skipped: true, reason: "verification_failed" }
      : auditOnly
        ? { skipped: true, reason: "audit_only" }
        : { skipped: true };
}

writeJsonAtomically(join(runDir, "report.json"), report);
console.log(`\nreport: ${join(runDir, "report.json")}`);
console.log(`transcript: ${join(runDir, "transcript.txt")}`);
process.exit(runError || infrastructureInvalid || verificationFailed ? 1 : 0);
