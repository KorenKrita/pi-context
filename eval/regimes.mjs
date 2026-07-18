#!/usr/bin/env bun
// Post-hoc pressure-regime annotator for gradient-window runs (p5gradient).
//
// Splits a run's events.jsonl into turns (delimited by `agent_settled`), reads
// end-of-turn context tokens from the last assistant message usage, and assigns
// each turn a regime:
//
//   A = before context first reaches 30% of the window (nudge silent, 道-only)
//   B = at/after 30% and up to the first successful acm_travel (pressure on)
//   C = after the first successful acm_travel (pressure released, new cycle)
//
// Boundaries are mechanical: threshold crossing from token readings, C from the
// first non-error acm_travel tool_execution_end — wherever they actually happen,
// not where the flow design predicted them. A sharp context drop with no travel
// is flagged as a possible compaction / manual-navigation event.
//
// Usage: bun eval/regimes.mjs <run-dir> [--window 100000]

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: bun eval/regimes.mjs <run-dir> [--window 100000]");
  process.exit(1);
}
const wIdx = process.argv.indexOf("--window");
const window = wIdx > 0 ? Number(process.argv[wIdx + 1]) : 100000;
const threshold = Math.round(window * 0.3);

const eventsPath = join(runDir, "events.jsonl");
if (!existsSync(eventsPath)) {
  console.error(`no events.jsonl in ${runDir}`);
  process.exit(1);
}
const reportPath = join(runDir, "report.json");
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;

/** Tolerant context-size extraction from a pi usage object. */
function contextTokens(u) {
  if (!u) return null;
  const input = u.inputTokens ?? u.input ?? u.promptTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? u.cacheRead ?? 0;
  if (input || cacheRead) return input + cacheRead;
  return u.totalTokens ?? u.total ?? null;
}

// ---- Split events into turns at agent_settled boundaries ----
const turns = [[]];
for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  turns[turns.length - 1].push(e);
  if (e.type === "agent_settled") turns.push([]);
}
if (turns.at(-1).length === 0) turns.pop();

// ---- Per-turn facts ----
const rows = turns.map((events, i) => {
  let ctx = null;
  let travelOk = false;
  let travelFail = 0;
  const acm = [];
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant" && e.message?.usage) {
      const v = contextTokens(e.message.usage);
      // Max per turn, not last: a mid-turn travel shrinks the context of the
      // messages after it, so the last reading would hide the pre-travel peak
      // (and with it, a 30% tier crossing that really fired).
      if (v != null) ctx = Math.max(ctx ?? 0, v);
    }
    if (e.type === "tool_execution_end" && e.toolName === "acm_travel") {
      if (e.isError === true) travelFail++;
      else travelOk = true;
    }
    if (e.type === "tool_execution_start" && typeof e.toolName === "string" && e.toolName.startsWith("acm_")) {
      acm.push(e.toolName.replace("acm_", ""));
    }
  }
  const phase = report?.turns?.[i]?.phase ?? `turn-${i + 1}`;
  return { i, phase, ctx, travelOk, travelFail, acm };
});

// ---- Regime assignment ----
let crossedIdx = rows.findIndex((r) => r.ctx != null && r.ctx >= threshold);
if (crossedIdx < 0) crossedIdx = Infinity;
const travelIdx = rows.findIndex((r) => r.travelOk);

let prevCtx = null;
for (const r of rows) {
  // C is checked first: a travel before the threshold crossing still starts a
  // post-travel segment (opus folded at 21% with zero nudges — that segment is
  // the habit-persistence observation, not a pressure regime).
  r.regime = travelIdx >= 0 && r.i > travelIdx ? "C" : r.i < crossedIdx ? "A" : "B";
  r.drop = prevCtx != null && r.ctx != null && r.ctx < prevCtx * 0.6 && !r.travelOk && !rows[r.i - 1]?.travelOk;
  if (r.ctx != null) prevCtx = r.ctx;
}

// ---- Report ----
const k = (v) => (v == null ? "  -  " : `${(v / 1000).toFixed(1)}K`);
console.log(`\nrun: ${runDir}`);
console.log(`window=${window}  30% threshold=${threshold}  travel first ok at turn: ${travelIdx >= 0 ? travelIdx + 1 : "never"}\n`);
console.log("turn  phase            regime  context  acm-tools        notes");
for (const r of rows) {
  const notes = [
    r.travelOk ? "TRAVEL✓" : "",
    r.travelFail ? `travel✗×${r.travelFail}` : "",
    r.drop ? "sharp-drop(compaction?)" : "",
    r.i === crossedIdx ? "← 30% crossed" : "",
    travelIdx >= 0 && r.i === travelIdx + 1 ? "← regime C starts" : "",
  ].filter(Boolean).join(" ");
  console.log(
    `${String(r.i + 1).padStart(4)}  ${r.phase.padEnd(14)} ${r.regime}       ${k(r.ctx).padStart(6)}   ${r.acm.join(",").padEnd(16)} ${notes}`,
  );
}

const peak = Math.max(...rows.map((r) => r.ctx ?? 0));
const count = (g) => rows.filter((r) => r.regime === g).length;
console.log(`\nregimes: A=${count("A")} turns, B=${count("B")} turns, C=${count("C")} turns; peak context=${k(peak)} (${Math.round((peak / window) * 100)}% of window)`);
const acmIn = (g) => rows.filter((r) => r.regime === g && r.acm.length > 0).length;
console.log(`turns with ACM activity: A=${acmIn("A")}/${count("A")}, B=${acmIn("B")}/${count("B")}, C=${acmIn("C")}/${count("C")}`);
