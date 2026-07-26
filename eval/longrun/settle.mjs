#!/usr/bin/env node
// Settle a long-run pair on its final coordinates. No process scoring: the run
// is judged on the total bill it produced, whether the deliverable works, and
// how far its fold timing sat from the computable optimum.
//
// The three dependent variables:
//   1 billedTotal  — real dollars from message.usage.cost (per-category rates
//                    differ by an order of magnitude, so token counts cannot
//                    substitute for this).
//   2 outcome      — the fixture's own verify.mjs exit status.
//   3 foldTiming   — scoreFoldTiming() deviation from the theoretical optimum,
//                    where the optimum is derived from the settling turn (an
//                    observable artifact) rather than an author's guess.
//
// Usage:
//   node settle.mjs --run eval/.runs/longrun/<label>
//   node settle.mjs --run <dir> --json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compareFoldPolicies, scoreFoldTiming } from "../cost-model.mjs";
import { SCENARIO } from "./scenario.mjs";

const ACM_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);

function parseArgs(argv) {
  const out = { arms: ["on", "off"], json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--run") out.run = argv[++i];
    else if (a === "--arm") out.arms = [argv[++i]];
    else if (a === "--json") out.json = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.run) throw new Error("usage: settle.mjs --run <run-dir> [--arm on|off] [--json]");
  out.run = resolve(out.run);
  return out;
}

/**
 * Sum the real billed cost from a transcript's assistant usage blocks.
 * Categories are kept separate because that separation is the whole reason
 * folding has a break-even point at all.
 */
export function billedCost(transcript) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const perTurn = [];

  for (const turn of transcript.turns ?? []) {
    const turnTotals = { total: 0, promptTokens: 0 };
    for (const event of turn.events ?? []) {
      if (event.type !== "message_end") continue;
      const usage = event.message?.usage;
      if (!usage?.cost) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        totals[key] += usage.cost[key] ?? 0;
        tokens[key] += usage[key] ?? 0;
      }
      totals.total += usage.cost.total ?? 0;
      turnTotals.total += usage.cost.total ?? 0;
      // Prompt size for this request: everything the provider read.
      turnTotals.promptTokens = Math.max(
        turnTotals.promptTokens,
        (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
      );
    }
    perTurn.push({ turn: turn.turn, phase: turn.phase, cost: turnTotals.total, promptTokens: turnTotals.promptTokens });
  }

  return { totals, tokens, perTurn };
}

/**
 * Locate ACM activity: the first travel decides fold timing, and every ACM call
 * is recorded so a run that only checkpointed is distinguishable from one that
 * actually folded.
 */
export function acmActivity(transcript) {
  const calls = [];
  for (const turn of transcript.turns ?? []) {
    for (const event of turn.events ?? []) {
      if (event.type !== "tool_execution_start") continue;
      const name = event.toolName;
      if (!ACM_TOOLS.has(name)) continue;
      calls.push({ turn: turn.turn, phase: turn.phase, tool: name });
    }
  }
  const travels = calls.filter((call) => call.tool === "acm_travel");
  return {
    calls,
    callCount: calls.length,
    travelCount: travels.length,
    // Fold timing is expressed in completed turns before the fold, matching
    // the cost model's foldAfterRequest.
    firstFoldAfterTurn: travels.length > 0 ? travels[0].turn - 1 : null,
    foldTurns: travels.map((travel) => travel.turn),
  };
}

/**
 * Derive the cost-model spec from what the run actually observed, so the
 * theoretical optimum is grounded in measured sizes rather than assumptions.
 */
export function deriveSpec(transcript, billing) {
  const turns = billing.perTurn;
  const settling = SCENARIO.settlesAtTurn;

  // Context carried into the settling point: the prompt size at that turn.
  const atSettling = turns.find((turn) => turn.turn === settling);
  const contextTokens = atSettling?.promptTokens ?? turns.at(-1)?.promptTokens ?? 0;

  // Per-request growth measured across the apply phase, where turns are
  // uniform small edits.
  const applyTurns = turns.filter((turn) => turn.phase === "apply");
  const growth =
    applyTurns.length >= 2
      ? Math.max(
          0,
          Math.round(
            (applyTurns.at(-1).promptTokens - applyTurns[0].promptTokens) / (applyTurns.length - 1),
          ),
        )
      : 3_000;

  return {
    contextTokens,
    requests: turns.length,
    deltaTokens: growth,
    // A handoff plus surviving spine; 15% is the retained fraction the cost
    // model was calibrated against and is reported so it can be revisited.
    foldedTokens: Math.round(contextTokens * 0.15),
    settledAtRequest: settling,
    recoveryTokens: Math.round(contextTokens * 0.75),
  };
}

