// Harness environment builder.
//
// Derives an isolated PI_CODING_AGENT_DIR from the user's real ~/.pi/agent
// config: same providers and API keys, but with a harness-tuned context
// window so context-pressure behavior (nudge tiers, compaction interplay)
// is reachable in minutes instead of hours. Nothing under eval/.harness or
// eval/.runs is committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, symlinkSync, realpathSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = join(EVAL_ROOT, ".harness");
export const RUNS_DIR = join(EVAL_ROOT, ".runs");
export const EXTENSION_PATH = join(EVAL_ROOT, "..", "src", "index.ts");
export const CONTEXT_EXTENSION_PATH = join(EVAL_ROOT, "..", "src", "context.ts");
export const CONTEXT_MANAGEMENT_SKILL_PATH = join(EVAL_ROOT, "..", "skills", "context-management", "SKILL.md");
export const INTEGRITY_GUARD_PATH = join(EVAL_ROOT, "integrity-guard.mjs");
export const FULL_ENV_AUDIT_FILE = "full-env-audit.json";
export const AGENTS_ONLY_AUDIT_FILE = "agents-only-audit.json";

export function buildEvaluationExtensionPlan({
  environmentMode,
  coreExtensionPath = EXTENSION_PATH,
  contextExtensionPath = CONTEXT_EXTENSION_PATH,
  integrityGuardPath = INTEGRITY_GUARD_PATH,
}) {
  const productExtensionPaths = environmentMode === "raw-control"
    ? []
    : environmentMode === "core-only"
      ? [coreExtensionPath]
      : [coreExtensionPath, contextExtensionPath];
  const measurementExtensionPaths = environmentMode === "full-env" || environmentMode === "agents-only"
    ? [integrityGuardPath]
    : [];
  return {
    productExtensionPaths,
    measurementExtensionPaths,
    extensionPaths: [...productExtensionPaths, ...measurementExtensionPaths],
  };
}

const INSTALLED_PI_CONTEXT_IDENTITIES = new Set([
  "github.com/korenkrita/pi-context",
  "npm:pi-context",
]);
const SESSION_RECALL_PACKAGE_IDENTITY = "npm:@ogulcancelik/pi-session-recall";
const EXCLUDED_ROOT_JSON_CONFIGS = new Set([
  "auth.json",
  "full-env-audit.json",
  "mcp-cache.json",
  "mcp.json",
  "models.json",
  "session-recall.json",
  "settings.json",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function normalizedPackageIdentity(source) {
  if (typeof source !== "string") return null;
  const normalized = source.trim().toLowerCase().replace(/#.*$/, "").replace(/\.git$/, "");
  if (!normalized) return null;
  if (normalized.startsWith("npm:")) {
    const nameWithVersion = normalized.slice("npm:".length);
    if (nameWithVersion.startsWith("@")) {
      const separator = nameWithVersion.lastIndexOf("@");
      return separator > 0 ? `npm:${nameWithVersion.slice(0, separator)}` : `npm:${nameWithVersion}`;
    }
    const separator = nameWithVersion.lastIndexOf("@");
    return separator > 0 ? `npm:${nameWithVersion.slice(0, separator)}` : `npm:${nameWithVersion}`;
  }
  return normalized
    .replace(/^git\+/, "")
    .replace(/^git:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@/, "")
    .replace(/:/, "/")
    .replace(/\.git$/, "");
}

/** Return the explicitly forbidden full-environment package identity, if any. */
export function forbiddenFullEnvPackageIdentity(entry) {
  const source = packageSource(entry);
  const identity = normalizedPackageIdentity(source);
  if (!identity) return null;
  if (identity === SESSION_RECALL_PACKAGE_IDENTITY) return SESSION_RECALL_PACKAGE_IDENTITY;
  if (INSTALLED_PI_CONTEXT_IDENTITIES.has(identity)) return "github.com/korenkrita/pi-context";
  return null;
}

export function packageInventory(packages) {
  return (packages ?? []).map((entry) => ({
    source: packageSource(entry) ?? null,
    identity: normalizedPackageIdentity(packageSource(entry)),
  }));
}

/**
 * Create the only allowed delta from the real global settings for a full-env
 * evaluation: replace installed pi-context with the checkout and disable the
 * history-recall package. All other global package resources remain intact.
 */
export function sanitizeFullEnvSettings(settings) {
  const original = structuredClone(settings);
  const removedPackages = [];
  const packages = (original.packages ?? []).filter((entry) => {
    const forbiddenIdentity = forbiddenFullEnvPackageIdentity(entry);
    if (forbiddenIdentity) {
      removedPackages.push({ source: packageSource(entry) ?? null, identity: forbiddenIdentity });
      return false;
    }
    return true;
  });
  return {
    settings: { ...original, packages },
    removedPackages,
    originalPackages: packageInventory(original.packages),
    sanitizedPackages: packageInventory(packages),
  };
}

function fileSnapshot(path) {
  if (!existsSync(path)) return { path, exists: false, realpath: null, sha256: null };
  const content = readFileSync(path, "utf8");
  return { path, exists: true, realpath: realpathSync(path), sha256: sha256(content) };
}

export function readFullEnvHarnessAudit(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, FULL_ENV_AUDIT_FILE), "utf8"));
}

