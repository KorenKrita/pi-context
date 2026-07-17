#!/usr/bin/env bun
// Aggregate flow-run verdicts into comparison views.
//
// Usage:
//   bun eval/aggregate.mjs [--variant label] [--since ISO]
//
// Scans eval/.runs/*/report.json, prints two tables:
//   • dimension scores per (model, effort, variant) — the ranking view;
//   • per-phase opportunityTaken grid — shows WHERE on the flow each model
//     activates, which is the intelligence-axis signal.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./setup.mjs";

function option(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

const variantFilter = option("--variant");
const since = option("--since");

const rows = [];
for (const dir of existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : []) {
  const reportPath = join(RUNS_DIR, dir, "report.json");
  if (!existsSync(reportPath)) continue;
  let report;
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { continue; }
  if (!report.flowId) continue;
  if (variantFilter && report.variant !== variantFilter) continue;
  if (since && report.startedAt && report.startedAt < since) continue;
  rows.push({ dir, report });
}

rows.sort((a, b) => (a.report.startedAt ?? "").localeCompare(b.report.startedAt ?? ""));

if (rows.length === 0) {
  console.log("No matching runs.");
  process.exit(0);
}

const DIMS = ["activation", "timing_and_measure", "handoff_quality", "recoverability", "ceiling", "task_completion"];
const DIM_SHORT = { activation: "act", timing_and_measure: "度", handoff_quality: "hand", recoverability: "recov", ceiling: "ceil", task_completion: "task" };

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }

console.log(`\n=== dimension scores (${rows.length} runs${variantFilter ? `, variant=${variantFilter}` : ""}) ===`);
console.log(
  pad("model", 26) + pad("eff", 7) + pad("var", 11) +
  DIMS.map((d) => pad(DIM_SHORT[d], 6)).join("") + pad("all", 5) + pad("tier", 7) + "topAttributions",
);
for (const { report } of rows) {
  const v = report.judge?.verdict;
  const dims = v?.dimensions ?? {};
  const scoreCells = DIMS.map((d) => pad(dims[d]?.score ?? "-", 6)).join("");
  const err = report.runError ? "RUN-ERR" : (report.judge?.error ? "JUDGE-ERR" : "");
  console.log(
    pad(report.model.modelId, 26) +
    pad(report.thinkingLevel, 7) +
    pad(report.variant ?? "-", 11) +
    scoreCells +
    pad(v?.overall?.score ?? "-", 5) +
    pad(v?.overall?.modelTier ?? err ?? "-", 7) +
    (v?.topAttributions?.join(",") ?? err),
  );
}

console.log(`\n=== per-phase opportunityTaken grid ===`);
console.log(pad("model", 26) + pad("eff", 7) + "P1  P2  P3  P4  P5  P6   (✓=taken)");
for (const { report } of rows) {
  const perPhase = report.judge?.verdict?.perPhase ?? [];
  const byPhase = new Map(perPhase.map((p) => [String(p.phase).split("-")[0], p]));
  const cells = ["P1", "P2", "P3", "P4", "P5", "P6"].map((p) => {
    const rec = byPhase.get(p);
    if (!rec) return pad("·", 4);
    return pad(rec.opportunityTaken ? `✓${rec.quality ?? ""}` : "✗", 4);
  }).join("");
  console.log(pad(report.model.modelId, 26) + pad(report.thinkingLevel, 7) + cells);
}

console.log(`\n=== one-line summaries ===`);
for (const { report } of rows) {
  const v = report.judge?.verdict;
  console.log(`• ${report.model.modelId} (${report.thinkingLevel}): ${v?.overall?.summary ?? report.runError ?? report.judge?.error ?? "(no verdict)"}`);
}
