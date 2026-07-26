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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * requiredMoves: { tool, withinToolCalls?, afterReads?, inTurn? }
 *
 * `withinToolCalls` and `inTurn` are assay response diagnostics, not outcome
 * gates. A required move counts when it happens before the task ends after any
 * semantic prefix. Slow or early responses stay outcome-bearing while their
 * timing and placement remain visible for calibration.
 */
export function checkRequiredMove(move, facts) {
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
  for (let i = searchStart; i < tools.length; i++) {
    const fact = tools[i];
    if (!toolMatches(move.tool, fact.name)) continue;
    const toolCallsAfterPrefix = i - searchStart + 1;
    const latency = typeof move.withinToolCalls === "number"
      ? {
          toolCallsAfterPrefix,
          targetToolCalls: move.withinToolCalls,
          withinTarget: toolCallsAfterPrefix <= move.withinToolCalls,
        }
      : { toolCallsAfterPrefix };
    return {
      satisfied: true,
      at: { index: i, turn: fact.turn, name: fact.name },
      latency,
      ...(typeof move.inTurn === "number"
        ? { placement: { actualTurn: fact.turn, targetTurn: move.inTurn, inTargetTurn: fact.turn === move.inTurn } }
        : {}),
    };
  }
  const searched = tools.length - searchStart;
  return {
    satisfied: false,
    reason: `no ${move.tool} before task end after searching ${searched} tool calls`,
    ...(typeof move.withinToolCalls === "number"
      ? { latency: { observedToolCalls: searched, targetToolCalls: move.withinToolCalls, withinTarget: false } }
      : {}),
  };
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

/** workspace: { files: string[], mustContain: string[] } */
export function checkWorkspace(workspace, workspaceRoot) {
  if (!Array.isArray(workspace.files) || workspace.files.length === 0) {
    return { satisfied: false, reason: "workspace assertion has no files", files: [] };
  }

  const root = resolve(workspaceRoot);
  const files = workspace.files.map((path) => {
    const absolute = resolve(root, path);
    const fromRoot = relative(root, absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return { path, satisfied: false, reason: "path escapes workspace" };
    }
    if (!existsSync(absolute)) return { path, satisfied: false, reason: "file missing" };

    try {
      const content = readFileSync(absolute, "utf8");
      const missing = (workspace.mustContain ?? []).filter((text) => !content.includes(text));
      return { path, satisfied: missing.length === 0, missing };
    } catch (error) {
      return { path, satisfied: false, reason: `file unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  return { satisfied: files.every((file) => file.satisfied), files };
}

export function checkHandoff(mustContain, facts) {
  const travels = facts.filter((f) => f.kind === "tool" && f.name === "acm_travel");
  if (travels.length === 0) return { applicable: false };
  const handoffs = travels.map((travel) => {
    const payload = travel.input?.handoff ?? travel.input?.summary ?? "";
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  }).join("\n\n");
  const missing = mustContain.filter((s) => !handoffs.includes(s));
  return { applicable: true, satisfied: missing.length === 0, missing };
}

/**
 * Continuous scoring vector — the AB instrument.
 *
 * pass/fail stays the outcome gate, but a boolean has no resolution: a strong
 * model that already scores 10/10 cannot show improvement, and a small
 * regression stays invisible until it flips a verdict. These are mechanical
 * transcript measures (no semantic scoring) that move before the gate does,
 * so the same bank can rank models and compare product changes.
 */
export const HANDOFF_FIELDS = ["goal", "state", "evidence", "external", "exclusions", "recover", "next"];

function parseHandoffPayload(input) {
  const payload = input?.handoff ?? input?.summary ?? null;
  if (payload && typeof payload === "object") return payload;
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Cold-start substance of each travel handoff, judged structurally only:
 * which of the seven fields are present, and which load-bearing fields carry
 * something beyond a bare `none`. This measures whether the handoff has the
 * shape a fresh agent can execute, never whether the prose is good.
 */
export function scoreHandoffs(facts) {
  const travels = facts.filter((f) => f.kind === "tool" && f.name === "acm_travel");
  if (travels.length === 0) return { travels: 0 };
  const scored = travels.map((travel) => {
    const handoff = parseHandoffPayload(travel.input);
    if (!handoff) return { structured: false, fieldsPresent: 0, substantiveRequired: 0 };
    const present = HANDOFF_FIELDS.filter((f) => typeof handoff[f] === "string" && handoff[f].trim().length > 0);
    const substantive = ["goal", "state", "next"].filter((f) => {
      const value = typeof handoff[f] === "string" ? handoff[f].trim().toLowerCase() : "";
      return value.length > 0 && value !== "none";
    });
    return {
      structured: true,
      fieldsPresent: present.length,
      substantiveRequired: substantive.length,
      stateChars: typeof handoff.state === "string" ? handoff.state.trim().length : 0,
    };
  });
  return {
    travels: scored.length,
    structuredRate: scored.filter((s) => s.structured).length / scored.length,
    minFieldsPresent: Math.min(...scored.map((s) => s.fieldsPresent)),
    minSubstantiveRequired: Math.min(...scored.map((s) => s.substantiveRequired)),
    medianStateChars: median(scored.map((s) => s.stateChars ?? 0)),
    perTravel: scored,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Post-fold reread: how many read-class calls occur in the REREAD_WINDOW tool
 * calls right after a travel. Folding and then immediately re-ingesting the
 * same material is the Thrash signature, and it is invisible to a pass/fail
 * gate because the task can still succeed.
 */
export const REREAD_WINDOW = 5;

export function scorePostFoldReread(facts) {
  const tools = facts.filter((f) => f.kind === "tool");
  const windows = [];
  tools.forEach((fact, index) => {
    if (fact.name !== "acm_travel") return;
    const after = tools.slice(index + 1, index + 1 + REREAD_WINDOW);
    windows.push({ atIndex: index, reads: after.filter((f) => READ_TOOLS.has(f.name)).length, observed: after.length });
  });
  if (windows.length === 0) return { folds: 0 };
  return {
    folds: windows.length,
    maxRereads: Math.max(...windows.map((w) => w.reads)),
    totalRereads: windows.reduce((sum, w) => sum + w.reads, 0),
    windows,
  };
}

/** Required-move responsiveness in tool calls after the scenario's prefix condition. */
export function scoreMoveLatency(requiredMoveChecks) {
  const latencies = requiredMoveChecks
    .map((check) => check.latency?.toolCallsAfterPrefix)
    .filter((value) => typeof value === "number");
  if (latencies.length === 0) return { measured: 0 };
  return {
    measured: latencies.length,
    satisfiedMoves: requiredMoveChecks.filter((c) => c.satisfied).length,
    totalMoves: requiredMoveChecks.length,
    worstToolCallsAfterPrefix: Math.max(...latencies),
    withinTargetCount: requiredMoveChecks.filter((c) => c.latency?.withinTarget === true).length,
  };
}

export function buildScoreVector(facts, requiredMoveChecks, diagnostics) {
  return {
    toolCalls: diagnostics.toolCalls,
    acmCalls: diagnostics.acmCalls.length,
    firstAcmCallIndex: diagnostics.firstAcmCallIndex,
    maxReadBurst: diagnostics.maxReadBurst,
    moveLatency: scoreMoveLatency(requiredMoveChecks),
    handoff: scoreHandoffs(facts),
    postFoldReread: scorePostFoldReread(facts),
  };
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

export function judgeArm(armDir, expected) {
  const transcriptPath = join(armDir, "transcript.json");
  if (!existsSync(transcriptPath)) return { verdict: "missing", reason: "no transcript.json" };
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));

  const transport = transportFailure(transcript);
  if (transport) return { verdict: "run_error", transport };

  const facts = extractFacts(transcript);
  const expect = expected.expect;
  const diagnostics = collectDiagnostics(facts);

  if (expect.diagnosticsOnly) {
    return { verdict: "diagnostics", diagnostics, score: buildScoreVector(facts, [], diagnostics) };
  }

  const checks = { requiredMoves: [], forbiddenViolations: [], probe: null, handoff: null, workspace: null };
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
  if (expect.workspace) {
    checks.workspace = checkWorkspace(expect.workspace, join(armDir, "workspace"));
    if (!checks.workspace.satisfied) pass = false;
  }
  if (expect.handoffMustContain) {
    checks.handoff = checkHandoff(expect.handoffMustContain, facts);
    // Semantic exception (N3): whether NEXT carries the unfulfilled obligation
    // is judged only as substring presence; flag it as low-confidence instead
    // of pretending the check is semantic.
    checks.handoff.lowConfidence = true;
    if (checks.handoff.applicable && !checks.handoff.satisfied) pass = false;
  }

  return {
    verdict: pass ? "pass" : "fail",
    checks,
    diagnostics,
    // Continuous instrument alongside the gate: it moves even when the gate
    // is saturated, which is what makes AB comparison and model ranking
    // possible on a bank a strong model already passes.
    score: buildScoreVector(facts, checks.requiredMoves, diagnostics),
  };
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
