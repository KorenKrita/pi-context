// RPC driver for live end-to-end ACM evals.
//
// Spawns `pi --mode rpc` against an isolated agent dir + workspace, sends JSON
// commands on stdin, and collects the JSON event stream from stdout. Turn
// completion is detected via the `agent_settled` event that rpc-mode emits
// after each run (including follow-ups).

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export class PiRpcDriver {
  /**
   * @param {{
   *   cwd: string,
   *   agentDir: string,
   *   sessionDir: string,
   *   extensionPath: string,
   *   provider: string,
   *   modelId: string,
   *   thinkingLevel?: string,
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
    // fullEnv mode keeps the user's real extensions/skills/templates/context
    // files (production fidelity); the default bare mode strips them so the
    // extension's guidance is measured alone (de-primed by design).
    const args = ["--mode", "rpc"];
    if (!this.options.fullEnv) {
      args.push(
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      );
    }
    args.push("--approve");
    if (this.options.extensionPath) {
      args.push("-e", this.options.extensionPath);
    }
    args.push(
      "--session-dir", this.options.sessionDir,
      "--provider", this.options.provider,
      "--model", this.options.modelId,
    );
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }
    this.child = spawn("pi", args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: this.options.agentDir,
        ...this.options.env,
      },
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
    return this.events.slice(startIndex);
  }

  async getState() {
    const response = await this.request({ type: "get_state" });
    return response.data;
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
