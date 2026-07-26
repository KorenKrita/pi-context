import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareFoldPolicies, findBreakEvenRequests } from "../cost-model.mjs";
import {
  SCENARIO,
  SETTLES_AT_TURN,
  SETTLING_ARTIFACT,
  buildTurns,
  buildTurnsTruncated,
  phaseRanges,
} from "./scenario.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "ledger-drift");
const SOL = Object.freeze({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });

test("the script is 30 turns in four phases with settling at the documented turn", () => {
  const turns = buildTurns();
  expect(turns).toHaveLength(30);

  const ranges = phaseRanges();
  expect(ranges).toEqual({
    survey: { from: 1, to: 7 },
    settle: { from: 8, to: 8 },
    apply: { from: 9, to: 24 },
    regress: { from: 25, to: 30 },
  });
  expect(ranges.settle.from).toBe(SETTLES_AT_TURN);

  // Every prompt is a real instruction, and none of them leaks ACM vocabulary
  // into the task narrative.
  for (const turn of turns) {
    expect(turn.prompt.length).toBeGreaterThan(20);
    expect(turn.prompt).not.toMatch(/checkpoint|travel|timeline|fold|折叠|上下文管理/i);
  }
});

test("the settling turn is the one that puts the survey conclusions on disk", () => {
  const turns = buildTurns();
  const settle = turns[SETTLES_AT_TURN - 1];
  expect(settle.phase).toBe("settle");
  expect(settle.prompt).toContain(SETTLING_ARTIFACT);

  // Survey turns come strictly before it and never write the artifact, so the
  // settling point is observable rather than assumed.
  for (let i = 0; i < SETTLES_AT_TURN - 1; i += 1) {
    expect(turns[i].phase).toBe("survey");
    expect(turns[i].prompt).not.toContain(SETTLING_ARTIFACT);
  }
});

test("truncation at 20 turns and the full 30 straddle the folding break-even point", () => {
  // Prefix size the survey phase actually produces (logs are ~87K tokens of
  // real text), a fold retaining 15%, and settling at turn 8.
  const spec = {
    contextTokens: 80_000,
    deltaTokens: 3_000,
    foldedTokens: 12_000,
    price: SOL,
    settledAtRequest: SETTLES_AT_TURN,
    recoveryTokens: 60_000,
  };

  const breakEven = findBreakEvenRequests(spec);
  expect(breakEven.requests).toBeGreaterThan(20);
  expect(breakEven.requests).toBeLessThanOrEqual(30);

  // Left of the crossing: not folding is correct. Right of it: folding is,
  // and the optimum sits exactly on the settling turn.
  expect(compareFoldPolicies({ ...spec, requests: 20 }).optimalFoldAfterRequest).toBe(null);
  expect(compareFoldPolicies({ ...spec, requests: 30 }).optimalFoldAfterRequest).toBe(SETTLES_AT_TURN);
});

test("recoveryTokens changes the penalty for folding early but never the optimum", () => {
  // This is why the uncalibrated recovery size is safe: it only prices bad
  // timing. Scenario length and the optimal turn depend on settling alone.
  const base = {
    contextTokens: 80_000,
    deltaTokens: 3_000,
    foldedTokens: 12_000,
    price: SOL,
    settledAtRequest: SETTLES_AT_TURN,
    requests: 30,
  };
  const cheap = compareFoldPolicies({ ...base, recoveryTokens: 20_000 });
  const dear = compareFoldPolicies({ ...base, recoveryTokens: 200_000 });
  expect(cheap.optimalFoldAfterRequest).toBe(dear.optimalFoldAfterRequest);
  expect(cheap.savings).toBeCloseTo(dear.savings, 10);
});

test("truncation is bounded by the script length", () => {
  expect(buildTurnsTruncated(20)).toHaveLength(20);
  expect(buildTurnsTruncated(20)[19].phase).toBe("apply");
  expect(() => buildTurnsTruncated(31)).toThrow(RangeError);
  expect(() => buildTurnsTruncated(0)).toThrow(TypeError);
});

test("the fixture starts drifted and its outcome gate rejects that state", () => {
  const run = () => execFileSync("node", ["verify.mjs"], { cwd: FIXTURE, encoding: "utf8", stdio: "pipe" });
  expect(run).toThrow();
  expect(existsSync(join(FIXTURE, "verify.mjs"))).toBe(true);
  expect(SCENARIO.outcomeCommand).toEqual(["node", "verify.mjs"]);
});

test("the fixture is provably solvable, and the waiver is what makes it non-trivial", () => {
  const work = mkdtempSync(join(tmpdir(), "ledger-drift-solve-"));
  try {
    cpSync(FIXTURE, work, { recursive: true });
    const targets = JSON.parse(readFileSync(join(work, "ops/slo-targets.json"), "utf8"));

    const reconcile = (waivers) => {
      for (const [service, tier] of Object.entries(targets.assignments)) {
        const wanted = { ...targets.tiers[tier], ...(waivers[service] ?? {}) };
        const path = join(work, "src/services", `${service}.mjs`);
        const source = readFileSync(path, "utf8")
          .replace(/retryLimit: \d+/, `retryLimit: ${wanted.retryLimit}`)
          .replace(/timeoutMs: \d+/, `timeoutMs: ${wanted.timeoutMs}`)
          .replace(/poolSize: \d+/, `poolSize: ${wanted.poolSize}`);
        writeFileSync(path, source);
      }
    };
    const verify = () =>
      execFileSync("node", ["verify.mjs"], { cwd: work, encoding: "utf8", stdio: "pipe" });

    // Applying tier values blindly — the plausible answer for a run that lost
    // the incident report — fails on the waived service.
    reconcile({});
    expect(verify).toThrow(/search\.poolSize/);

    // Applying them with the approved waiver passes.
    reconcile({ search: { poolSize: 40 } });
    expect(verify()).toContain("12 services reconciled");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the waiver is only discoverable from survey-phase material", () => {
  // The regress phase asks a question whose correct answer lives in the
  // incident report and the search log, not in the service sources.
  const incident = readFileSync(join(FIXTURE, "ops/incidents/2026-05-17-search-pool.md"), "utf8");
  expect(incident).toContain("poolSize: 40");
  expect(readFileSync(join(FIXTURE, "ops/logs/search.log"), "utf8")).toContain("pool exhausted (15/15)");
  expect(readFileSync(join(FIXTURE, "src/services/search.mjs"), "utf8")).not.toContain("waiver");
});
