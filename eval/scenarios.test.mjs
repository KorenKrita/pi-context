import { describe, expect, test } from "bun:test";
import { buildJudgePrompt, buildTranscript, RUBRIC_VERSION } from "./judge.mjs";
import { pickTravel, SCENARIOS, scoreHandoff, toolSucceeded } from "./scenarios.mjs";

const VALID_HANDOFF = {
  goal: "Finish the parser migration",
  state: "The implementation is complete and tests are green",
  evidence: "src/parser.ts and bun test",
  external: "none",
  exclusions: "Do not restore the old parser",
  recover: "parser-before-migration",
  next: "Update the README example",
};

describe("ACM eval result scoring", () => {
  test("requires both transport success and an empty domain-error field", () => {
    expect(toolSucceeded({ name: "acm_travel", isError: false, details: {} })).toBe(true);
    expect(toolSucceeded({ name: "acm_travel", isError: true, details: {} })).toBe(false);
    expect(toolSucceeded({ name: "acm_travel", isError: false, details: { error: "mixed_tool_batch" } })).toBe(false);
  });

  test("does not credit a transport-successful but domain-rejected travel", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === "directed-travel-handoff");
    if (!scenario) throw new Error("directed travel scenario missing");

    const result = scenario.score({
      events: [],
      assistantTexts: [],
      toolCalls: [
        { name: "acm_checkpoint", args: { name: "latency-hunt-scan" }, isError: false, details: {} },
        {
          name: "acm_travel",
          args: { handoff: VALID_HANDOFF, backupCurrentHeadAs: "latency-hunt-raw" },
          isError: false,
          details: { error: "mixed_tool_batch" },
        },
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "travel succeeded")?.pass).toBe(false);
  });

  test("selects a completed travel rather than a later domain-rejected attempt", () => {
    const applied = { name: "acm_travel", args: { handoff: VALID_HANDOFF }, isError: false, details: {} };
    const rejected = {
      name: "acm_travel",
      args: { handoff: VALID_HANDOFF },
      isError: false,
      details: { error: "invalid_handoff" },
    };

    expect(pickTravel([applied, rejected])).toBe(applied);
  });

  test("requires the exact structured-handoff field set", () => {
    expect(scoreHandoff(VALID_HANDOFF)).toMatchObject({ ok: true, extra: [] });
    expect(scoreHandoff({ ...VALID_HANDOFF, summary: "legacy duplicate" })).toEqual({
      ok: false,
      missing: [],
      invalidAuthoritative: [],
      extra: ["summary"],
      detail: "unexpected fields: summary",
    });
  });

  test("pins the judge to the outcome-first, non-comparable v3 rubric", () => {
    const prompt = buildJudgePrompt({
      opportunities: [{ phase: "P1", intent: "finish a focused change" }],
      transcript: "【助手动作】acm_travel",
      taskCompletionDesc: "Did the task remain correct?",
    });

    expect(RUBRIC_VERSION).toBe("acm-outcome-v3");
    expect(prompt).toContain("outcome-first");
    expect(prompt).toContain("不可直接比较");
    expect(prompt).toContain("本身不是自动扣分条件");
    expect(prompt).toContain("无谓重读、thrash 或转去错误工作");
  });

  test("renders a domain-rejected ACM result as failed evidence for the judge", () => {
    const transcript = buildTranscript([{
      phase: "P1",
      prompt: "Fold this work.",
      assistantText: "Travel attempted.",
      toolCalls: [{
        name: "acm_travel",
        args: { handoff: VALID_HANDOFF },
        isError: false,
        details: { error: "invalid_handoff" },
      }],
    }]);

    expect(transcript).toContain("acm_travel ✗ERROR");
  });
});
