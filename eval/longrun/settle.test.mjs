import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acmActivity, billedCost, deriveSpec, settleArm } from "./settle.mjs";
import { SCENARIO } from "./scenario.mjs";

function usageEvent({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, price }) {
  const cost = {
    input: (input * price.input) / 1e6,
    output: (output * price.output) / 1e6,
    cacheRead: (cacheRead * price.cacheRead) / 1e6,
    cacheWrite: (cacheWrite * price.cacheWrite) / 1e6,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return {
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead, cost },
    },
  };
}

const SOL = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };

/** A synthetic 30-turn transcript: no model calls, no spend. */
function syntheticTranscript({ foldAtTurn = null, model = "local-responses/gpt-5.6-sol" } = {}) {
  const turns = [];
  for (let turn = 1; turn <= 30; turn += 1) {
    const phase =
      turn <= 7 ? "survey" : turn === 8 ? "settle" : turn <= 24 ? "apply" : "regress";
    const promptTokens = 20_000 + turn * 3_000;
    const events = [usageEvent({ input: 500, output: 300, cacheRead: promptTokens - 500, price: SOL })];
    if (turn === foldAtTurn) {
      events.unshift({ type: "tool_execution_start", toolName: "acm_travel", args: {} });
    }
    if (turn === 3) {
      events.unshift({ type: "tool_execution_start", toolName: "acm_checkpoint", args: {} });
    }
    turns.push({ turn, phase, prompt: `turn ${turn}`, exitStatus: 0, timedOut: false, events });
  }
  return { arm: "on", model, thinking: "high", scenario: SCENARIO.id, turns };
}

test("billed cost sums the real per-category charges, not token counts", () => {
  const transcript = syntheticTranscript();
  const billing = billedCost(transcript);

  // 30 turns * 500 input tokens at $5/M, and 30 * 300 output at $30/M.
  expect(billing.tokens.input).toBe(15_000);
  expect(billing.totals.input).toBeCloseTo(0.075, 6);
  expect(billing.totals.output).toBeCloseTo(0.27, 6);
  expect(billing.totals.total).toBeCloseTo(
    billing.totals.input + billing.totals.output + billing.totals.cacheRead + billing.totals.cacheWrite,
    9,
  );

  // cacheRead dominates the bill even though its rate is the lowest — this is
  // exactly why token counts cannot stand in for dollars.
  expect(billing.totals.cacheRead).toBeGreaterThan(billing.totals.input);
  expect(billing.perTurn).toHaveLength(30);
  expect(billing.perTurn[0]).toMatchObject({ turn: 1, phase: "survey" });
});

test("ACM activity separates checkpointing from folding and locates the first fold", () => {
  const none = acmActivity(syntheticTranscript());
  expect(none.travelCount).toBe(0);
  expect(none.firstFoldAfterTurn).toBe(null);
  expect(none.callCount).toBe(1); // one checkpoint, no travel
  expect(none.calls[0]).toMatchObject({ turn: 3, tool: "acm_checkpoint" });

  const folded = acmActivity(syntheticTranscript({ foldAtTurn: 9 }));
  expect(folded.callCount).toBe(2); // the checkpoint plus the travel
  expect(folded.travelCount).toBe(1);
  // A travel during turn 9 means nine turns were completed before it settled.
  expect(folded.firstFoldAfterTurn).toBe(8);
  expect(folded.foldTurns).toEqual([9]);
});

test("the model spec is derived from observed sizes, not assumed ones", () => {
  const transcript = syntheticTranscript();
  const spec = deriveSpec(transcript, billedCost(transcript));

  // Context at the settling turn, and growth measured across the apply phase.
  expect(spec.contextTokens).toBe(20_000 + 8 * 3_000);
  expect(spec.deltaTokens).toBe(3_000);
  expect(spec.requests).toBe(30);
  expect(spec.settledAtRequest).toBe(SCENARIO.settlesAtTurn);
  expect(spec.foldedTokens).toBe(Math.round(spec.contextTokens * 0.15));
});

test("settling an arm reports all three dependent variables together", () => {
  const dir = mkdtempSync(join(tmpdir(), "longrun-settle-"));
  try {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify(syntheticTranscript({ foldAtTurn: 9 })),
    );
    writeFileSync(
      join(dir, "outcome.json"),
      JSON.stringify({ command: "node verify.mjs", exitStatus: 0, delivered: true, stdout: "12 services reconciled", stderr: "" }),
    );

    const settled = settleArm(dir);
    expect(settled.billedTotal).toBeGreaterThan(0);
    expect(settled.outcomeDelivered).toBe(true);
    expect(settled.completed).toBe(true);

    // Folding right after the settling turn is the optimum this scenario is
    // designed around, so a well-timed run scores zero deviation.
    expect(settled.priceResolved).toBe(true);
    expect(settled.foldTiming).toMatchObject({ verdict: "optimal", deviation: 0 });
    expect(settled.acm.travelCount).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that never folded is scored against the same optimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "longrun-settle-nofold-"));
  try {
    writeFileSync(join(dir, "transcript.json"), JSON.stringify(syntheticTranscript()));
    writeFileSync(
      join(dir, "outcome.json"),
      JSON.stringify({ command: "node verify.mjs", exitStatus: 1, delivered: false, stdout: "", stderr: "search.poolSize" }),
    );

    const settled = settleArm(dir);
    expect(settled.outcomeDelivered).toBe(false);
    expect(settled.outcomeDetail).toContain("search.poolSize");
    expect(settled.acm.travelCount).toBe(0);
    expect(settled.foldTiming.verdict).toBe("missed");
    expect(settled.foldTiming.excessCost).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown model yields no timing rather than a fabricated price", () => {
  const dir = mkdtempSync(join(tmpdir(), "longrun-settle-noprice-"));
  try {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify(syntheticTranscript({ model: "nonexistent/model-x" })),
    );
    writeFileSync(
      join(dir, "outcome.json"),
      JSON.stringify({ command: "node verify.mjs", exitStatus: 0, delivered: true, stdout: "ok", stderr: "" }),
    );

    const settled = settleArm(dir);
    expect(settled.priceResolved).toBe(false);
    expect(settled.foldTiming).toBe(null);
    // The billed total still comes from the transcript itself.
    expect(settled.billedTotal).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
