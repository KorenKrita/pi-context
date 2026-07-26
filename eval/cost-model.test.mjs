import { expect, test } from "bun:test";

import {
  compareFoldPolicies,
  computePolicyCost,
  findBreakEvenRequests,
  foldingCurve,
} from "./cost-model.mjs";

// Real per-million rates from ~/.pi/agent/models.json (2026-07-26).
const SOL = Object.freeze({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
const DEEPSEEK_V4_FLASH = Object.freeze({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });

// The measured shape behind the showroom diagnosis: a 200K prompt, 3K new tokens
// per request, and a fold that keeps 15% of the context.
const SHAPE = Object.freeze({ contextTokens: 200_000, deltaTokens: 3_000, foldedTokens: 30_000 });

test("sol savings match the verified data points that motivated this model", () => {
  // Locked: at 10 follow-up requests not folding wins by $0.34; at 30 folding wins by $1.36.
  const short = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 10 });
  expect(short.foldIsCheaper).toBe(false);
  expect(short.optimalFoldAfterRequest).toBe(null);
  expect(short.savings).toBeCloseTo(-0.3375, 4);

  const long = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 30 });
  expect(long.foldIsCheaper).toBe(true);
  expect(long.savings).toBeCloseTo(1.3625, 4);

  const longer = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 60 });
  expect(longer.savings).toBeCloseTo(3.9125, 4);
});

test("break-even for the measured sol shape is request 14, far beyond a 1-3 turn scenario", () => {
  const breakEven = findBreakEvenRequests({ ...SHAPE, price: SOL });
  expect(breakEven.requests).toBe(14);
  expect(breakEven.savingsAtBreakEven).toBeGreaterThan(0);

  // This is the product conclusion: 1-3 turn scenarios cannot reach request 14,
  // so they structurally cannot show folding as anything but overhead.
  const threeTurn = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 3 });
  expect(threeTurn.foldIsCheaper).toBe(false);

  // Break-even is scale-invariant in this shape: doubling context doubles both
  // curves' pressure, so a 400K scenario crosses at the same request index.
  const doubled = findBreakEvenRequests({
    ...SHAPE,
    contextTokens: 400_000,
    foldedTokens: 60_000,
    price: SOL,
  });
  expect(doubled.requests).toBe(14);
});

test("400K sol savings match the second set of verified data points", () => {
  const shape = { ...SHAPE, contextTokens: 400_000, foldedTokens: 60_000, price: SOL };
  expect(compareFoldPolicies({ ...shape, requests: 10 }).savings).toBeCloseTo(-0.675, 4);
  expect(compareFoldPolicies({ ...shape, requests: 30 }).savings).toBeCloseTo(2.725, 4);
  expect(compareFoldPolicies({ ...shape, requests: 60 }).savings).toBeCloseTo(7.825, 4);
});

test("folding earliest is optimal once folding wins at all", () => {
  const verdict = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 30 });
  expect(verdict.optimalFoldAfterRequest).toBe(0);
  // Later folds are strictly worse: the expensive re-read grows with the context.
  const totals = verdict.candidates.map((candidate) => candidate.total);
  for (let i = 1; i < totals.length; i += 1) {
    expect(totals[i]).toBeGreaterThan(totals[i - 1]);
  }
});

test("cache pricing is the structural adversary: cheap cacheRead delays break-even", () => {
  // deepseek reads cache 50x cheaper than input, so a fold's full re-read is
  // proportionally far more expensive relative to the savings it unlocks.
  const sol = findBreakEvenRequests({ ...SHAPE, price: SOL });
  const deepseek = findBreakEvenRequests({ ...SHAPE, price: DEEPSEEK_V4_FLASH, requests: 1 });
  expect(sol.requests).toBe(14);
  expect(deepseek.requests).toBe(59);
});

test("explicit policy costs decompose into the billed categories", () => {
  const noFold = computePolicyCost({ ...SHAPE, price: SOL, requests: 2, foldAfterRequest: null });
  // (200000+3000)*0.5/1e6 + (200000+6000)*0.5/1e6
  expect(noFold.breakdown.cacheRead).toBeCloseTo(0.2045, 6);
  expect(noFold.breakdown.input).toBe(0);
  expect(noFold.breakdown.cacheWrite).toBe(0);
  expect(noFold.promptTokensByRequest).toEqual([203_000, 206_000]);

  const folded = computePolicyCost({ ...SHAPE, price: SOL, requests: 2, foldAfterRequest: 0 });
  expect(folded.breakdown.input).toBeCloseTo(1.0, 6); // 200000 re-read at $5/M
  expect(folded.breakdown.cacheWrite).toBeCloseTo(0.1875, 6); // 30000 at $6.25/M
  expect(folded.promptTokensByRequest).toEqual([33_000, 36_000]);
});

test("output tokens cancel in savings but appear in absolute totals", () => {
  const withOutput = compareFoldPolicies({
    ...SHAPE,
    price: SOL,
    requests: 30,
    outputTokensPerRequest: 800,
  });
  const withoutOutput = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 30 });
  expect(withOutput.savings).toBeCloseTo(withoutOutput.savings, 6);
  expect(withOutput.noFold.total).toBeGreaterThan(withoutOutput.noFold.total);
});

test("the handoff's own output tokens are charged to the fold", () => {
  const free = compareFoldPolicies({ ...SHAPE, price: SOL, requests: 30 });
  const charged = compareFoldPolicies({
    ...SHAPE,
    price: SOL,
    requests: 30,
    handoffOutputTokens: 1_000,
  });
  expect(charged.savings).toBeCloseTo(free.savings - 0.03, 6); // 1000 tokens at $30/M
});

test("foldingCurve reports both curves per request count", () => {
  const rows = foldingCurve({ ...SHAPE, price: SOL }, [10, 30]);
  expect(rows.map((row) => row.requests)).toEqual([10, 30]);
  expect(rows[0].savings).toBeCloseTo(-0.3375, 4);
  expect(rows[1].savings).toBeCloseTo(1.3625, 4);
  expect(rows[0].optimalFoldAfterRequest).toBe(null);
  expect(rows[1].optimalFoldAfterRequest).toBe(0);
});

test("invalid inputs fail loudly instead of producing plausible numbers", () => {
  expect(() => compareFoldPolicies({ ...SHAPE, price: SOL, requests: -1 })).toThrow(TypeError);
  expect(() => compareFoldPolicies({ ...SHAPE, price: SOL, requests: 2.5 })).toThrow(TypeError);
  expect(() => compareFoldPolicies({ ...SHAPE, requests: 5, price: { input: 5 } })).toThrow(TypeError);
  expect(() => compareFoldPolicies({ ...SHAPE, price: SOL, requests: 5, contextTokens: -1 })).toThrow(
    TypeError,
  );
  expect(() =>
    computePolicyCost({ ...SHAPE, price: SOL, requests: 3, foldAfterRequest: 4 }),
  ).toThrow(RangeError);
  expect(() => foldingCurve({ ...SHAPE, price: SOL }, [])).toThrow(TypeError);
});
