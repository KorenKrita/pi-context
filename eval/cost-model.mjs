// Analytic billing model for ACM folding: when does one acm_travel pay for itself?
//
// Why this exists: showroom scenarios ran 1-3 turns, which is far left of the
// break-even point, so every measured arm concluded "ACM is a pure cost item".
// The dominating structure is cache pricing, not token counts:
//   - An untouched prompt is billed at cacheRead (10x cheaper on sol, 50x on deepseek).
//   - Every travel invalidates that cache, so the next request re-bills the whole
//     prompt at full input price.
// Folding therefore buys a permanently smaller prompt at the price of one full
// re-read. This module computes where those two curves cross, so a scenario's
// length can be chosen from arithmetic instead of taste.
//
// Pure computation: no network, no model calls, no I/O outside the optional CLI.

const PRICE_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);

/**
 * Per-million-token prices. Callers pass real values (see ~/.pi/agent/models.json);
 * this module never hardcodes an authoritative price table.
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Price
 */

function assertPrice(price) {
  if (!price || typeof price !== "object") {
    throw new TypeError("price must be an object with per-million-token rates");
  }
  for (const field of PRICE_FIELDS) {
    const value = price[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`price.${field} must be a finite number >= 0, received ${String(value)}`);
    }
  }
}

function assertNonNegative(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number >= 0, received ${String(value)}`);
  }
}

function assertRequestCount(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, received ${String(value)}`);
  }
}

function perMillion(tokens, rate) {
  return (tokens * rate) / 1_000_000;
}

/**
 * Normalize a scenario shape shared by every entry point.
 * @param {object} spec
 * @param {number} spec.contextTokens      Prompt size carried into the scenario (C).
 * @param {number} spec.requests           Number of follow-up requests billed (N).
 * @param {number} spec.deltaTokens        New tokens appended per request (D).
 * @param {number} spec.foldedTokens       Prompt size after a fold, i.e. handoff + surviving spine (F).
 * @param {Price}  spec.price
 * @param {number} [spec.outputTokensPerRequest] Assistant output per request; identical in both
 *                                               policies, so it cancels in savings but is included
 *                                               in absolute totals when supplied.
 * @param {number} [spec.handoffOutputTokens]    Output tokens the fold itself writes (the handoff).
 * @param {number} [spec.settledAtRequest]  Request index by which the raw material's conclusions are
 *                                          extracted, i.e. the earliest point a fold loses nothing (S).
 *                                          Folding before S is premature: material still needed is gone.
 *                                          Default 0 — nothing to lose, pure-cost behaviour.
 * @param {number} [spec.recoveryTokens]    Tokens one rehydrate/reread costs when a premature fold
 *                                          removed material a later request still needs. Charged at
 *                                          input price because recovery re-reads an uncached prefix.
 */
function normalizeSpec(spec) {
  const {
    contextTokens,
    requests,
    deltaTokens,
    foldedTokens,
    price,
    outputTokensPerRequest = 0,
    handoffOutputTokens = 0,
    settledAtRequest = 0,
    recoveryTokens = 0,
  } = spec ?? {};

  assertNonNegative("contextTokens", contextTokens);
  assertRequestCount("requests", requests);
  assertNonNegative("deltaTokens", deltaTokens);
  assertNonNegative("foldedTokens", foldedTokens);
  assertNonNegative("outputTokensPerRequest", outputTokensPerRequest);
  assertNonNegative("handoffOutputTokens", handoffOutputTokens);
  assertRequestCount("settledAtRequest", settledAtRequest);
  assertNonNegative("recoveryTokens", recoveryTokens);
  assertPrice(price);

  return {
    contextTokens,
    requests,
    deltaTokens,
    foldedTokens,
    price,
    outputTokensPerRequest,
    handoffOutputTokens,
    settledAtRequest,
    recoveryTokens,
  };
}

