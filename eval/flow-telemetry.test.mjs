import { describe, expect, test } from "bun:test";

import {
  activeTokensFromUsage,
  classifyFlowEvidence,
  collectFlowTelemetry,
  compareContextArms,
  workingBudgetFor,
} from "./flow-telemetry.mjs";

function assistantUsage(tokens) {
  return { type: "message_end", message: { role: "assistant", usage: { input: tokens, cacheRead: 0, output: 1, totalTokens: tokens + 1 }, stopReason: "stop" } };
}

function settled() {
  return { type: "agent_settled" };
}

function travel({ status = "applied", open = false } = {}) {
  return {
    type: "tool_execution_end",
    toolCallId: "travel-1",
    toolName: "acm_travel",
    isError: status === "not_applied",
    result: {
      isError: status === "not_applied",
      details: {
        mutationStatus: status,
        activeSummaryDepthBefore: 0,
        activeSummaryDepthAfter: status === "applied" ? 1 : 0,
        currentUserTurnOpen: open,
      },
    },
  };
}

function report(overrides = {}) {
  return {
    status: "completed",
    turns: [{ phase: "P1" }, { phase: "P2" }],
    judge: { verdict: { dimensions: { task_completion: { score: 3 } } } },
    ...overrides,
  };
}

describe("flow telemetry", () => {
  test("treats an explicit zero-input prompt as zero rather than falling back to output-inclusive totals", () => {
    expect(activeTokensFromUsage({ input: 0, cacheRead: 0, totalTokens: 17 })).toBe(0);
    expect(activeTokensFromUsage({ totalTokens: 17 })).toBe(17);
  });

  test("keeps working-budget pressure equal while hard-window usage differs", () => {
    const events = [assistantUsage(120_000), settled()];
    const constrained = collectFlowTelemetry({ events, report: report({ turns: [{ phase: "P1" }] }), contextWindow: 400_000 });
    const native = collectFlowTelemetry({ events, report: report({ turns: [{ phase: "P1" }] }), contextWindow: 1_000_000 });

    expect(workingBudgetFor(1_000_000)).toBe(400_000);
    expect(constrained.peak.pressurePercent).toBe(30);
    expect(native.peak.pressurePercent).toBe(30);
    expect(constrained.peak.hardUsagePercent).toBe(30);
    expect(native.peak.hardUsagePercent).toBe(12);
    expect(native.crossings.map((crossing) => crossing.level)).toEqual([30]);
  });

  test("records all three threshold crossings and reminder evidence in a cycle", () => {
    const events = [
      assistantUsage(125_000),
      { type: "custom_message", customType: "acm:context-usage-reminder", details: { kind: "context-usage-reminder", level: 30 } },
      assistantUsage(205_000),
      { type: "custom_message", customType: "acm:context-usage-reminder", details: { kind: "context-usage-reminder", level: 50 } },
      assistantUsage(285_000),
      { type: "custom_message", customType: "acm:context-usage-reminder", details: { kind: "context-usage-reminder", level: 70 } },
      settled(),
    ];
    const telemetry = collectFlowTelemetry({ events, report: report({ turns: [{ phase: "P1" }] }), contextWindow: 400_000 });

    expect(telemetry.coverage.crossedLevels).toEqual([30, 50, 70]);
    expect(telemetry.coverage.reminderLevels).toEqual([30, 50, 70]);
    expect(telemetry.cycles).toHaveLength(1);
    expect(classifyFlowEvidence({ report: report({ turns: [{ phase: "P1" }] }), telemetry }).classification).toBe("certifying_run");
  });

  test("counts one completed reminder across Pi message lifecycle events", () => {
    const message = {
      role: "custom",
      customType: "acm:context-usage-reminder",
      details: { kind: "context-usage-reminder", level: 70, tokens: 285_000 },
    };
    const telemetry = collectFlowTelemetry({
      events: [
        { type: "message_start", message },
        { type: "message_end", message },
        settled(),
      ],
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
    });

    expect(telemetry.reminders).toHaveLength(1);
    expect(telemetry.reminders[0]).toMatchObject({ level: 70, eventIndex: 1, cycle: 0 });
  });

  test("uses completed reminder details as pressure evidence when RPC events omit usage", () => {
    const message = {
      role: "custom",
      customType: "acm:context-usage-reminder",
      details: {
        kind: "context-usage-reminder",
        level: 70,
        tokens: 310_000,
        usagePercent: 77.5,
        pressurePercent: 77.5,
        workingBudgetTokens: 400_000,
      },
    };
    const telemetry = collectFlowTelemetry({
      events: [assistantUsage(250_000), { type: "message_end", message }, settled()],
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
    });

    expect(telemetry.peak).toEqual({ activeTokens: 310_000, hardUsagePercent: 77.5, pressurePercent: 77.5 });
    expect(telemetry.coverage.crossedLevels).toEqual([30, 50, 70]);
    expect(telemetry.coverage.reminderLevels).toEqual([70]);
  });

  test("starts a fresh cycle after a successful real Pi compaction and captures pre/post usage", () => {
    const events = [
      assistantUsage(220_000),
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", result: { summary: "compacted" }, aborted: false, willRetry: false },
      { type: "message_start", message: { role: "assistant", usage: { input: 0, cacheRead: 0, output: 0, totalTokens: 0 } } },
      assistantUsage(40_000),
      settled(),
    ];
    const telemetry = collectFlowTelemetry({ events, report: report({ turns: [{ phase: "P1" }] }), contextWindow: 400_000 });

    expect(telemetry.cycles).toHaveLength(2);
    expect(telemetry.boundaries).toMatchObject([{
      kind: "compaction",
      preTokens: 220_000,
      postTokens: 40_000,
    }]);
    expect(telemetry.coverage.compactionBoundaryObserved).toBe(true);
  });

  test("uses the first completed post-travel prompt instead of the originating stale turn_end", () => {
    const events = [
      assistantUsage(220_000),
      travel({ status: "applied", open: true }),
      { type: "turn_end", usage: { input: 220_000, cacheRead: 0, output: 1, totalTokens: 220_001 } },
      assistantUsage(45_000),
      settled(),
    ];
    const telemetry = collectFlowTelemetry({
      events,
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
    });

    expect(telemetry.boundaries).toMatchObject([{
      kind: "successful_travel",
      preTokens: 220_000,
      postTokens: 45_000,
    }]);
  });

  test("does not start a fresh cycle for an aborted or retrying compaction", () => {
    for (const event of [
      { type: "compaction_end", result: { summary: "discarded" }, aborted: true, willRetry: false },
      { type: "compaction_end", result: { summary: "discarded" }, aborted: false, willRetry: true },
      { type: "compaction_end", result: null, aborted: false, willRetry: false },
      { type: "compaction_end", result: { summary: "" }, aborted: false, willRetry: false },
    ]) {
      const telemetry = collectFlowTelemetry({
        events: [assistantUsage(220_000), event, assistantUsage(40_000), settled()],
        report: report({ turns: [{ phase: "P1" }] }),
        contextWindow: 400_000,
      });
      expect(telemetry.cycles).toHaveLength(1);
      expect(telemetry.coverage.compactionBoundaryObserved).toBe(false);
    }
  });

  test("does not reset cycle or claim summary growth for a failed travel", () => {
    const events = [assistantUsage(220_000), travel({ status: "not_applied", open: true }), assistantUsage(230_000), settled()];
    const telemetry = collectFlowTelemetry({ events, report: report({ turns: [{ phase: "P1" }] }), contextWindow: 400_000 });

    expect(telemetry.cycles).toHaveLength(1);
    expect(telemetry.acm.successfulTravelCount).toBe(0);
    expect(telemetry.acm.failedTravelCount).toBe(1);
    expect(telemetry.currentUserTurnOpenReceipts).toHaveLength(1);
  });

  test("treats non-empty string and object domain errors as failed travel", () => {
    for (const domainError of ["target rejected", { code: "invalid_target" }]) {
      const event = travel({ status: "applied" });
      event.result.details.error = domainError;
      const telemetry = collectFlowTelemetry({
        events: [assistantUsage(220_000), event, settled()],
        report: report({ turns: [{ phase: "P1" }] }),
        contextWindow: 400_000,
      });
      expect(telemetry.acm.successfulTravelCount).toBe(0);
      expect(telemetry.acm.failedTravelCount).toBe(1);
      expect(telemetry.cycles).toHaveLength(1);
    }
  });

  test("marks mid-run model or effort drift as infrastructure-invalid integrity", () => {
    const telemetry = collectFlowTelemetry({
      events: [
        { type: "model_select", provider: "local-responses", modelId: "gpt-5.6-sol" },
        { type: "thinking_level_select", thinkingLevel: "medium" },
        { type: "thinking_level_change", thinkingLevel: "high" },
        { type: "message_end", message: { role: "assistant", provider: "local-responses", model: "gpt-5.6-terra", usage: { input: 130_000 }, stopReason: "stop" } },
        settled(),
      ],
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
      target: { provider: "local-responses", modelId: "gpt-5.6-sol", thinking: "medium" },
    });
    expect(telemetry.integrity.model.pass).toBe(false);
    expect(telemetry.integrity.model.mismatches.flatMap((item) => item.mismatches)).toEqual(expect.arrayContaining([
      "thinking:high",
      "model:gpt-5.6-terra",
    ]));
    expect(classifyFlowEvidence({ report: report({ turns: [{ phase: "P1" }] }), telemetry }).classification).toBe("infrastructure_invalid");
  });

  test("separates provider failure, infrastructure failure, task failure, and occupancy miss", () => {
    const lowOccupancy = collectFlowTelemetry({ events: [assistantUsage(20_000), settled()], report: report({ turns: [{ phase: "P1" }] }), contextWindow: 400_000 });
    expect(classifyFlowEvidence({ report: report({ runError: "provider timeout", status: "run_error" }), telemetry: lowOccupancy }).classification).toBe("run_error");
    expect(classifyFlowEvidence({ report: report({ infrastructureInvalid: { status: "missing" }, status: "infrastructure_invalid" }), telemetry: lowOccupancy }).classification).toBe("infrastructure_invalid");
    expect(classifyFlowEvidence({ report: report({ judge: { verdict: { dimensions: { task_completion: { score: 1 } } } } }), telemetry: lowOccupancy }).classification).toBe("task_failure");
    expect(classifyFlowEvidence({ report: report({ status: "verification_failed", deterministicVerification: { passed: false } }), telemetry: lowOccupancy }).classification).toBe("task_failure");
    expect(classifyFlowEvidence({ report: report({ turns: [{ phase: "P1" }] }), telemetry: lowOccupancy }).classification).toBe("occupancy_miss");
  });

  test("flags session-recall registration or invocation as infrastructure invalid", () => {
    const telemetry = collectFlowTelemetry({
      events: [
        assistantUsage(300_000),
        { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "session_query", id: "attempted-before-host-rejection" }] } },
        settled(),
      ],
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
      integrity: { sessionRecallPackagePresent: false },
    });
    expect(telemetry.integrity.forbiddenObserved).toEqual(["session_query"]);
    expect(classifyFlowEvidence({ report: report({ turns: [{ phase: "P1" }] }), telemetry }).classification).toBe("infrastructure_invalid");
  });

  test("makes a pair card descriptive rather than causal", () => {
    const telemetry = collectFlowTelemetry({
      events: [assistantUsage(285_000), settled()],
      report: report({ turns: [{ phase: "P1" }] }),
      contextWindow: 400_000,
    });
    const provenance = {
      promptHashes: [{ phase: "P1", sha256: "same" }],
      fixtureVersion: "v1",
      fixtureSha256: "fixture",
      oracleSha256: "oracle",
    };
    const card = compareContextArms({
      pairKey: "sol-medium",
      constrained400k: { classification: "coverage_insufficient", maxTokensCap: 16_000, telemetry, report: report(), provenance },
      native1m: { classification: "coverage_insufficient", maxTokensCap: 16_000, telemetry: { ...telemetry, peak: { ...telemetry.peak, hardUsagePercent: 28.5 } }, report: report(), provenance: structuredClone(provenance) },
    });
    expect(card.constrained400k.maxTokensCap).toBe(16_000);
    expect(card.comparable).toBe(true);
    expect(card.interpretation).toContain("does not establish");

    const mismatch = compareContextArms({
      pairKey: "sol-medium",
      constrained400k: { provenance },
      native1m: { provenance: { ...provenance, fixtureSha256: "different" } },
    });
    expect(mismatch.comparable).toBe(false);
    expect(mismatch.mismatchReasons).toContain("fixture_hash_mismatch");
  });
});
