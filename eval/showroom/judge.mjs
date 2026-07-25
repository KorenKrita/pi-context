#!/usr/bin/env node
// Fact-checking judge for paired showroom replays. No semantic scoring:
// every check is a mechanical comparison of transcript facts against the
// scenario's expected.json answer sheet. The single semantic exception (N3's
// unfulfilled-obligation check in a travel handoff) is reported with an
// explicit lowConfidence flag instead of a verdict.
//
// Usage:
//   node judge.mjs --run eval/.runs/showroom/P2            (judges both arms)
//   node judge.mjs --run eval/.runs/showroom/P2 --arm on
//
// Verdict vocabulary per arm:
//   pass         — all required moves found, no forbidden move, probe answered
//   fail         — at least one required/forbidden/probe check failed
//   run_error    — provider transport failure (nonzero exit / timeout); never
//                  counted as a task outcome
//   diagnostics  — scenario is diagnosticsOnly: facts recorded, no verdict

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { arms: ["on", "off"] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = argv[++i];
    else if (a === "--arm") out.arms = [argv[++i]];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.run) throw new Error("usage: judge.mjs --run <scenario-run-dir> [--arm on|off]");
  return out;
}

/**
 * Flatten one arm's transcript into an ordered fact stream:
 * { kind: "tool", turn, name, input } and { kind: "text", turn, text }.
 * Only completed tool executions count — a streamed toolCall part with no
 * matching completion is not a move.
 */
function extractFacts(transcript) {
  const facts = [];
  for (const turn of transcript.turns) {
    for (const event of turn.events ?? []) {
      if (event.type === "tool_execution_start") {
        facts.push({ kind: "tool", turn: turn.turn, name: event.toolName, input: event.args ?? event.input ?? {} });
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (Array.isArray(event.message.content) ? event.message.content : [])
          .filter((p) => p?.type === "text")
          .map((p) => p.text)
          .join("\n");
        if (text.trim()) facts.push({ kind: "text", turn: turn.turn, text });
      }
    }
  }
  return facts;
}

function transportFailure(transcript) {
  const bad = transcript.turns.find((t) => t.exitStatus !== 0 || t.timedOut);
  return bad ? { turn: bad.turn, exitStatus: bad.exitStatus, timedOut: bad.timedOut, stderrTail: bad.stderrTail } : null;
}

const READ_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);
const WRITE_TOOLS = new Set(["write", "replace", "edit"]);

function toolMatches(spec, name) {
  return spec.split("|").includes(name);
}

/** requiredMoves: { tool, withinToolCalls?, afterReads?, inTurn? } */
function checkRequiredMove(move, facts) {
  const tools = facts.filter((f) => f.kind === "tool");
  let searchStart = 0;
  if (typeof move.afterReads === "number") {
    let reads = 0;
    for (let i = 0; i < tools.length; i++) {
      if (READ_TOOLS.has(tools[i].name)) reads++;
      if (reads >= move.afterReads) { searchStart = i + 1; break; }
    }
    if (reads < move.afterReads) {
      return { satisfied: false, reason: `prefix condition unmet: only ${reads}/${move.afterReads} reads happened` };
    }
  }
  const windowEnd = typeof move.withinToolCalls === "number" ? searchStart + move.withinToolCalls : tools.length;
  for (let i = searchStart; i < Math.min(windowEnd, tools.length); i++) {
    const fact = tools[i];
    if (!toolMatches(move.tool, fact.name)) continue;
    if (typeof move.inTurn === "number" && fact.turn !== move.inTurn) continue;
    return { satisfied: true, at: { index: i, turn: fact.turn, name: fact.name } };
  }
  return { satisfied: false, reason: `no ${move.tool} within tool calls ${searchStart}..${windowEnd - 1}${typeof move.inTurn === "number" ? ` in turn ${move.inTurn}` : ""}` };
}