/**
 * Cost of one policy: either never fold, or fold exactly once after request `foldAfterRequest`
 * (0 = fold before the first follow-up request).
 *
 * Billing per request i (1-based):
 *   prompt tokens = contextTokens + i * deltaTokens              while i <= foldAfterRequest
 *                 = foldedTokens + (i - foldAfterRequest) * deltaTokens   afterwards
 *   billed at cacheRead, because an untouched prefix is a cache hit.
 *
 * The fold itself pays:
 *   (contextTokens + foldAfterRequest * deltaTokens) at input   — cache invalidated, full re-read
 *   foldedTokens at cacheWrite                                  — the new prefix is written once
 *   handoffOutputTokens at output                                — the handoff text
 *
 * A fold before `settledAtRequest` is premature: each request in the gap still needs material the
 * fold removed, so it pays one recovery of `recoveryTokens` at input price. This penalty is what
 * keeps the optimum off request 0 — without it the cheapest fold is always the earliest one, which
 * would make "fold immediately" the model's advice regardless of whether conclusions had settled.
 * Cost is the only thing modeled here; an unrecovered premature fold would also risk the outcome,
 * which this model deliberately does not price.
 *
 * @param {object} spec normalizeSpec shape plus `foldAfterRequest` (null | number).
 * @returns {{ total: number, breakdown: { input: number, output: number, cacheRead: number, cacheWrite: number }, promptTokensByRequest: number[], foldAfterRequest: number|null, recoveryEvents: number, recoveryCost: number, premature: boolean }}
 */
export function computePolicyCost(spec) {
  const base = normalizeSpec(spec);
  const foldAfterRequest = spec?.foldAfterRequest ?? null;
  if (foldAfterRequest !== null) {
    assertRequestCount("foldAfterRequest", foldAfterRequest);
    if (foldAfterRequest > base.requests) {
      throw new RangeError(
        `foldAfterRequest (${foldAfterRequest}) cannot exceed requests (${base.requests}); a fold after the last request buys nothing`,
      );
    }
  }

  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const promptTokensByRequest = [];

  let recoveryEvents = 0;
  let recoveryCost = 0;
  if (foldAfterRequest !== null) {
    const reread = base.contextTokens + foldAfterRequest * base.deltaTokens;
    breakdown.input += perMillion(reread, base.price.input);
    breakdown.cacheWrite += perMillion(base.foldedTokens, base.price.cacheWrite);
    breakdown.output += perMillion(base.handoffOutputTokens, base.price.output);

    recoveryEvents = Math.max(0, Math.min(base.settledAtRequest, base.requests) - foldAfterRequest);
    recoveryCost = perMillion(recoveryEvents * base.recoveryTokens, base.price.input);
    breakdown.input += recoveryCost;
  }

  for (let i = 1; i <= base.requests; i += 1) {
    const folded = foldAfterRequest !== null && i > foldAfterRequest;
    const promptTokens = folded
      ? base.foldedTokens + (i - foldAfterRequest) * base.deltaTokens
      : base.contextTokens + i * base.deltaTokens;
    promptTokensByRequest.push(promptTokens);
    breakdown.cacheRead += perMillion(promptTokens, base.price.cacheRead);
    breakdown.output += perMillion(base.outputTokensPerRequest, base.price.output);
  }

  const total = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  return {
    total,
    breakdown,
    promptTokensByRequest,
    foldAfterRequest,
    recoveryEvents,
    recoveryCost,
    premature: recoveryEvents > 0,
  };
}

/**
 * Compare "never fold" against every single-fold timing and report the optimum.
 * `savings` is positive when folding is cheaper.
 *
 * `cheapestFoldAfterRequest` is always reported — it is the theoretical best timing among folds,
 * even when never folding is cheaper still. `optimalFoldAfterRequest` stays null in that case
 * because the optimal policy is then "do not fold".
 * @returns {{ noFold: object, bestFold: object, optimalFoldAfterRequest: number|null, cheapestFoldAfterRequest: number, savings: number, foldIsCheaper: boolean, candidates: Array<{ foldAfterRequest: number, total: number, recoveryEvents: number, premature: boolean }> }}
 */
