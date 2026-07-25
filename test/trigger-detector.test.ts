import { describe, expect, test } from "bun:test";
import {
  areTriggersDisabled,
  markBurstCued,
  buildBurstCueSuffix,
  buildGaugeSuffix,
  buildRunBoundaryCue,
  createTriggerRunState,
  describeDistanceToNextTier,
  findNearestSavePoint,
  GAUGE_DELTA_PP,
  markBoundaryCued,
  markGaugeEmitted,
  READ_BURST_THRESHOLD,
  recordToolCompletion,
  resetRunCounters,
  shouldCueRunBoundary,
  shouldEmitGauge,
} from "../src/acm-trigger-detector";
import { calculateContextUsagePressure } from "../src/context-usage-nudge";
import { buildLabelMaps } from "../src/label-journal";
import { AcmSessionRuntime } from "../src/runtime";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

describe("read burst detection", () => {
  test("stays armed until delivery is confirmed, then never fires again in the run", () => {
    const state = createTriggerRunState();
    for (let call = 1; call < READ_BURST_THRESHOLD; call++) {
      expect(recordToolCompletion(state, "read")).toEqual({ kind: "none" });
    }
    expect(recordToolCompletion(state, "grep")).toEqual({ kind: "burst", burstLength: READ_BURST_THRESHOLD });
    // Undelivered (e.g. error result, tier arbitration): the cue re-fires on
    // the next read completion instead of being silently consumed.
    expect(recordToolCompletion(state, "read")).toEqual({ kind: "burst", burstLength: READ_BURST_THRESHOLD + 1 });
    // Confirmed delivery disarms for the rest of the run.
    markBurstCued(state);
    for (let call = 0; call < READ_BURST_THRESHOLD * 2; call++) {
      expect(recordToolCompletion(state, "find")).toEqual({ kind: "none" });
    }
  });

  test("a non-read tool breaks the streak; a new run rearms the cue", () => {
    const state = createTriggerRunState();
    for (let call = 0; call < READ_BURST_THRESHOLD - 1; call++) recordToolCompletion(state, "read");
    expect(recordToolCompletion(state, "bash")).toEqual({ kind: "none" });
    expect(state.readBurstLength).toBe(0);
    // Streak restarts after the break.
    for (let call = 1; call < READ_BURST_THRESHOLD; call++) {
      expect(recordToolCompletion(state, "read")).toEqual({ kind: "none" });
    }
    expect(recordToolCompletion(state, "read").kind).toBe("burst");
    // New run: counters reset, cue rearmed.
    resetRunCounters(state);
    for (let call = 1; call < READ_BURST_THRESHOLD; call++) recordToolCompletion(state, "read");
    expect(recordToolCompletion(state, "read").kind).toBe("burst");
  });

  test("ACM tools break the streak, count run activity, and never trigger", () => {
    const state = createTriggerRunState();
    for (let call = 0; call < READ_BURST_THRESHOLD - 1; call++) recordToolCompletion(state, "read");
    expect(recordToolCompletion(state, "acm_timeline")).toEqual({ kind: "none" });
    expect(state.readBurstLength).toBe(0);
    expect(state.runToolCount).toBe(READ_BURST_THRESHOLD);
  });
});

describe("gauge cadence", () => {
  test("silent below the 30% floor and within the delta band", () => {
    const state = createTriggerRunState();
    expect(shouldEmitGauge(state, 29.9)).toBe(false);
    expect(shouldEmitGauge(state, 30 + GAUGE_DELTA_PP - 0.1)).toBe(false);
    expect(shouldEmitGauge(state, 30 + GAUGE_DELTA_PP)).toBe(true);
  });

  test("each emission moves the baseline; the next needs a full delta again", () => {
    const state = createTriggerRunState();
    expect(markGaugeEmitted(state, 41)).toBe(11);
    expect(shouldEmitGauge(state, 45)).toBe(false);
    expect(shouldEmitGauge(state, 41 + GAUGE_DELTA_PP)).toBe(true);
  });

  test("run boundaries keep the gauge baseline (cycle-scoped, not run-scoped)", () => {
    const state = createTriggerRunState();
    markGaugeEmitted(state, 45);
    resetRunCounters(state);
    expect(state.lastGaugePercent).toBe(45);
  });

  test("suffix carries pressure, delta, and distance to the next tier", () => {
    const pressure = calculateContextUsagePressure(164_000, 400_000)!;
    const suffix = buildGaugeSuffix(pressure, 11);
    expect(suffix).toBe("\n[ctx: 41.0% · ↑11pp · 50% tier in 9pp]");
  });

  test("distance disappears above the final tier", () => {
    expect(describeDistanceToNextTier(72)).toBeNull();
    expect(describeDistanceToNextTier(55)).toBe("70% tier in 15pp");
  });
});