export function readAgentsOnlyHarnessAudit(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, AGENTS_ONLY_AUDIT_FILE), "utf8"));
}

/** Read project-level AGENTS evidence without mutating the model workspace. */
export function captureProjectAgentsEvidence(workspace) {
  return fileSnapshot(join(workspace, "AGENTS.md"));
}

/** Enforce that full-env always measures this checkout's exact ACM extensions. */
export function assertFullEnvCheckoutExtensions({
  environmentMode,
  coreExtensionPath,
  contextExtensionPath,
  expectedCoreExtensionPath,
  expectedContextExtensionPath,
  realpath = realpathSync,
}) {
  if (environmentMode !== "full-env") return { valid: true, status: "not_full_env" };
  const resolveRequired = (path, label) => {
    try {
      return realpath(path);
    } catch (error) {
      throw new Error(`${label} realpath unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const actualCore = resolveRequired(coreExtensionPath, "full-env core extension");
  const expectedCore = resolveRequired(expectedCoreExtensionPath, "expected core extension");
  if (actualCore !== expectedCore) {
    throw new Error(`full-env core extension must be ${expectedCore}, got ${actualCore}`);
  }
  const actualContext = resolveRequired(contextExtensionPath, "full-env context extension");
  const expectedContext = resolveRequired(expectedContextExtensionPath, "expected context extension");
  if (actualContext !== expectedContext) {
    throw new Error(`full-env context extension must be ${expectedContext}, got ${actualContext}`);
  }
  return {
    valid: true,
    status: "canonical_checkout_extensions",
    coreExtensionPath: actualCore,
    contextExtensionPath: actualContext,
  };
}

/**
 * agents-only admits the checked-out ACM pair and Skill plus one measurement
 * guard, but no ambient product resource. Keep every explicit CLI path tied to
 * this checkout so report hashes and runtime provenance describe one product
 * and one separately identified measurement boundary.
 */
export function assertAgentsOnlyCheckoutResources({
  environmentMode,
  coreExtensionPath,
  contextExtensionPath,
  measurementGuardPath,
  skillPath,
  expectedCoreExtensionPath,
  expectedContextExtensionPath,
  expectedMeasurementGuardPath,
  expectedSkillPath,
  realpath = realpathSync,
}) {
  if (environmentMode !== "agents-only") return { valid: true, status: "not_agents_only" };
  const resolveRequired = (path, label) => {
    try {
      return realpath(path);
    } catch (error) {
      throw new Error(`${label} realpath unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const actualCore = resolveRequired(coreExtensionPath, "agents-only core extension");
  const expectedCore = resolveRequired(expectedCoreExtensionPath, "expected core extension");
  if (actualCore !== expectedCore) {
    throw new Error(`agents-only core extension must be ${expectedCore}, got ${actualCore}`);
  }
  const actualContext = resolveRequired(contextExtensionPath, "agents-only context extension");
  const expectedContext = resolveRequired(expectedContextExtensionPath, "expected context extension");
  if (actualContext !== expectedContext) {
    throw new Error(`agents-only context extension must be ${expectedContext}, got ${actualContext}`);
  }
  const actualMeasurementGuard = resolveRequired(measurementGuardPath, "agents-only measurement guard");
  const expectedMeasurementGuard = resolveRequired(expectedMeasurementGuardPath, "expected measurement guard");
  if (actualMeasurementGuard !== expectedMeasurementGuard) {
    throw new Error(`agents-only measurement guard must be ${expectedMeasurementGuard}, got ${actualMeasurementGuard}`);
  }
  const actualSkill = resolveRequired(skillPath, "agents-only Skill");
  const expectedSkill = resolveRequired(expectedSkillPath, "expected Skill");
  if (actualSkill !== expectedSkill) {
    throw new Error(`agents-only Skill must be ${expectedSkill}, got ${actualSkill}`);
  }
  return {
    valid: true,
    status: "canonical_checkout_resources",
    coreExtensionPath: actualCore,
    contextExtensionPath: actualContext,
    measurementGuardPath: actualMeasurementGuard,
    skillPath: actualSkill,
  };
}

function safeRootJsonConfigs(agentDir) {
  return readdirSync(agentDir)
    .filter((name) => name.endsWith(".json") && !EXCLUDED_ROOT_JSON_CONFIGS.has(name))
    .filter((name) => statSync(join(agentDir, name)).isFile())
    .sort();
}

/**
 * Build (or rebuild) the harness agent dir.
 *
 * @param {{ contextWindow?: number, maxTokensCap?: number, shrink?: boolean, label?: string, sourceAgentDir?: string, harnessDir?: string }} options
 * @returns {string} path to the agent dir
 */
export function buildAgentDir({
  contextWindow = 80000,
  maxTokensCap = 16000,
  shrink = true,
  label,
  sourceAgentDir = join(homedir(), ".pi", "agent"),
  harnessDir = HARNESS_DIR,
} = {}) {
  const sourceModelsPath = join(sourceAgentDir, "models.json");
  const source = JSON.parse(readFileSync(sourceModelsPath, "utf8"));

  const agentDir = join(harnessDir, label ?? (shrink ? `agent-cw${contextWindow}` : "agent-native"));
  mkdirSync(agentDir, { recursive: true });

  const models = structuredClone(source);
  if (shrink) {
    for (const provider of Object.values(models.providers)) {
      for (const model of provider.models ?? []) {
        // Shrink the window so working-budget pressure is cheap to create, and
        // cap output tokens so a single turn cannot blow past tier boundaries.
        model.contextWindow = Math.min(model.contextWindow ?? contextWindow, contextWindow);
        model.maxTokens = Math.min(model.maxTokens ?? maxTokensCap, maxTokensCap);
      }
    }
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));

  const settings = {
    quietStartup: true,
    defaultProjectTrust: "always",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
    packages: [],
  };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));

  const sourceAuthPath = join(sourceAgentDir, "auth.json");
  if (existsSync(sourceAuthPath)) {
    cpSync(sourceAuthPath, join(agentDir, "auth.json"));
  }
  return agentDir;
}