export function compareFoldPolicies(spec) {
  const base = normalizeSpec(spec);
  const noFold = computePolicyCost({ ...base, foldAfterRequest: null });

  const candidates = [];
  let bestFold = null;
  for (let k = 0; k <= base.requests; k += 1) {
    const candidate = computePolicyCost({ ...base, foldAfterRequest: k });
    candidates.push({
      foldAfterRequest: k,
      total: candidate.total,
      recoveryEvents: candidate.recoveryEvents,
      premature: candidate.premature,
    });
    if (!bestFold || candidate.total < bestFold.total) bestFold = candidate;
  }

  const savings = noFold.total - bestFold.total;
  const foldIsCheaper = savings > 0;
  return {
    noFold,
    bestFold,
    optimalFoldAfterRequest: foldIsCheaper ? bestFold.foldAfterRequest : null,
    cheapestFoldAfterRequest: bestFold.foldAfterRequest,
    savings,
    foldIsCheaper,
    candidates,
  };
}

/**
 * Score an observed run's fold timing against the theoretical optimum — the third dependent
 * variable of the evaluation: "was the fold well-timed?" expressed as a computable distance
 * rather than a judgement.
 *
 * `observedFoldAfterRequest` is null when the run never folded. Not folding is the correct answer
 * whenever the optimal policy is not to fold, so that case scores a deviation of 0.
 *
 * @param {object} spec normalizeSpec shape.
 * @param {number|null} observedFoldAfterRequest
 * @returns {{ deviation: number, observedFoldAfterRequest: number|null, optimalFoldAfterRequest: number|null, excessCost: number, observedTotal: number, optimalTotal: number, premature: boolean, verdict: "optimal"|"premature"|"late"|"missed"|"unnecessary" }}
 */
export function scoreFoldTiming(spec, observedFoldAfterRequest) {
  const base = normalizeSpec(spec);
  const verdictSpace = compareFoldPolicies(base);
  const optimal = verdictSpace.optimalFoldAfterRequest;
  const optimalTotal = verdictSpace.foldIsCheaper
    ? verdictSpace.bestFold.total
    : verdictSpace.noFold.total;

  if (observedFoldAfterRequest !== null) {
    assertRequestCount("observedFoldAfterRequest", observedFoldAfterRequest);
    if (observedFoldAfterRequest > base.requests) {
      throw new RangeError(
        `observedFoldAfterRequest (${observedFoldAfterRequest}) cannot exceed requests (${base.requests})`,
      );
    }
  }

  const observed =
    observedFoldAfterRequest === null
      ? verdictSpace.noFold
      : computePolicyCost({ ...base, foldAfterRequest: observedFoldAfterRequest });

  let verdict;
  if (observedFoldAfterRequest === null) {
    verdict = optimal === null ? "optimal" : "missed";
  } else if (optimal === null) {
    verdict = "unnecessary";
  } else if (observedFoldAfterRequest === optimal) {
    verdict = "optimal";
  } else {
    verdict = observedFoldAfterRequest < optimal ? "premature" : "late";
  }

  const deviation =
    observedFoldAfterRequest === null || optimal === null
      ? verdict === "optimal"
        ? 0
        : Math.abs((observedFoldAfterRequest ?? 0) - (optimal ?? 0)) || base.requests
      : Math.abs(observedFoldAfterRequest - optimal);

  return {
    deviation,
    observedFoldAfterRequest,
    optimalFoldAfterRequest: optimal,
    excessCost: observed.total - optimalTotal,
    observedTotal: observed.total,
    optimalTotal,
    premature: observed.premature,
    verdict,
  };
}

/**
 * Smallest follow-up request count at which folding beats never folding.
 * @returns {{ requests: number|null, savingsAtBreakEven: number|null, searchedUpTo: number }}
 */
