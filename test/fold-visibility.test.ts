import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildGaugeSuffix } from "../src/context-gauge.js";
import { selectFoldReferences, findNearestSavePoint, estimateFoldGains, type FoldEstimateEntry } from "../src/fold-estimate.js";
import type { LabelMaps } from "../src/lib.js";
import type { ContextUsagePressure } from "../src/context-pressure.js";

/**
 * Mechanism inventory for fold-gain visibility.
 *
 * These assertions exist because the original fold preview shipped until
 * 7c3bdff7 (2026-07-12) removed it — not by decision, but as collateral of a
 * single-file split whose commit body was empty. Nothing failed, so nobody
 * noticed for fifteen days while six guidance revisions tried to compensate
 * for a missing number with wording.
 *
 * A refactor that carries the fold needles away must now turn this file red.
 * Wording is deliberately asserted in the negative: needles report projections
 * and never advise, because the perception layer owns no judgment.
 */

function pressure(pressurePercent: number, usagePercent: number, policy: ContextUsagePressure["policy"]): ContextUsagePressure {
  return {
    tokens: 1000,
    contextWindow: 100_000,
    usagePercent,
    workingBudgetTokens: 100_000,
    pressurePercent,
    policy,
  };
}

const emptyLabels: LabelMaps = { entryToLabel: new Map(), labelToEntry: new Map() } as unknown as LabelMaps;

function labelsFor(pairs: ReadonlyArray<readonly [string, string]>): LabelMaps {
  return {
    entryToLabel: new Map(pairs),
    labelToEntry: new Map(pairs.map(([id, label]) => [label, id])),
  } as unknown as LabelMaps;
}

function userEntry(id: string): FoldEstimateEntry {
  return { id, type: "message", message: { role: "user" } };
}

function aiEntry(id: string): FoldEstimateEntry {
  return { id, type: "message", message: { role: "assistant" } };
}

