// RPC driver for live end-to-end ACM evals.
//
// Spawns `pi --mode rpc` against an isolated agent dir + workspace, sends JSON
// commands on stdin, and collects the JSON event stream from stdout. Turn
// completion is detected via the `agent_settled` event that rpc-mode emits
// after each run (including follow-ups).

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { FULL_ENV_DENIED_TOOLS } from "./integrity-guard.mjs";

export const ENVIRONMENT_MODES = Object.freeze(["raw-control", "core-only", "product-isolated", "full-env"]);
export const CONTEXT_MANAGEMENT_COMMAND = "skill:context-management";
export const SESSION_RECALL_TOOLS = Object.freeze(["session_search", "session_query"]);
export { FULL_ENV_DENIED_TOOLS };
const ALLOWED_ACM_CHILD_ENV = new Set([
  "ACM_INTEGRITY_APPROVED_SKILL_ROOTS",
  "ACM_INTEGRITY_AUDIT_PATH",
  "ACM_INTEGRITY_REQUIRED_MARKERS",
  "ACM_INTEGRITY_WORKSPACE",
]);

/** Remove credentials and private matrix/oracle coordination from the real Pi child. */
export function sanitizePiChildEnvironment(environment) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith("ACM_") && !ALLOWED_ACM_CHILD_ENV.has(upper)) continue;
    if (/(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|COOKIE|FLOW_SEED|MATRIX_ID|ORACLE|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|SESSION_?TOKEN|TOKEN)(?:_|$)/.test(upper)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

/** Resolve compatibility aliases and reject an unknown resource policy. */
export function normalizeEnvironmentMode(options = {}) {
  const mode = options.environmentMode ?? (options.fullEnv ? "full-env" : "core-only");
  if (!ENVIRONMENT_MODES.includes(mode)) {
    throw new Error(`unknown environment mode: ${String(mode)}; expected ${ENVIRONMENT_MODES.join(", ")}`);
  }
  return mode;
}

function explicitPaths(options, plural, singular) {
  if (Array.isArray(options[plural])) return options[plural].filter(Boolean);
  return options[singular] ? [options[singular]] : [];
}

/**
 * Compose the Pi command line without spawning it. Explicit resources remain
 * loadable with --no-* discovery guards, so product-isolated runs can measure
 * precisely this checkout rather than ambient user configuration.
 */
export function buildPiRpcArgs(options) {
  const mode = normalizeEnvironmentMode(options);
  const extensionPaths = explicitPaths(options, "extensionPaths", "extensionPath");
  const skillPaths = explicitPaths(options, "skillPaths", "skillPath");
  const args = ["--mode", "rpc"];
  if (mode !== "full-env") {
    args.push(
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    );
  }
  args.push("--approve");
  // Defense in depth for full-env: the sanitized settings exclude the package
  // that registers these tools, while the CLI denylist makes a leaked or
  // manually installed copy unavailable to the evaluated model.
  if (mode === "full-env") args.push("--exclude-tools", FULL_ENV_DENIED_TOOLS.join(","));
  for (const extensionPath of extensionPaths) args.push("-e", extensionPath);
  for (const skillPath of skillPaths) args.push("--skill", skillPath);
  args.push(
    "--session-dir", options.sessionDir,
    "--provider", options.provider,
    "--model", options.modelId,
  );
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  return args;
}

function commandProvenance(command) {
  return {
    name: command?.name,
    source: command?.source,
    sourceInfo: command?.sourceInfo,
  };
}

function resolvePath(path, realpath) {
  if (typeof path !== "string" || !path) return { ok: false, error: "missing sourceInfo.path" };
  try {
    return { ok: true, path: realpath(path) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verify discovery and provenance before a model sees any eval prompt. This
 * classifies harness infrastructure; it does not infer whether a model used a
 * discoverable Skill.
 */
export function classifySkillAvailability(input) {
  const environmentMode = normalizeEnvironmentMode(input);
  if (input.rpcError) {
    return { valid: false, status: "rpc_failure", reason: input.rpcError, matches: [] };
  }
  if (!Array.isArray(input.commands)) {
    return {
      valid: false,
      status: "invalid_response",
      reason: "get_commands response did not contain a commands array",
      matches: [],
    };
  }
  const matches = input.commands
    .filter((command) => command && typeof command === "object" && command.name === CONTEXT_MANAGEMENT_COMMAND)
    .map(commandProvenance);

  if (environmentMode === "core-only" || environmentMode === "raw-control") {
    return matches.length === 0
      ? { valid: true, status: "absent_as_expected", matches }
      : {
        valid: false,
        status: "unexpected_skill",
        reason: `${CONTEXT_MANAGEMENT_COMMAND} must be absent in core-only mode`,
        matches,
      };
  }
  if (matches.length === 0) {
    return { valid: false, status: "missing", reason: `${CONTEXT_MANAGEMENT_COMMAND} was not discovered`, matches };
  }
  if (matches.length !== 1) {
    return {
      valid: false,
      status: "duplicate",
      reason: `expected exactly one ${CONTEXT_MANAGEMENT_COMMAND}, found ${matches.length}`,
      matches,
    };
  }

  const [match] = matches;
  if (match.source !== "skill") {
    return {
      valid: false,
      status: "wrong_source",
      reason: `${CONTEXT_MANAGEMENT_COMMAND} must have source=skill`,
      matches,
    };
  }
  const realpath = input.realpath;
  if (typeof realpath !== "function") {
    return {
      valid: false,
      status: "provenance_unresolved",
      reason: "no realpath resolver was supplied for skill provenance",
      matches,
    };
  }
  const expected = resolvePath(input.expectedSkillPath, realpath);
  const actual = resolvePath(match.sourceInfo?.path, realpath);
  if (!expected.ok || !actual.ok) {
    return {
      valid: false,
      status: "provenance_unresolved",
      reason: expected.ok ? `skill command provenance: ${actual.error}` : `expected Skill path: ${expected.error}`,
      matches,
      expectedSkillPath: expected.ok ? expected.path : input.expectedSkillPath ?? null,
      discoveredSkillPath: actual.ok ? actual.path : match.sourceInfo?.path ?? null,
    };
  }
  if (actual.path !== expected.path) {
    return {
      valid: false,
      status: "path_mismatch",
      reason: `skill command path ${actual.path} does not match expected ${expected.path}`,
      matches,
      expectedSkillPath: expected.path,
      discoveredSkillPath: actual.path,
    };
  }
  return {
    valid: true,
    status: "available_from_expected_checkout",
    matches,
    expectedSkillPath: expected.path,
    discoveredSkillPath: actual.path,
  };
}

export function finalAssistantOutcome(events) {
  const message = [...events]
    .reverse()
    .find((event) => event?.type === "message_end" && event.message?.role === "assistant")
    ?.message;
  return message
    ? { stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ?? null }
    : { stopReason: null, errorMessage: null };
}

export function assertTurnCompleted(events) {
  const outcome = finalAssistantOutcome(events);
  if (outcome.stopReason === null) {
    throw new Error("assistant turn failed: no terminal assistant message");
  }
  if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
    throw new Error(`assistant turn failed: ${outcome.errorMessage ?? outcome.stopReason}`);
  }
  return outcome;
}

export class PiRpcDriver {
  /**
   * @param {{
   *   cwd: string,
   *   agentDir: string,
   *   sessionDir: string,
   *   extensionPath?: string,
   *   extensionPaths?: string[],
   *   skillPath?: string,
   *   skillPaths?: string[],
   *   environmentMode?: "raw-control" | "core-only" | "product-isolated" | "full-env",
   *   fullEnv?: boolean,
   *   provider: string,
   *   modelId: string,
   *   thinkingLevel?: string,
   *   piBinary?: string,
   *   eventLogPath?: string,
   *   env?: Record<string, string>,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.events = [];
    this.stderr = "";
    this.child = null;
    this.exited = null;
    this.nextId = 1;
    this.pendingResponses = new Map();
    this.eventWaiters = [];
    this.buffer = "";
  }

  start() {
    const args = buildPiRpcArgs(this.options);
    const piBinary = this.options.piBinary ?? process.env.ACM_PI_BINARY ?? "pi";
    const childEnvironment = {
      ...sanitizePiChildEnvironment(process.env),
      ...sanitizePiChildEnvironment(this.options.env),
      PI_CODING_AGENT_DIR: this.options.agentDir,
    };
    this.child = spawn(piBinary, args, {
      cwd: this.options.cwd,
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.on("close", (code, signal) => resolve({ code, signal }));
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.events.push(event);
      if (this.options.eventLogPath) {
        appendFileSync(this.options.eventLogPath, `${line}\n`);
      }
      if (event.type === "response" && event.id && this.pendingResponses.has(event.id)) {
        const { resolve } = this.pendingResponses.get(event.id);
        this.pendingResponses.delete(event.id);
        resolve(event);
      }
      for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
        const waiter = this.eventWaiters[i];
        if (waiter.predicate(event)) {
          this.eventWaiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    }
  }

  /** Send a raw RPC command without waiting for its response. */
  send(command) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Send a command with an id and await its `response` envelope. */
  async request(command, { timeoutMs = 30000 } = {}) {
    const id = `req-${this.nextId++}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`RPC response timeout for ${command.type} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingResponses.set(id, {
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
    this.send({ id, ...command });
    return promise;
  }

  /** Wait for the next event matching a predicate. */
  waitForEvent(predicate, { timeoutMs = 30000, description = "event" } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.eventWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`));
      }, timeoutMs);
      const wrappedResolve = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
      this.eventWaiters.push({ predicate, resolve: wrappedResolve });
    });
  }

  /**
   * Send a user prompt and wait until the agent fully settles.
   * Returns the slice of events that belong to this turn.
   */
  async prompt(message, { timeoutMs = 600000 } = {}) {
    const startIndex = this.events.length;
    const settled = this.waitForEvent(
      (event) => event.type === "agent_settled",
      { timeoutMs, description: `agent_settled after prompt` },
    );
    const response = await this.request({ type: "prompt", message }, { timeoutMs: 60000 });
    if (!response.success) {
      throw new Error(`prompt rejected: ${response.error ?? "unknown error"}`);
    }
    await settled;
    const turnEvents = this.events.slice(startIndex);
    assertTurnCompleted(turnEvents);
    return turnEvents;
  }

  async getState() {
    const response = await this.request({ type: "get_state" });
    if (!response.success) throw new Error(`get_state rejected: ${response.error ?? "unknown error"}`);
    return response.data;
  }

  /** Return the effective model catalog after Pi has loaded the harness config. */
  async getAvailableModels() {
    const response = await this.request({ type: "get_available_models" });
    if (!response.success) throw new Error(`get_available_models rejected: ${response.error ?? "unknown error"}`);
    return response.data?.models;
  }

  /** Return the effort levels Pi makes available for the currently selected model. */
  async getThinkingLevels() {
    const response = await this.request({ type: "get_available_thinking_levels" });
    if (!response.success) throw new Error(`get_available_thinking_levels rejected: ${response.error ?? "unknown error"}`);
    return response.data?.levels;
  }

  /** Invoke Pi's native compaction boundary for flow-level perturbation tests. */
  async compact(customInstructions) {
    const response = await this.request({ type: "compact", ...(customInstructions === undefined ? {} : { customInstructions }) }, { timeoutMs: 600000 });
    if (!response.success) throw new Error(`compact rejected: ${response.error ?? "unknown error"}`);
    return response.data;
  }

  /** Return persisted session entries, optionally after a known entry id. */
  async getEntries(since) {
    const response = await this.request({ type: "get_entries", ...(since === undefined ? {} : { since }) });
    if (!response.success) throw new Error(`get_entries rejected: ${response.error ?? "unknown error"}`);
    return response.data;
  }

  /** Return the current model-visible message array through Pi's public RPC surface. */
  async getMessages() {
    const response = await this.request({ type: "get_messages" });
    if (!response.success) throw new Error(`get_messages rejected: ${response.error ?? "unknown error"}`);
    return response.data?.messages;
  }

  /** Return Pi's public session statistics for per-turn telemetry. */
  async getSessionStats() {
    const response = await this.request({ type: "get_session_stats" });
    if (!response.success) throw new Error(`get_session_stats rejected: ${response.error ?? "unknown error"}`);
    return response.data;
  }

  /** Return slash commands with source provenance from Pi's RPC API. */
  async getCommands() {
    const response = await this.request({ type: "get_commands" });
    if (!response.success) {
      throw new Error(`get_commands rejected: ${response.error ?? "unknown error"}`);
    }
    if (!Array.isArray(response.data?.commands)) {
      throw new Error("get_commands returned no commands array");
    }
    return response.data.commands;
  }

  async stop() {
    if (!this.child) return;
    this.child.stdin.end();
    const result = await Promise.race([
      this.exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (result === null) {
      this.child.kill("SIGTERM");
      const second = await Promise.race([
        this.exited,
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (second === null) this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}
