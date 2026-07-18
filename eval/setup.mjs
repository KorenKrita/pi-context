// Harness environment builder.
//
// Derives an isolated PI_CODING_AGENT_DIR from the user's real ~/.pi/agent
// config: same providers and API keys, but with a harness-tuned context
// window so context-pressure behavior (nudge tiers, compaction interplay)
// is reachable in minutes instead of hours. Nothing under eval/.harness or
// eval/.runs is committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = join(EVAL_ROOT, ".harness");
export const RUNS_DIR = join(EVAL_ROOT, ".runs");
export const EXTENSION_PATH = join(EVAL_ROOT, "..", "src", "index.ts");

/**
 * Build (or rebuild) the harness agent dir.
 *
 * @param {{ contextWindow?: number, maxTokensCap?: number, shrink?: boolean, label?: string }} options
 * @returns {string} path to the agent dir
 */
export function buildAgentDir({ contextWindow = 80000, maxTokensCap = 16000, shrink = true, label } = {}) {
  const sourceModelsPath = join(homedir(), ".pi", "agent", "models.json");
  const source = JSON.parse(readFileSync(sourceModelsPath, "utf8"));

  const agentDir = join(HARNESS_DIR, label ?? (shrink ? `agent-cw${contextWindow}` : "agent-native"));
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

  const sourceAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(sourceAuthPath)) {
    cpSync(sourceAuthPath, join(agentDir, "auth.json"));
  }
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
 * @param {{ contextWindow?: number, maxTokensCap?: number, shrink?: boolean, label?: string }} options
 * @returns {string} path to the agent dir
 */
export function buildFullEnvAgentDir({ contextWindow = 100000, maxTokensCap = 16000, shrink = true, label } = {}) {
  const realDir = join(homedir(), ".pi", "agent");
  const agentDir = join(HARNESS_DIR, label ?? (shrink ? `agent-fullenv-cw${contextWindow}` : "agent-fullenv-native"));
  mkdirSync(agentDir, { recursive: true });
  for (const dir of ["git", "npm", "extensions", "skills", "themes", "agents", "bin"]) {
    const src = join(realDir, dir);
    if (existsSync(src) && !existsSync(join(agentDir, dir))) {
      symlinkSync(src, join(agentDir, dir), "dir");
    }
  }
  const settings = JSON.parse(readFileSync(join(realDir, "settings.json"), "utf8"));
  settings.packages = (settings.packages ?? []).filter((p) => !String(p).includes("pi-context"));
  delete settings.enabledModels; // never let the allowlist refuse an eval model
  settings.quietStartup = true;
  settings.defaultProjectTrust = "always";
  settings.enableInstallTelemetry = false;
  settings.enableAnalytics = false;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
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
  for (const f of ["auth.json", "AGENTS.md", "keybindings.json", "thinking-presets.json", "subagents-lite.json", "session-recall.json", "pi.env"]) {
    const src = join(realDir, f);
    if (existsSync(src)) cpSync(src, join(agentDir, f));
  }
  return agentDir;
}

/** Create a fresh run directory: workspace + sessions + logs. */
export function createRunDir(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Append pid so parallel jobs launched in the same millisecond never collide.
  const runDir = join(RUNS_DIR, `${stamp}-${label}-p${process.pid}`);
  mkdirSync(join(runDir, "workspace"), { recursive: true });
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  return runDir;
}
