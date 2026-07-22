#!/usr/bin/env bun
// Cross-round analysis: model intelligence ranking, version comparison,
// ACM-fit ranking, and perfect-run detection. Token + cost come from each
// run's events.jsonl (per-message usage, summed).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./setup.mjs";
import { validatePersistedVerdict } from "./judge.mjs";
import { getFlow } from "./flow.mjs";

const VARIANTS = ["original", "pr12", "pr14", "HEAD-cold"];
const VLABEL = { original: "原版", pr12: "PR12", pr14: "PR14", "HEAD-cold": "HEAD" };
const DIMS = ["activation", "timing_and_measure", "handoff_quality", "recoverability", "ceiling", "task_completion"];
const ACM_DIMS = ["activation", "timing_and_measure", "handoff_quality", "recoverability", "ceiling"];
const rejectedJudgeReports = [];

function expectedPhases(report) {
  const persisted = Array.isArray(report.turns) ? report.turns.map((turn) => turn.phase) : undefined;
  return persisted?.length && persisted.every((phase) => typeof phase === "string")
    ? persisted
    : getFlow(report.flowId)?.turns.map((turn) => turn.phase);
}

function usageOf(dir) {
  const ev = join(dir, "events.jsonl");
  if (!existsSync(ev)) return { tokens: 0, cost: 0 };
  let tokens = 0, cost = 0;
  for (const l of readFileSync(ev, "utf8").split("\n")) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "message_end" && e.message?.role === "assistant" && e.message?.usage) {
      tokens += e.message.usage.totalTokens || 0;
      cost += e.message.usage.cost?.total || 0;
    }
  }
  return { tokens, cost };
}

const runs = [];
for (const d of readdirSync(RUNS_DIR)) {
  const rp = join(RUNS_DIR, d, "report.json");
  if (!existsSync(rp)) continue;
  let r; try { r = JSON.parse(readFileSync(rp, "utf8")); } catch { continue; }
  if (!VARIANTS.includes(r.variant)) continue;
  if (r.agentsOnly && r.sandbox?.formalEvidenceEligible !== true) {
    rejectedJudgeReports.push({ dir: d, model: r.model?.modelId ?? "unknown", status: "SANDBOX-ERR" });
    continue;
  }
  const v = r.judge?.verdict;
  const validation = v === undefined ? undefined : validatePersistedVerdict(v, { expectedPhases: expectedPhases(r) });
  if (validation && !validation.ok) {
    const status = validation.errors.some((item) => item.startsWith("$.rubricVersion: unsupported rubric"))
      ? "RUBRIC-MISMATCH"
      : "JUDGE-ERR";
    rejectedJudgeReports.push({ dir: d, model: r.model?.modelId ?? "unknown", status });
    continue;
  }
  const u = usageOf(join(RUNS_DIR, d));
  runs.push({
    model: r.model?.modelId ?? "unknown", eff: r.thinkingLevel, variant: r.variant, rubricVersion: v?.rubricVersion ?? r.rubricVersion ?? "unjudged",
    durMin: r.durationMs / 60000, err: !!r.runError,
    dims: Object.fromEntries(DIMS.map((k) => [k, v?.dimensions?.[k]?.score ?? null])),
    overall: v?.overall?.score ?? null, tier: v?.overall?.modelTier ?? null,
    phasesTaken: (v?.perPhase || []).filter((p) => p.opportunityTaken).length,
    tokens: u.tokens, cost: u.cost,
  });
}