/** forbiddenMoves: { tool, betweenReadsAndWrites?, beforeProbeAnswer?, inTurn? } */
function checkForbiddenMove(move, facts, probe) {
  const violations = [];
  const tools = facts.filter((f) => f.kind === "tool");
  const firstWriteIdx = tools.findIndex((f) => WRITE_TOOLS.has(f.name));
  const probeAnsweredAtTurn = probe
    ? (facts.find((f) => f.kind === "text" && probe.mustContain.every((s) => f.text.includes(s)))?.turn ?? Infinity)
    : Infinity;

  tools.forEach((fact, index) => {
    if (!toolMatches(move.tool, fact.name)) return;
    if (typeof move.inTurn === "number" && fact.turn !== move.inTurn) return;
    if (move.betweenReadsAndWrites) {
      const inZone = firstWriteIdx === -1 || index < firstWriteIdx;
      if (!inZone) return;
    }
    if (move.beforeProbeAnswer && fact.turn > probeAnsweredAtTurn) return;
    violations.push({ index, turn: fact.turn, name: fact.name });
  });
  return violations;
}

function checkProbe(probe, facts) {
  const texts = facts.filter((f) => f.kind === "text").map((f) => f.text).join("\n\n");
  const missing = probe.mustContain.filter((s) => !texts.includes(s));
  return { satisfied: missing.length === 0, missing };
}

function checkHandoff(mustContain, facts) {
  const travels = facts.filter((f) => f.kind === "tool" && f.name === "acm_travel");
  if (travels.length === 0) return { applicable: false };
  const summaries = travels.map((t) => String(t.input?.summary ?? "")).join("\n\n");
  const missing = mustContain.filter((s) => !summaries.includes(s));
  return { applicable: true, satisfied: missing.length === 0, missing };
}

/** Facts recorded for every arm regardless of verdict; diagnostics-only scenarios stop here. */
function collectDiagnostics(facts) {
  const tools = facts.filter((f) => f.kind === "tool");
  const acmCalls = tools.filter((f) => f.name.startsWith("acm_"));
  let maxReadBurst = 0, current = 0;
  for (const f of tools) {
    if (READ_TOOLS.has(f.name)) { current++; maxReadBurst = Math.max(maxReadBurst, current); }
    else current = 0;
  }
  return {
    toolCalls: tools.length,
    reads: tools.filter((f) => READ_TOOLS.has(f.name)).length,
    writes: tools.filter((f) => WRITE_TOOLS.has(f.name)).length,
    maxReadBurst,
    acmCalls: acmCalls.map((f) => ({ turn: f.turn, name: f.name })),
    firstAcmCallIndex: tools.findIndex((f) => f.name.startsWith("acm_")),
  };
}

function judgeArm(armDir, expected) {
  const transcriptPath = join(armDir, "transcript.json");
  if (!existsSync(transcriptPath)) return { verdict: "missing", reason: "no transcript.json" };
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));

  const transport = transportFailure(transcript);
  if (transport) return { verdict: "run_error", transport };

  const facts = extractFacts(transcript);
  const expect = expected.expect;
  const diagnostics = collectDiagnostics(facts);

  if (expect.diagnosticsOnly) return { verdict: "diagnostics", diagnostics };

  const checks = { requiredMoves: [], forbiddenViolations: [], probe: null, handoff: null };
  let pass = true;

  for (const move of expect.requiredMoves ?? []) {
    const result = checkRequiredMove(move, facts);
    checks.requiredMoves.push({ move, ...result });
    if (!result.satisfied) pass = false;
  }
  for (const move of expect.forbiddenMoves ?? []) {
    const violations = checkForbiddenMove(move, facts, expect.probe);
    if (violations.length > 0) {
      checks.forbiddenViolations.push({ move, violations });
      pass = false;
    }
  }
  if (expect.probe) {
    checks.probe = checkProbe(expect.probe, facts);
    if (!checks.probe.satisfied) pass = false;
  }
  if (expect.handoffMustContain) {
    checks.handoff = checkHandoff(expect.handoffMustContain, facts);
    // Semantic exception (N3): whether NEXT carries the unfulfilled obligation
    // is judged only as substring presence; flag it as low-confidence instead
    // of pretending the check is semantic.
    checks.handoff.lowConfidence = true;
    if (checks.handoff.applicable && !checks.handoff.satisfied) pass = false;
  }

  return { verdict: pass ? "pass" : "fail", checks, diagnostics };
}

function main() {
  const args = parseArgs(process.argv);
  const expected = JSON.parse(readFileSync(join(args.run, "base", "expected.json"), "utf8"));
  const report = {
    scenario: expected.scenario,
    judged: new Date().toISOString(),
    arms: {},
  };
  for (const arm of args.arms) {
    report.arms[arm] = judgeArm(join(args.run, arm), expected);
  }
  const outPath = join(args.run, "verdict.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