describe("fold-gain visibility", () => {
  test("the gauge renders both fold needles alongside the pressure needles", () => {
    const suffix = buildGaugeSuffix(pressure(51.9, 20.4, "400k-cap"), { turnPercent: 22.8, taskPercent: 9.1 });
    expect(suffix).toBe("\n[ctx 51% budget · 20% window · fold@turn→22% · fold@task→9%]");
  });

  test("a missing reference point omits its needle instead of rendering zero", () => {
    expect(buildGaugeSuffix(pressure(51.9, 20.4, "400k-cap"), { turnPercent: 22.8, taskPercent: null }))
      .toBe("\n[ctx 51% budget · 20% window · fold@turn→22%]");
    expect(buildGaugeSuffix(pressure(51.9, 20.4, "400k-cap"), { turnPercent: null, taskPercent: null }))
      .toBe("\n[ctx 51% budget · 20% window]");
    expect(buildGaugeSuffix(pressure(51.9, 20.4, "400k-cap")))
      .toBe("\n[ctx 51% budget · 20% window]");
  });

  test("fold needles are unconditional: no threshold, floor, or tier gates them", () => {
    // A needle that appeared only past a threshold would be choosing its
    // moment, and a gauge that chooses its moments becomes an event again.
    const early = buildGaugeSuffix(pressure(2.4, 1.1, "400k-cap"), { turnPercent: 2.3, taskPercent: 0.4 });
    expect(early).toBe("\n[ctx 2% budget · 1% window · fold@turn→2% · fold@task→0%]");
  });

  test("fold needles carry no verb, evaluation, or recommendation", () => {
    const suffix = buildGaugeSuffix(pressure(80, 30, "400k-cap"), { turnPercent: 12, taskPercent: 4 });
    for (const advisory of ["fold now", "should", "consider", "recommend", "worth", "cheap", "expensive", "?"]) {
      expect(suffix.toLowerCase()).not.toContain(advisory);
    }
  });

  test("reference selection never requires a label", () => {
    // Label-gated preview stayed silent for sessions that never checkpointed —
    // exactly the sessions that needed it. Structural nodes must resolve.
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2"), aiEntry("a2")];
    const refs = selectFoldReferences(branch, emptyLabels);
    // u2 opened the current turn, so the turn reference is the boundary before
    // it: folding to u2 would discard only this turn's own opening.
    expect(refs.turn?.entryId).toBe("u1");
    expect(refs.turn?.label).toBeNull();
    // With two turns, both granularities resolve to the same boundary, so the
    // duplicate is dropped rather than rendered twice.
    expect(refs.task).toBeNull();
  });

  test("a labeled node wins over a bare structural node at the same granularity", () => {
    // A label inside the current turn is skipped with the rest of that turn;
    // a1 sits in the previous stretch, so its label wins there.
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2"), aiEntry("a2")];
    const refs = selectFoldReferences(branch, labelsFor([["a1", "phase-done"]]));
    expect(refs.turn?.label).toBe("phase-done");
    expect(refs.turn?.entryId).toBe("a1");
  });

  test("both granularities collapsing to one node reports a single reference", () => {
    // A single turn has no previous stretch: the turn needle has no reference
    // and is omitted, while task still resolves to the first boundary.
    const branch = [userEntry("u1"), aiEntry("a1")];
    const refs = selectFoldReferences(branch, emptyLabels);
    expect(refs.turn).toBeNull();
    expect(refs.task?.entryId).toBe("u1");
  });

test("the turn reference skips the current user turn", () => {
    // Value range, not precision: "fold the previous stretch" is only
    // expressible when the reference is the boundary that opened it. Pointing
    // at the current turn's own opening reports a near-zero saving at exactly
    // the position CORE names as already a candidate.
    const branch = [
      userEntry("u1"), aiEntry("a1"), aiEntry("a2"),
      userEntry("u2"), aiEntry("a3"),
    ];
    const refs = selectFoldReferences(branch, emptyLabels);
    expect(refs.turn?.entryId).toBe("u1");
    // Skipping is unconditional — no amount of work inside the current turn
    // moves the reference forward, because that would let a number choose it.
    const longer = [...branch, aiEntry("a4"), aiEntry("a5"), aiEntry("a6")];
    expect(selectFoldReferences(longer, emptyLabels).turn?.entryId).toBe("u1");
  });

  test("the entry a checkpoint just labeled is excluded from its own projection", () => {
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2")];
    const refs = selectFoldReferences(branch, labelsFor([["u2", "just-created"]]), "u2");
    expect(refs.turn?.entryId).not.toBe("u2");
    expect(refs.turn?.entryId).toBe("u1");
  });

  test("segment distance reports the nearest save point as a fact", () => {
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2"), aiEntry("a2")];
    expect(findNearestSavePoint(branch, labelsFor([["a1", "audit-start"]])))
      .toEqual({ name: "audit-start", stepsBack: 2 });
    expect(findNearestSavePoint(branch, emptyLabels))
      .toEqual({ name: null, stepsBack: null });
  });

  test("projections use the working budget the gauge reports, not the hard window", () => {
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2")];
    const refs = selectFoldReferences(branch, emptyLabels);
    const estimates = estimateFoldGains({
      usage: { tokens: 8000, contextWindow: 1_000_000, percent: 0.8 },
      workingBudgetTokens: 10_000,
      currentMessages: [],
      messagesAt: () => [],
    }, refs);
    // 8000 tokens against a 10K working budget is 80%, not 0.8% of the window.
    // The extra 4pp is the nominal handoff a fold appends, charged deliberately.
    expect(estimates.turnPercent).toBeCloseTo(84, 5);
  });

  test("a projection charges the handoff a fold would append", () => {
    // Ignoring it would promise a saving travel cannot deliver, and worst at
    // turn granularity where the handoff rivals the saving. estimateUsageAt-
    // TravelTarget charges it; the needles must charge the same.
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2")];
    const refs = selectFoldReferences(branch, emptyLabels);
    const inputs = {
      usage: { tokens: 8000, contextWindow: 1_000_000, percent: 0.8 },
      workingBudgetTokens: 10_000,
      currentMessages: [],
      messagesAt: () => [],
    };
    const charged = estimateFoldGains(inputs, refs).turnPercent!;
    // Strictly worse than the naive message-only projection, never better.
    expect(charged).toBeGreaterThan(80);
    const source = readFileSync(new URL("../src/fold-estimate.ts", import.meta.url), "utf8");
    expect(source).toContain("NOMINAL_HANDOFF_TOKENS");
  });

  test("an unavailable rebuild omits that needle rather than guessing", () => {
    const branch = [userEntry("u1"), aiEntry("a1"), userEntry("u2")];
    const refs = selectFoldReferences(branch, emptyLabels);
    const estimates = estimateFoldGains({
      usage: { tokens: 8000, contextWindow: 100_000, percent: 8 },
      workingBudgetTokens: 100_000,
      currentMessages: [],
      messagesAt: () => undefined,
    }, refs);
    expect(estimates.turnPercent).toBeNull();
    expect(estimates.taskPercent).toBeNull();
  });

  test("the checkpoint receipt and timeline HUD both stay wired to the needles", () => {
    // Source-level inventory: the two delivery surfaces a refactor is most
    // likely to drop, since neither has a behavioral test that fails silently.
    const checkpointSource = readFileSync(new URL("../src/checkpoint-tool.ts", import.meta.url), "utf8");
    expect(checkpointSource).toContain("selectFoldReferences");
    expect(checkpointSource).toContain("findNearestSavePoint");
    expect(checkpointSource).toContain("fold@turn");
    expect(checkpointSource).toContain("fold@task");
    expect(checkpointSource).toContain("Segment:");

    const timelineSource = readFileSync(new URL("../src/timeline-tool.ts", import.meta.url), "utf8");
    expect(timelineSource).toContain("selectFoldReferences");
    expect(timelineSource).toContain("Fold Projection");

    const lifecycleSource = readFileSync(new URL("../src/runtime-lifecycle.ts", import.meta.url), "utf8");
    expect(lifecycleSource).toContain("currentFoldEstimates");
    expect(lifecycleSource).toContain("buildGaugeSuffix(pressure, folds)");
  });

  test("CORE explains every needle the gauge can render", () => {
    // A number the model cannot read is noise. CORE owns the reading key.
    const core = readFileSync(new URL("../skills/context-management/CORE.md", import.meta.url), "utf8");
    for (const needle of ["% budget", "% window", "fold@turn", "fold@task"]) {
      expect(core).toContain(needle);
    }
  });

  test("a fold whose whole replacement range is ACM bookkeeping is refused structurally", () => {
    // FM-15: checkpoint, then travel to it. The label journal entry the
    // checkpoint just appended is the only thing between target and leaf, so
    // the fold compresses nothing the model produced. Rejection reads the entry
    // kinds, never the projected numbers — projections measure, boundaries
    // decide, and a numeric threshold here would let the number decide.
    const source = readFileSync(new URL("../src/travel-tool.ts", import.meta.url), "utf8");
    expect(source).toContain("isAcmBookkeepingEntry");
    expect(source).toContain("zero_distance_travel");
    expect(source).toContain("foldsOnlyBookkeeping");
    // Off-path restore and rehydrate legitimately replace nothing, so the
    // guard must exempt them or it breaks recovery round trips.
    expect(source).toContain("!resolved.fromOffPath");
    // The guard must not compare against a usage or percentage threshold.
    const guardBlock = source.slice(source.indexOf("const replacedEntryCount"), source.indexOf("zero_distance_travel"));
    for (const numeric of ["pressurePercent", "usagePercent", "estimated", "workingBudget"]) {
      expect(guardBlock).not.toContain(numeric);
    }
  });

  test("FM-15 is registered with its structural boundary", () => {
    const fm = readFileSync(new URL("../docs/acm-failure-mechanisms.md", import.meta.url), "utf8");
    expect(fm).toContain("## FM-15");
    expect(fm).toContain("Preview measures; boundary decides");
    expect(fm).toContain("7c3bdff7");
  });
});
