#!/usr/bin/env node
// Showroom scenario builder: emits a deterministic Pi session JSONL prefix
// that stops at a decision point with known ground truth.
//
// Sizing comes from eval/skeleton/skeleton-params.json (real-session
// distribution facts). Content is standardized ordinary-coding material —
// no ACM/meta-tool development vocabulary in any task narrative.
//
// Usage: node build-scenario.mjs --scenario P1 --out <dir> [--seed 7]

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { seed: 7 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.scenario || !out.out) {
    throw new Error("usage: build-scenario.mjs --scenario <ID> --out <dir> [--seed N]");
  }
  return out;
}

// Deterministic PRNG (mulberry32) so identical seeds build identical prefixes.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SessionBuilder {
  constructor({ cwd, seed = 7, startTime = Date.parse("2026-07-01T09:00:00Z") }) {
    this.entries = [];
    this.lastId = null;
    this.time = startTime;
    this.cwd = cwd;
    this.rand = mulberry32(seed);
    this.counter = 0;
    this.entries.push({
      type: "session", version: 3,
      id: randomUUIDFrom(this.rand), timestamp: this.iso(), cwd,
    });
  }

  iso() { return new Date(this.time).toISOString(); }
  nextId() { return hex8(this.rand); }
  tick(ms = 1500 + Math.floor(this.rand() * 3000)) { this.time += ms; }

  push(entry) {
    const id = this.nextId();
    this.entries.push({ ...entry, id, parentId: this.lastId, timestamp: this.iso() });
    this.lastId = id;
    this.tick();
    return id;
  }

  user(text) {
    return this.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp: this.time },
    });
  }

  assistantText(text, usage) {
    return this.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions", provider: "showroom", model: "showroom-scripted",
        usage: usageBlock(usage), stopReason: "stop", timestamp: this.time,
      },
    });
  }

  toolCall(name, args, resultText, usage, { isError = false } = {}) {
    const callId = `call_${hex8(this.rand)}${hex8(this.rand)}`;
    this.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name, arguments: args }],
        api: "openai-completions", provider: "showroom", model: "showroom-scripted",
        usage: usageBlock(usage), stopReason: "toolUse", timestamp: this.time,
      },
    });
    return this.push({
      type: "message",
      message: {
        role: "toolResult", toolCallId: callId, toolName: name,
        content: [{ type: "text", text: resultText }],
        isError, timestamp: this.time,
      },
    });
  }

  write(path) {
    writeFileSync(path, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
}

function usageBlock(promptTokens) {
  // Encode context growth in cacheRead so ctx.getContextUsage()-style accounting
  // sees realistic prompt sizes at the decision point.
  const input = 200;
  const cacheRead = Math.max(0, Math.floor(promptTokens) - input);
  return {
    input, output: 350, cacheRead, cacheWrite: 0, reasoning: 0,
    totalTokens: input + cacheRead + 350,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function hex8(rand) {
  let s = "";
  for (let i = 0; i < 8; i++) s += "0123456789abcdef"[Math.floor(rand() * 16)];
  return s;
}

function randomUUIDFrom(rand) {
  // deterministic uuid-shaped id for the session header
  const h = () => hex8(rand);
  return `${h()}-${h().slice(0, 4)}-7${h().slice(0, 3)}-a${h().slice(0, 3)}-${h()}${h().slice(0, 4)}`;
}

function main() {
  const args = parseArgs(process.argv);
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) throw new Error(`unknown scenario ${args.scenario}; have: ${Object.keys(SCENARIOS).join(", ")}`);
  mkdirSync(args.out, { recursive: true });

  const workspace = join(args.out, "workspace");
  mkdirSync(workspace, { recursive: true });
  const builder = new SessionBuilder({ cwd: workspace, seed: args.seed });
  const groundTruth = scenario.build(builder, { workspace, seed: args.seed });

  const sessionPath = join(args.out, "session.jsonl");
  builder.write(sessionPath);
  writeFileSync(join(args.out, "expected.json"), JSON.stringify({
    scenario: args.scenario,
    seed: args.seed,
    ...groundTruth,
  }, null, 2));
  writeFileSync(join(args.out, "meta.json"), JSON.stringify({
    scenario: args.scenario, seed: args.seed,
    generated: new Date().toISOString(),
    skeletonParams: JSON.parse(readFileSync(join(HERE, "../skeleton/skeleton-params.json"), "utf8")).distributions,
  }, null, 2));
  process.stdout.write(`${sessionPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