const pad = (s, n) => { s = String(s); let w = 0; for (const c of s) w += c.charCodeAt(0) > 255 ? 2 : 1; return w >= n ? s : s + " ".repeat(n - w); };
const avg = (arr, f) => { const xs = arr.map(f).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const fmt = (x, d = 1) => x == null ? "-" : x.toFixed(d);

const modelKeys = [...new Set(runs.map((r) => `${r.rubricVersion}\u0000${r.model}\u0000${r.eff}`))];

// ---- 1. Model intelligence ranking (task + efficiency across rounds) ----
console.log("\n================ 1. 模型综合排行（按 rubric 分组的跨四轮均值）================");
console.log(pad("rubric", 20) + pad("model", 26) + pad("eff", 6) + pad("轮", 4) + pad("任务", 6) + pad("总分", 6) + pad("时长m", 8) + pad("token", 9) + pad("金额$", 9) + "tier");
const modelRows = modelKeys.map((key) => {
  const [rubricVersion, m, eff] = key.split("\u0000");
  const rs = runs.filter((r) => r.rubricVersion === rubricVersion && r.model === m && r.eff === eff);
  return {
    rubricVersion, m, eff, n: rs.length,
    task: avg(rs, (r) => r.dims.task_completion), overall: avg(rs, (r) => r.overall),
    dur: avg(rs, (r) => r.durMin), tok: avg(rs, (r) => r.tokens), cost: avg(rs, (r) => r.cost),
    tiers: [...new Set(rs.map((r) => r.tier).filter(Boolean))].join("/"),
  };
});
modelRows.sort((a, b) => (b.task - a.task) || (a.dur - b.dur));
for (const r of modelRows) {
  console.log(pad(r.rubricVersion, 20) + pad(r.m, 26) + pad(r.eff, 6) + pad(r.n, 4) + pad(fmt(r.task, 1), 6) + pad(fmt(r.overall, 1), 6) +
    pad(fmt(r.dur, 1), 8) + pad(Math.round(r.tok / 1000) + "K", 9) + pad("$" + fmt(r.cost, 2), 9) + r.tiers);
}

// ---- 2. Version comparison ----
console.log("\n================ 2. 版本对比（按 rubric 分组的跨模型均值）================");
console.log(pad("rubric", 20) + pad("version", 10) + pad("n", 4) + DIMS.map((d) => pad(d.slice(0, 5), 6)).join("") + pad("overall", 8) + pad("时长m", 8) + pad("token", 9) + pad("金额$", 8));
for (const rubricVersion of [...new Set(runs.map((r) => r.rubricVersion))]) {
  for (const key of VARIANTS) {
    const rs = runs.filter((r) => r.rubricVersion === rubricVersion && r.variant === key);
    if (!rs.length) continue;
    console.log(pad(rubricVersion, 20) + pad(VLABEL[key], 10) + pad(rs.length, 4) +
      DIMS.map((d) => pad(fmt(avg(rs, (r) => r.dims[d]), 1), 6)).join("") +
      pad(fmt(avg(rs, (r) => r.overall), 2), 8) + pad(fmt(avg(rs, (r) => r.durMin), 1), 8) +
      pad(Math.round(avg(rs, (r) => r.tokens) / 1000) + "K", 9) + pad("$" + fmt(avg(rs, (r) => r.cost), 2), 8));
  }
}

// ---- 3. ACM fit ranking (avg of the 5 ACM dims across rounds) ----
console.log("\n================ 3. 最适合 ACM 的模型（按 rubric 分组，排除任务）================");
console.log(pad("rubric", 20) + pad("model", 26) + pad("轮", 4) + pad("ACM均", 7) + ACM_DIMS.map((d) => pad(d.slice(0, 5), 6)).join("") + "bestVariant");
const acmRows = modelKeys.map((key) => {
  const [rubricVersion, m, eff] = key.split("\u0000");
  const rs = runs.filter((r) => r.rubricVersion === rubricVersion && r.model === m && r.eff === eff);
  const acmAvg = avg(rs, (r) => { const xs = ACM_DIMS.map((d) => r.dims[d]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; });
  const best = rs.slice().sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))[0];
  return { rubricVersion, m, eff, n: rs.length, acmAvg, byDim: Object.fromEntries(ACM_DIMS.map((d) => [d, avg(rs, (r) => r.dims[d])])), best: best ? `${VLABEL[best.variant]}(${best.overall})` : "-" };
});
acmRows.sort((a, b) => (b.acmAvg ?? -1) - (a.acmAvg ?? -1));
for (const r of acmRows) {
  console.log(pad(r.rubricVersion, 20) + pad(r.m, 26) + pad(r.n, 4) + pad(fmt(r.acmAvg, 2), 7) + ACM_DIMS.map((d) => pad(fmt(r.byDim[d], 1), 6)).join("") + r.best);
}

// ---- 4. Perfect runs: all 6 dims == 3 AND all 6 phases taken ----
console.log("\n================ 4. 完美 run（六维全 3 且六阶段全抓）================");
const perfect = runs.filter((r) => DIMS.every((d) => r.dims[d] === 3) && r.phasesTaken >= 6);
if (perfect.length === 0) console.log("（无六维全满 run）");
for (const r of perfect) console.log(`★ [${r.rubricVersion}] ${r.model} (${r.eff}) @ ${VLABEL[r.variant]}: 六维全 3，六阶段全抓，overall ${r.overall}`);
console.log("\n-- 近满 run（overall==3）--");
for (const r of runs.filter((x) => x.overall === 3).sort((a, b) => b.phasesTaken - a.phasesTaken)) {
  console.log(`  [${r.rubricVersion}] ${r.model} (${r.eff}) @ ${VLABEL[r.variant]}: overall 3, 阶段 ${r.phasesTaken}/6, dims ${DIMS.map((d) => r.dims[d]).join("")}`);
}

if (rejectedJudgeReports.length) {
  console.log(`\n持久化裁决拒绝记录（不纳入平均值）：`);
  for (const report of rejectedJudgeReports) console.log(`  ${report.status}: ${report.dir} (${report.model})`);
}
console.log(`\n(总计 ${runs.length} 个 run；kimi-k3 在 original/pr12 两轮因 timeout 截断已剔除、未重跑)`);