function loadPrice(model) {
  // Prices come from the same models.json the run used, so the settlement and
  // the theory share one source of truth.
  const path = join(process.env.HOME ?? "", ".pi", "agent", "models.json");
  if (!existsSync(path)) return null;
  const models = JSON.parse(readFileSync(path, "utf8"));
  const [providerName, modelId] = model.split("/");
  const provider = models.providers?.[providerName];
  const entry = provider?.models?.find((candidate) => candidate.id === modelId);
  const cost = entry?.cost;
  if (!cost) return null;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
  };
}

/** Settle one arm into its three final coordinates. */
export function settleArm(armDir) {
  const transcript = JSON.parse(readFileSync(join(armDir, "transcript.json"), "utf8"));
  const outcome = JSON.parse(readFileSync(join(armDir, "outcome.json"), "utf8"));
  const billing = billedCost(transcript);
  const acm = acmActivity(transcript);
  const spec = deriveSpec(transcript, billing);
  const price = loadPrice(transcript.model);

  let timing = null;
  if (price) {
    const withPrice = { ...spec, price };
    timing = scoreFoldTiming(withPrice, acm.firstFoldAfterTurn);
    timing.theoreticalSavings = compareFoldPolicies(withPrice).savings;
  }

  const completed = (transcript.turns ?? []).every((turn) => turn.exitStatus === 0 && !turn.timedOut);

  return {
    arm: transcript.arm,
    model: transcript.model,
    thinking: transcript.thinking,
    turnsRun: (transcript.turns ?? []).length,
    completed,
    // Dependent variable 1: what it actually cost.
    billedTotal: billing.totals.total,
    billedByCategory: billing.totals,
    tokensByCategory: billing.tokens,
    // Dependent variable 2: did the deliverable work.
    outcomeDelivered: outcome.delivered,
    outcomeDetail: outcome.delivered ? outcome.stdout : outcome.stderr,
    // Dependent variable 3: was the fold well timed.
    foldTiming: timing,
    acm,
    modelSpec: spec,
    priceResolved: price !== null,
    perTurn: billing.perTurn,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const arms = {};
  for (const arm of args.arms) {
    const armDir = join(args.run, arm);
    if (!existsSync(join(armDir, "transcript.json"))) continue;
    arms[arm] = settleArm(armDir);
  }
  if (Object.keys(arms).length === 0) throw new Error(`no judged arms under ${args.run}`);

  const settlement = {
    scenario: SCENARIO.id,
    run: args.run,
    settledAt: new Date().toISOString(),
    arms,
  };
  if (arms.on && arms.off) {
    settlement.paired = {
      billedDelta: arms.on.billedTotal - arms.off.billedTotal,
      billedRatio: arms.off.billedTotal > 0 ? arms.on.billedTotal / arms.off.billedTotal : null,
      outcomeMatch: arms.on.outcomeDelivered === arms.off.outcomeDelivered,
      onDeviation: arms.on.foldTiming?.deviation ?? null,
      offDeviation: arms.off.foldTiming?.deviation ?? null,
    };
  }

  writeFileSync(join(args.run, "settlement.json"), JSON.stringify(settlement, null, 2));

  if (args.json) {
    process.stdout.write(JSON.stringify(settlement, null, 2) + "\n");
    return;
  }
  for (const [arm, result] of Object.entries(arms)) {
    process.stdout.write(
      `${arm}: $${result.billedTotal.toFixed(4)} | outcome=${result.outcomeDelivered ? "delivered" : "FAILED"} | ` +
        `turns=${result.turnsRun}${result.completed ? "" : " (incomplete)"} | ` +
        `acm=${result.acm.callCount} calls/${result.acm.travelCount} travels | ` +
        `timing=${result.foldTiming ? `${result.foldTiming.verdict} dev=${result.foldTiming.deviation} excess=$${result.foldTiming.excessCost.toFixed(4)}` : "no price"}\n`,
    );
  }
  if (settlement.paired) {
    process.stdout.write(
      `paired: on-off=$${settlement.paired.billedDelta.toFixed(4)} ` +
        `ratio=${settlement.paired.billedRatio?.toFixed(3) ?? "n/a"} ` +
        `outcomeMatch=${settlement.paired.outcomeMatch}\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