describe("run-boundary cue", () => {
  test("requires threshold activity and no save point, then disarms for the cycle", () => {
    const state = createTriggerRunState();
    for (let call = 0; call < 8; call++) recordToolCompletion(state, "bash");
    expect(shouldCueRunBoundary(state)).toBe(true);
    markBoundaryCued(state);
    resetRunCounters(state);
    // Same accumulation again: still disarmed — a reminder is not a snooze alarm.
    for (let call = 0; call < 20; call++) recordToolCompletion(state, "bash");
    expect(shouldCueRunBoundary(state)).toBe(false);
  });

  test("a real save-point action rearms the disarmed cue", () => {
    const state = createTriggerRunState();
    for (let call = 0; call < 8; call++) recordToolCompletion(state, "bash");
    markBoundaryCued(state);
    resetRunCounters(state);
    recordToolCompletion(state, "acm_checkpoint");
    expect(state.boundaryCueDisarmed).toBe(false);
    // The run that created the save point never cues (work is protected).
    for (let call = 0; call < 10; call++) recordToolCompletion(state, "bash");
    expect(shouldCueRunBoundary(state)).toBe(false);
    // The next run with unprotected work cues again.
    resetRunCounters(state);
    for (let call = 0; call < 8; call++) recordToolCompletion(state, "bash");
    expect(shouldCueRunBoundary(state)).toBe(true);
  });

  test("cue text is a judgment question, not a command", () => {
    const state = createTriggerRunState();
    for (let call = 0; call < 9; call++) recordToolCompletion(state, "bash");
    const text = buildRunBoundaryCue("new_request", state);
    expect(text).toContain("9 tool calls, no save point this run");
    expect(text).toContain("automated ACM notice, not a user request");
    expect(text).toContain("continue directly");
  });
});

describe("nearest save point fact", () => {
  function entry(id: string): SessionEntry {
    return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: "x", timestamp: 0 } } as SessionEntry;
  }
  function label(id: string, targetId: string, name: string): SessionEntry {
    return { type: "label", id, parentId: null, timestamp: "", targetId, label: name } as SessionEntry;
  }

  test("reports the closest labeled entry walking tip-first", () => {
    const branch = [entry("a"), entry("b"), entry("c")];
    const maps = buildLabelMaps([...branch, label("l1", "a", "old"), label("l2", "b", "recent")]);
    expect(findNearestSavePoint(branch, maps)).toEqual({ name: "recent", stepsBack: 1 });
  });

  test("reports absence honestly", () => {
    const branch = [entry("a"), entry("b")];
    expect(findNearestSavePoint(branch, buildLabelMaps([]))).toEqual({ name: null, stepsBack: null });
  });

  test("burst cue degrades gracefully without a save point", () => {
    expect(buildBurstCueSuffix({ burstLength: 9, nearestCheckpointName: null, stepsSinceCheckpoint: null }))
      .toContain("no save point on this spine");
    expect(buildBurstCueSuffix({ burstLength: 9, nearestCheckpointName: "scan-done", stepsSinceCheckpoint: 4 }))
      .toContain("nearest save point 'scan-done' 4 step(s) back");
  });
});

describe("ACM_TRIGGERS_DISABLED kill switch", () => {
  test("reads the environment at call time", () => {
    expect(areTriggersDisabled({})).toBe(false);
    expect(areTriggersDisabled({ ACM_TRIGGERS_DISABLED: "0" })).toBe(false);
    expect(areTriggersDisabled({ ACM_TRIGGERS_DISABLED: "" })).toBe(false);
    expect(areTriggersDisabled({ ACM_TRIGGERS_DISABLED: "1" })).toBe(true);
  });

  test("silences all three runtime trigger surfaces without touching tier reminders", async () => {
    process.env["ACM_TRIGGERS_DISABLED"] = "1";
    try {
      const runtime = new AcmSessionRuntime();
      const session = {};
      // burst: 10 reads would normally cross READ_BURST_THRESHOLD=8
      for (let i = 0; i < 10; i++) {
        expect(runtime.recordTriggerToolCompletion(session, "read")).toEqual({ kind: "none" });
      }
      // gauge: far above floor + delta
      expect(runtime.peekGaugeEmission(session, 55)).toBeUndefined();
      // boundary: no state accumulated, and even direct probing yields nothing
      expect(runtime.takeRunBoundaryCue(session)).toBeUndefined();
    } finally {
      delete process.env["ACM_TRIGGERS_DISABLED"];
    }
  });

  test("re-enables cleanly when the variable is cleared", () => {
    const runtime = new AcmSessionRuntime();
    const session = {};
    for (let i = 0; i < 7; i++) runtime.recordTriggerToolCompletion(session, "read");
    expect(runtime.recordTriggerToolCompletion(session, "read")).toMatchObject({ kind: "burst", burstLength: 8 });
  });
});
