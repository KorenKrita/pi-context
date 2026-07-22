import { describe, expect, test } from "bun:test";
import {
  JUDGE_DIMENSIONS,
  RUBRIC_VERSION,
  judgeTranscript,
  parseVerdict,
  validateVerdict,
  validatePersistedVerdict,
} from "./judge.mjs";

function validVerdict() {
  return {
    rubricVersion: RUBRIC_VERSION,
    perPhase: [{
      phase: "P1-baseline",
      opportunityTaken: true,
      action: "Created a useful save point.",
      quality: 3,
      note: "The save point remains recoverable.",
    }],
    dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => [dimension, {
      score: 3,
      attribution: "healthy",
      note: `${dimension} is supported by the transcript.`,
    }])),
    overall: { score: 3, modelTier: "strong", summary: "The run preserved task continuity." },
    topAttributions: ["healthy"],
  };
}

function fenced(verdict) {
  return `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
}

function assistantEvents(text) {
  return [{
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }];
}

describe("judge verdict schema", () => {
  test("accepts the complete, exact rubric-v3 verdict shape", () => {
    expect(validateVerdict(validVerdict())).toEqual({ ok: true });
  });

  test("requires the exact current rubric from producers and a plain-object schema", () => {
    const historical = validVerdict();
    historical.rubricVersion = "acm-activation-v2";
    const currentResult = validateVerdict(historical);
    expect(currentResult).toEqual({
      ok: false,
      errors: ['$.rubricVersion: expected exactly "acm-outcome-v3"'],
      error: '$.rubricVersion: expected exactly "acm-outcome-v3"',
    });
    const wrongShape = validVerdict();
    wrongShape.extra = true;
    const result = validateVerdict(wrongShape);
    expect(result).toMatchObject({ ok: false });
    expect(result.errors).toContain("$.extra: unexpected key");
    expect(validateVerdict([])).toEqual({
      ok: false,
      errors: ["$: expected a plain object"],
      error: "$: expected a plain object",
    });
  });

  test("accepts v1, v2, and v3 persisted artifacts through their known structural schema", () => {
    for (const rubricVersion of ["acm-activation-v1", "acm-activation-v2", "acm-outcome-v3"]) {
      const verdict = validVerdict();
      verdict.rubricVersion = rubricVersion;
      expect(validatePersistedVerdict(verdict)).toEqual({ ok: true });
    }
  });

  test("rejects an overall score of 9 and a fractional score of 2.9 without coercion", () => {
    const nine = validVerdict();
    nine.overall.score = 9;
    const fractional = validVerdict();
    fractional.dimensions.activation.score = 2.9;

    const nineResult = parseVerdict(fenced(nine));
    const fractionalResult = parseVerdict(fenced(fractional));
    expect(nineResult).toMatchObject({ ok: false });
    expect(nineResult.errors).toContain("$.overall.score: expected an integer from 0 through 3");
    expect(fractionalResult).toMatchObject({ ok: false });
    expect(fractionalResult.errors).toContain("$.dimensions.activation.score: expected an integer from 0 through 3");
  });

  test("rejects bad phase types, dimension shape, enums, and required-key omissions with field paths", () => {
    const verdict = validVerdict();
    verdict.perPhase[0].opportunityTaken = "yes";
    verdict.perPhase[0].quality = 2.9;
    delete verdict.dimensions.ceiling;
    verdict.dimensions.activation.attribution = "looks-good";
    verdict.overall.modelTier = "excellent";
    verdict.topAttributions = ["healthy", "healthy", "not-a-tag"];
    delete verdict.overall.summary;

    const result = validateVerdict(verdict);
    expect(result).toMatchObject({ ok: false });
    expect(result.errors).toEqual(expect.arrayContaining([
      "$.perPhase[0].opportunityTaken: expected a boolean",
      "$.perPhase[0].quality: expected an integer from 0 through 3",
      "$.dimensions.ceiling: missing required key",
      "$.dimensions.activation.attribution: expected one of healthy, never-activated, event-driven-overfold, negation-suppressed-inaction, bad-handoff, lost-recoverability, anchor-gravity-wrong-target, thrash, task-degraded",
      "$.overall.modelTier: expected one of weak, mid, strong",
      "$.overall.summary: missing required key",
      "$.topAttributions[1]: duplicate attribution",
      "$.topAttributions[2]: expected one of healthy, never-activated, event-driven-overfold, negation-suppressed-inaction, bad-handoff, lost-recoverability, anchor-gravity-wrong-target, thrash, task-degraded",
    ]));
  });

  test("requires a non-empty, unique, ordered phase record for every supplied opportunity", () => {
    const expectedPhases = ["P1-baseline", "P2-verify"];
    const withPhases = (phases) => {
      const verdict = validVerdict();
      verdict.perPhase = phases.map((phase) => ({
        ...validVerdict().perPhase[0],
        phase,
      }));
      return verdict;
    };

    const empty = validateVerdict(withPhases([]), { expectedPhases });
    expect(empty.errors).toEqual(expect.arrayContaining([
      "$.perPhase: expected at least one phase record",
      "$.perPhase: expected 2 phase records, received 0",
    ]));
    const missing = validateVerdict(withPhases(["P1-baseline"]), { expectedPhases });
    expect(missing.errors).toContain("$.perPhase: expected 2 phase records, received 1");
    const duplicate = validateVerdict(withPhases(["P1-baseline", "P1-baseline"]), { expectedPhases });
    expect(duplicate.errors).toEqual(expect.arrayContaining([
      '$.perPhase[1].phase: duplicate phase "P1-baseline"',
      '$.perPhase[1].phase: expected exactly "P2-verify", received "P1-baseline"',
    ]));
    const unknown = validateVerdict(withPhases(["P1-baseline", "P3-unknown"]), { expectedPhases });
    expect(unknown.errors).toContain('$.perPhase[1].phase: expected exactly "P2-verify", received "P3-unknown"');
    const outOfOrder = validateVerdict(withPhases(["P2-verify", "P1-baseline"]), { expectedPhases });
    expect(outOfOrder.errors).toEqual(expect.arrayContaining([
      '$.perPhase[0].phase: expected exactly "P1-baseline", received "P2-verify"',
      '$.perPhase[1].phase: expected exactly "P2-verify", received "P1-baseline"',
    ]));
  });

  test("uses the last candidate that both parses and validates", () => {
    const first = validVerdict();
    first.overall.summary = "first valid candidate";
    const invalid = validVerdict();
    invalid.overall.score = 9;
    const last = validVerdict();
    last.overall.summary = "last valid candidate";

    const parsed = parseVerdict(`${fenced(first)}\n${fenced(invalid)}\n${fenced(last)}`);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.verdict.overall.summary).toBe("last valid candidate");
  });

  test("falls back to an earlier valid candidate when the final candidate is invalid", () => {
    const valid = validVerdict();
    valid.overall.summary = "only valid candidate";
    const invalid = validVerdict();
    invalid.overall.score = 9;

    const parsed = parseVerdict(`${fenced(valid)}\n${fenced(invalid)}`);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.verdict.overall.summary).toBe("only valid candidate");
  });

  test("applies expected phases through the generic parser options", () => {
    const parsed = parseVerdict(fenced(validVerdict()), { expectedPhases: ["P2-other"] });
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.errors).toContain('$.perPhase[0].phase: expected exactly "P2-other", received "P1-baseline"');
  });
});

describe("judge repair execution", () => {
  test("repairs one invalid reply in the same judge session without resending the transcript", async () => {
    const invalid = validVerdict();
    invalid.overall.score = 9;
    const prompts = [];
    const driver = {
      starts: 0,
      stops: 0,
      start() { this.starts++; },
      async prompt(prompt) {
        prompts.push(prompt);
        return assistantEvents(prompts.length === 1 ? fenced(invalid) : fenced(validVerdict()));
      },
      async stop() { this.stops++; },
    };
    let factories = 0;
    const result = await judgeTranscript({
      transcript: "UNIQUE TRANSCRIPT CONTENT",
      opportunities: [{ phase: "P1-baseline", intent: "finish the change" }],
      taskCompletionDesc: "The implementation remains correct.",
      judgeAgentDir: "/agent",
      sessionDir: "/sessions",
      cwd: "/workspace",
      driverFactory() { factories++; return driver; },
    });

    expect(result).toMatchObject({ ok: true, rubricVersion: RUBRIC_VERSION });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, kind: "initial", ok: false });
    expect(result.attempts[0].errors).toContain("$.overall.score: expected an integer from 0 through 3");
    expect(result.attempts[1]).toMatchObject({ attempt: 2, kind: "repair", ok: true });
    expect(factories).toBe(1);
    expect(driver.starts).toBe(1);
    expect(driver.stops).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("UNIQUE TRANSCRIPT CONTENT");
    expect(prompts[1]).not.toContain("UNIQUE TRANSCRIPT CONTENT");
    expect(prompts[1]).toContain("$.overall.score: expected an integer from 0 through 3");
    expect(prompts[1]).toContain("0、1、2、3");
  });

  test("bounds invalid judge output to the initial reply plus one repair", async () => {
    const invalid = validVerdict();
    invalid.overall.score = 9;
    const prompts = [];
    const driver = {
      start() {},
      async prompt(prompt) {
        prompts.push(prompt);
        return assistantEvents(fenced(invalid));
      },
      async stop() {},
    };

    const result = await judgeTranscript({
      transcript: "bounded transcript",
      opportunities: [],
      judgeAgentDir: "/agent",
      sessionDir: "/sessions",
      cwd: "/workspace",
      driverFactory() { return driver; },
    });

    expect(result).toMatchObject({ ok: false, rubricVersion: RUBRIC_VERSION });
    expect(result.error).toContain("judge invalid after 2 attempts");
    expect(result.attempts).toHaveLength(2);
    expect(prompts).toHaveLength(2);
  });

  test("returns a bounded invalid result when the repair RPC fails while retaining the initial raw evidence", async () => {
    const invalid = validVerdict();
    invalid.overall.score = 9;
    const driver = {
      stops: 0,
      start() {},
      async prompt() {
        if (!this.called) {
          this.called = true;
          return assistantEvents(fenced(invalid));
        }
        throw new Error("RPC terminal failure");
      },
      async stop() { this.stops++; },
    };

    const result = await judgeTranscript({
      transcript: "repair transport transcript",
      opportunities: [{ phase: "P1-baseline", intent: "finish" }],
      judgeAgentDir: "/agent",
      sessionDir: "/sessions",
      cwd: "/workspace",
      driverFactory() { return driver; },
    });

    expect(result).toMatchObject({ ok: false, rubricVersion: RUBRIC_VERSION });
    expect(result.raw).toBe(fenced(invalid));
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ kind: "initial", ok: false, raw: fenced(invalid) });
    expect(result.attempts[1]).toMatchObject({ kind: "repair", ok: false, raw: "" });
    expect(result.attempts[1].error).toContain("RPC terminal failure");
    expect(driver.stops).toBe(1);
  });

  test("shares one total deadline across initial and repair attempts", async () => {
    const invalid = validVerdict();
    invalid.overall.score = 9;
    let time = 0;
    const timeoutBudgets = [];
    const driver = {
      start() {},
      async prompt(_prompt, { timeoutMs }) {
        timeoutBudgets.push(timeoutMs);
        time = 100;
        return assistantEvents(fenced(invalid));
      },
      async stop() {},
    };

    const result = await judgeTranscript({
      transcript: "deadline transcript",
      opportunities: [{ phase: "P1-baseline", intent: "finish" }],
      judgeAgentDir: "/agent",
      sessionDir: "/sessions",
      cwd: "/workspace",
      timeoutMs: 100,
      now: () => time,
      driverFactory() { return driver; },
    });

    expect(result).toMatchObject({ ok: false, rubricVersion: RUBRIC_VERSION });
    expect(timeoutBudgets).toEqual([100]);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]).toMatchObject({ kind: "repair", ok: false });
    expect(result.attempts[1].error).toContain("total deadline exhausted");
  });

  test("rejects even a schema-valid reply that arrives after the total deadline", async () => {
    let time = 0;
    const driver = {
      start() {},
      async prompt() {
        time = 101;
        return assistantEvents(fenced(validVerdict()));
      },
      async stop() {},
    };

    const result = await judgeTranscript({
      transcript: "late transcript",
      opportunities: [{ phase: "P1-baseline", intent: "finish" }],
      judgeAgentDir: "/agent",
      sessionDir: "/sessions",
      cwd: "/workspace",
      timeoutMs: 100,
      now: () => time,
      driverFactory() { return driver; },
    });

    expect(result).toMatchObject({ ok: false, rubricVersion: RUBRIC_VERSION });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toContain("total deadline exhausted after prompt");
  });
});