/**
 * Build a deliberately sparse harness that preserves only the user's global
 * AGENTS.md as ambient context. Models and authentication are copied so the
 * selected real provider still works; all global extension, Skill, package,
 * prompt-template, theme, and auxiliary configuration resources are absent.
 *
 * Pi context-file discovery remains enabled by the driver for this mode, so
 * the copied AGENTS.md is intentionally loaded as ambient instruction text.
 *
 * @param {{ contextWindow?: number, maxTokensCap?: number, shrink?: boolean, label?: string, sourceAgentDir?: string, harnessDir?: string }} options
 * @returns {string} path to the agent dir
 */
export function buildAgentsOnlyAgentDir({
  contextWindow = 100000,
  maxTokensCap = 16000,
  shrink = true,
  label,
  sourceAgentDir = join(homedir(), ".pi", "agent"),
  harnessDir = HARNESS_DIR,
} = {}) {
  const realDir = sourceAgentDir;
  const agentDir = join(harnessDir, label ?? (shrink ? `agent-agents-only-cw${contextWindow}` : "agent-agents-only-native"));

  // Rebuilding a named sparse harness must not retain ambient resources from
  // an earlier full-env or ordinary isolated run.
  rmSync(agentDir, { recursive: true, force: true });
  mkdirSync(agentDir, { recursive: true });

  const sourceModelsPath = join(realDir, "models.json");
  const models = JSON.parse(readFileSync(sourceModelsPath, "utf8"));
  if (shrink) {
    for (const provider of Object.values(models.providers)) {
      for (const model of provider.models ?? []) {
        model.contextWindow = Math.min(model.contextWindow ?? contextWindow, contextWindow);
        model.maxTokens = Math.min(model.maxTokens ?? maxTokensCap, maxTokensCap);
      }
    }
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));

  const settings = {
    quietStartup: true,
    defaultProjectTrust: "always",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8000 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
    packages: [],
  };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));

  const sourceAuthPath = join(realDir, "auth.json");
  if (existsSync(sourceAuthPath)) cpSync(sourceAuthPath, join(agentDir, "auth.json"));

  const sourceAgentsPath = join(realDir, "AGENTS.md");
  if (existsSync(sourceAgentsPath)) cpSync(sourceAgentsPath, join(agentDir, "AGENTS.md"));

  const audit = {
    schemaVersion: 1,
    environmentMode: "agents-only",
    sourceAgentDir: realDir,
    harnessAgentDir: agentDir,
    sourceCopiedFiles: [...(existsSync(sourceAuthPath) ? ["auth.json"] : []), ...(existsSync(sourceAgentsPath) ? ["AGENTS.md"] : [])],
    generatedFiles: ["models.json", "settings.json"],
    globalAgents: {
      source: fileSnapshot(sourceAgentsPath),
      harness: fileSnapshot(join(agentDir, "AGENTS.md")),
      expectedIncluded: true,
    },
    models: {
      source: fileSnapshot(sourceModelsPath),
      harness: fileSnapshot(join(agentDir, "models.json")),
    },
    auth: {
      source: fileSnapshot(sourceAuthPath),
      harness: fileSnapshot(join(agentDir, "auth.json")),
    },
    settings: {
      harness: fileSnapshot(join(agentDir, "settings.json")),
      packages: settings.packages,
    },
    excludedAmbientResources: [
      "extensions",
      "skills",
      "themes",
      "agents",
      "git",
      "npm",
      "bin",
      "mcp.json",
      "mcp-cache.json",
      "session-recall.json",
      "pi.env",
      "prompt-templates",
    ],
    sessionRecall: {
      packagePresent: false,
      configPresent: existsSync(join(agentDir, "session-recall.json")),
    },
  };
  writeFileSync(join(agentDir, AGENTS_ONLY_AUDIT_FILE), JSON.stringify(audit, null, 2));
  return agentDir;
}