export function findBreakEvenRequests(spec, { maxRequests = 500 } = {}) {
  assertRequestCount("maxRequests", maxRequests);
  for (let n = 1; n <= maxRequests; n += 1) {
    const verdict = compareFoldPolicies({ ...spec, requests: n });
    if (verdict.foldIsCheaper) {
      return { requests: n, savingsAtBreakEven: verdict.savings, searchedUpTo: maxRequests };
    }
  }
  return { requests: null, savingsAtBreakEven: null, searchedUpTo: maxRequests };
}

/**
 * Both cost curves over a list of request counts — the table a scenario author reads
 * to pick a length that actually reaches break-even.
 * @returns {Array<{ requests: number, noFold: number, bestFold: number, savings: number, optimalFoldAfterRequest: number|null }>}
 */
export function foldingCurve(spec, requestCounts) {
  if (!Array.isArray(requestCounts) || requestCounts.length === 0) {
    throw new TypeError("requestCounts must be a non-empty array of request counts");
  }
  return requestCounts.map((requests) => {
    assertRequestCount("requestCounts[]", requests);
    const verdict = compareFoldPolicies({ ...spec, requests });
    return {
      requests,
      noFold: verdict.noFold.total,
      bestFold: verdict.bestFold.total,
      savings: verdict.savings,
      optimalFoldAfterRequest: verdict.optimalFoldAfterRequest,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI: node eval/cost-model.mjs --context 200000 --requests 10,30,60 \
//        --delta 3000 --folded-ratio 0.15 \
//        --price-input 5 --price-output 30 --price-cache-read 0.5 --price-cache-write 6.25

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      out[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function cliMain(argv) {
  const args = parseArgs(argv);
  const contextTokens = Number(args.context ?? 200_000);
  const deltaTokens = Number(args.delta ?? 3_000);
  const foldedTokens =
    args.folded !== undefined
      ? Number(args.folded)
      : contextTokens * Number(args["folded-ratio"] ?? 0.15);
  const requestCounts = String(args.requests ?? "10,20,30,60")
    .split(",")
    .map((value) => Number(value.trim()));
  const price = {
    input: Number(args["price-input"] ?? 5),
    output: Number(args["price-output"] ?? 30),
    cacheRead: Number(args["price-cache-read"] ?? 0.5),
    cacheWrite: Number(args["price-cache-write"] ?? 6.25),
  };
  const settledAtRequest = Number(args.settled ?? 0);
  const recoveryTokens = Number(args.recovery ?? 0);
  const spec = {
    contextTokens,
    deltaTokens,
    foldedTokens,
    price,
    requests: 1,
    settledAtRequest,
    recoveryTokens,
  };

  const breakEven = findBreakEvenRequests(spec);
  const rows = foldingCurve(spec, requestCounts);

  console.log(
    `context=${contextTokens} delta=${deltaTokens}/req folded=${Math.round(foldedTokens)} ` +
      `settled=${settledAtRequest} recovery=${recoveryTokens} ` +
      `price(input/output/cacheRead/cacheWrite)=${price.input}/${price.output}/${price.cacheRead}/${price.cacheWrite} per M`,
  );
  console.log(
    breakEven.requests === null
      ? `break-even: none within ${breakEven.searchedUpTo} requests — folding never pays off at this shape`
      : `break-even: folding wins from request ${breakEven.requests} onward`,
  );
  console.log("requests  noFold($)   bestFold($)  savings($)  optimalFoldAfterRequest");
  for (const row of rows) {
    console.log(
      `${String(row.requests).padStart(8)}  ${row.noFold.toFixed(4).padStart(9)}  ` +
        `${row.bestFold.toFixed(4).padStart(11)}  ${row.savings.toFixed(4).padStart(10)}  ` +
        `${row.optimalFoldAfterRequest === null ? "never fold" : row.optimalFoldAfterRequest}`,
    );
  }
}

if (import.meta.main) {
  cliMain(process.argv.slice(2));
}
