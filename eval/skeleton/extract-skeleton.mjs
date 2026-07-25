#!/usr/bin/env node
// Read-only skeleton extraction from real Pi sessions.
// Produces distribution parameters (no content) for ACM eval showroom sizing.
// Exclusion: sessions that touch ACM/meta-tool development (pi-context, omp-context, etc.)
// are excluded by CONTENT (edited file paths + cwd), not by directory.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SESSIONS_ROOT = join(process.env.HOME, ".pi/agent/sessions");
const MIN_BYTES = 300 * 1024;

// Content-level exclusion: a session is ACM-dev-contaminated when its cwd or any
// file path referenced in tool INPUTS points into these projects.
const EXCLUDE_PATH_PATTERNS = [
  /pi-context/i,
  /omp-context/i,
  /pi-claude-fast/i, // extension-dev sample noise guard (harmless if absent)
];
// tmp repro-debug sessions are excluded by cwd.
const EXCLUDE_CWD_PATTERNS = [/^\/tmp(\/|$)/];

const READ_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);
const WRITE_TOOLS = new Set(["write", "replace", "edit", "undo_last_replace"]);

function* jsonlEntries(path) {
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* torn tail line */ }
  }
}

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && st.size >= MIN_BYTES) out.push(p);
    }
  };
  walk(root);
  return out;
}

function toolCallsOf(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((p) => p?.type === "toolCall");
}

function pathsInToolInput(part) {
  const paths = [];
  const scan = (v) => {
    if (typeof v === "string") { if (v.startsWith("/") || v.includes("/")) paths.push(v); }
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  scan(part?.arguments ?? part?.input ?? {});
  return paths;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    max: s.at(-1) ?? null,
  };
}

const files = collectFiles(SESSIONS_ROOT);
const included = [];
const excluded = [];

// Aggregates across included sessions
const burstLengths = [];        // consecutive read-tool call runs (across tool batches, broken by write/user/assistant-text-only)
const runToolCounts = [];       // tool calls per assistant run (user msg -> next user msg)
const readWriteRatio = [];      // per session
const turnCounts = [];          // user turns per session
const interruptGaps = [];       // tool calls in the run PRECEDING each new user turn (new-request-over-old-task signal)
const sessionDurationsMin = [];

for (const file of files) {
  let cwd = "";
  let contaminated = false;
  let reads = 0, writes = 0, totalTools = 0;
  let userTurns = 0;
  let currentRunTools = 0;
  let currentBurst = 0;
  let firstTs = null, lastTs = null;

  for (const entry of jsonlEntries(file)) {
    if (entry.type === "session") {
      cwd = entry.cwd ?? "";
      if (EXCLUDE_CWD_PATTERNS.some((r) => r.test(cwd))) { contaminated = true; break; }
      if (EXCLUDE_PATH_PATTERNS.some((r) => r.test(cwd))) { contaminated = true; break; }
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (entry.timestamp) {
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t)) { firstTs ??= t; lastTs = t; }
    }

    if (msg.role === "user") {
      userTurns++;
      if (currentRunTools > 0) {
        runToolCounts.push(currentRunTools);
        if (userTurns > 1) interruptGaps.push(currentRunTools);
      }
      currentRunTools = 0;
      if (currentBurst > 0) { burstLengths.push(currentBurst); currentBurst = 0; }
      continue;
    }

    for (const part of toolCallsOf(msg)) {
      const name = (part.name ?? part.toolName ?? "").toLowerCase();
      totalTools++;
      currentRunTools++;
      // contamination check via tool input paths
      if (!contaminated) {
        for (const p of pathsInToolInput(part)) {
          if (EXCLUDE_PATH_PATTERNS.some((r) => r.test(p))) { contaminated = true; break; }
        }
      }
      if (READ_TOOLS.has(name)) {
        reads++;
        currentBurst++;
      } else {
        if (WRITE_TOOLS.has(name)) writes++;
        if (currentBurst > 0) { burstLengths.push(currentBurst); currentBurst = 0; }
      }
    }
    if (contaminated) break;
  }

  if (contaminated) { excluded.push({ file, cwd }); continue; }
  if (currentBurst > 0) burstLengths.push(currentBurst);
  if (currentRunTools > 0) runToolCounts.push(currentRunTools);
  if (totalTools === 0) { excluded.push({ file, cwd, reason: "no_tools" }); continue; }

  included.push({ file, cwd, totalTools, userTurns });
  if (writes > 0) readWriteRatio.push(reads / writes);
  turnCounts.push(userTurns);
  if (firstTs && lastTs && lastTs > firstTs) sessionDurationsMin.push((lastTs - firstTs) / 60000);
}

const report = {
  generated: new Date().toISOString(),
  corpus: {
    scanned: files.length,
    included: included.length,
    excluded: excluded.length,
    excludedForContamination: excluded.filter((e) => !e.reason).length,
  },
  distributions: {
    readBurstLength: summarize(burstLengths),
    toolCallsPerRun: summarize(runToolCounts),
    toolsInRunBeforeNewUserTurn: summarize(interruptGaps),
    readWriteRatioPerSession: summarize(readWriteRatio),
    userTurnsPerSession: summarize(turnCounts),
    sessionDurationMinutes: summarize(sessionDurationsMin),
  },
  triggerRelevance: {
    burstsAtOrAbove8: burstLengths.filter((b) => b >= 8).length,
    burstsTotal: burstLengths.length,
    runsAtOrAbove8Tools: runToolCounts.filter((r) => r >= 8).length,
    runsTotal: runToolCounts.length,
    interruptsOverBusyRun: interruptGaps.filter((g) => g >= 8).length,
    interruptsTotal: interruptGaps.length,
  },
};

console.log(JSON.stringify(report, null, 2));