/**
 * Build a full-environment harness agent dir: the user's REAL config
 * (packages, extensions, skills, global AGENTS.md, thinking presets) with
 * ONLY the installed pi-context removed — the version under test is injected
 * by the driver via -e. Heavy package stores are symlinked (no reinstall),
 * small configs copied. mcp.json is deliberately excluded (side effects).
 *
 * Pair it with a workspace OUTSIDE the pi-context repo: cwd-ancestry context
 * discovery must not find the repo's own AGENTS.md (the ACM design doc would
 * leak into the tested agent's prompt).
 *
 * @param {{ contextWindow?: number, maxTokensCap?: number, shrink?: boolean, label?: string, sourceAgentDir?: string, harnessDir?: string }} options
 * @returns {string} path to the agent dir
 */
export function buildFullEnvAgentDir({
  contextWindow = 100000,
  maxTokensCap = 16000,
  shrink = true,
  label,
  sourceAgentDir = join(homedir(), ".pi", "agent"),
  harnessDir = HARNESS_DIR,
} = {}) {
  const realDir = sourceAgentDir;
  const agentDir = join(harnessDir, label ?? (shrink ? `agent-fullenv-cw${contextWindow}` : "agent-fullenv-native"));
  mkdirSync(agentDir, { recursive: true });
  // A reused harness label must not retain an old copy of a disallowed config.
  const purgedFiles = ["mcp-cache.json", "mcp.json", "session-recall.json"].filter((file) => {
    const target = join(agentDir, file);
    if (!existsSync(target)) return false;
    rmSync(target, { force: true });
    return true;
  });
  for (const dir of ["git", "npm", "extensions", "skills", "themes", "agents", "bin"]) {
    const src = join(realDir, dir);
    if (existsSync(src) && !existsSync(join(agentDir, dir))) {
      symlinkSync(src, join(agentDir, dir), "dir");
    }
  }
  const sourceSettingsPath = join(realDir, "settings.json");
  const sourceSettingsText = readFileSync(sourceSettingsPath, "utf8");
  const sourceSettings = JSON.parse(sourceSettingsText);
  const sanitized = sanitizeFullEnvSettings(sourceSettings);
  const settings = sanitized.settings;
  delete settings.enabledModels; // never let the allowlist refuse an eval model
  settings.quietStartup = true;
  settings.defaultProjectTrust = "always";
  settings.enableInstallTelemetry = false;
  settings.enableAnalytics = false;
  const sanitizedSettingsText = JSON.stringify(settings, null, 2);
  writeFileSync(join(agentDir, "settings.json"), sanitizedSettingsText);
  const models = JSON.parse(readFileSync(join(realDir, "models.json"), "utf8"));
  if (shrink) {
    for (const provider of Object.values(models.providers)) {
      for (const model of provider.models ?? []) {
        model.contextWindow = Math.min(model.contextWindow ?? contextWindow, contextWindow);
        model.maxTokens = Math.min(model.maxTokens ?? maxTokensCap, maxTokensCap);
      }
    }
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  const copiedFiles = [];
  for (const f of ["auth.json", "AGENTS.md", "pi.env"]) {
    const src = join(realDir, f);
    if (existsSync(src)) {
      cpSync(src, join(agentDir, f));
      copiedFiles.push(f);
    }
  }
  const currentRootConfigNames = new Set(safeRootJsonConfigs(realDir));
  for (const existing of safeRootJsonConfigs(agentDir)) {
    if (!currentRootConfigNames.has(existing)) rmSync(join(agentDir, existing), { force: true });
  }
  const rootConfigs = [...currentRootConfigNames].sort().map((name) => {
    const source = join(realDir, name);
    const target = join(agentDir, name);
    cpSync(source, target);
    copiedFiles.push(name);
    return { name, source: fileSnapshot(source), harness: fileSnapshot(target) };
  });
  const audit = {
    schemaVersion: 1,
    sourceAgentDir: realDir,
    harnessAgentDir: agentDir,
    linkedDirectories: ["git", "npm", "extensions", "skills", "themes", "agents", "bin"]
      .filter((dir) => existsSync(join(realDir, dir)))
      .map((dir) => ({ name: dir, source: join(realDir, dir), target: join(agentDir, dir) })),
    copiedFiles,
    excludedFiles: ["mcp-cache.json", "mcp.json", "session-recall.json"],
    purgedFiles,
    rootConfigs,
    settings: {
      source: fileSnapshot(sourceSettingsPath),
      originalSha256: sha256(sourceSettingsText),
      sanitizedSha256: sha256(sanitizedSettingsText),
      originalPackagesSha256: sha256(JSON.stringify(sanitized.originalPackages)),
      sanitizedPackagesSha256: sha256(JSON.stringify(sanitized.sanitizedPackages)),
      originalPackages: sanitized.originalPackages,
      sanitizedPackages: sanitized.sanitizedPackages,
      removedPackages: sanitized.removedPackages,
    },
    globalAgents: {
      source: fileSnapshot(join(realDir, "AGENTS.md")),
      harness: fileSnapshot(join(agentDir, "AGENTS.md")),
      expectedIncluded: true,
    },
  };
  writeFileSync(join(agentDir, FULL_ENV_AUDIT_FILE), JSON.stringify(audit, null, 2));
  return agentDir;
}

/** Create a fresh run directory: workspace + sessions + logs. */
export function createRunDir(label, { runsDir = RUNS_DIR } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Append pid so parallel jobs launched in the same millisecond never collide.
  const runDir = join(runsDir, `${stamp}-${label}-p${process.pid}`);
  mkdirSync(join(runDir, "workspace"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  return runDir;
}
