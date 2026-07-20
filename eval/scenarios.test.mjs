import { describe, expect, test } from "bun:test";
import { buildJudgePrompt, buildTranscript, RUBRIC_VERSION } from "./judge.mjs";
import {
  CONTEXT_MANAGEMENT_SKILL_PATH,
  pickTravel,
  SCENARIOS,
  scoreHandoff,
  TARGET_SELECTION_REFERENCE_PATH,
  toolSucceeded,
} from "./scenarios.mjs";

const VALID_HANDOFF = {
  goal: "Finish the parser migration",
  state: "The implementation is complete and tests are green",
  evidence: "src/parser.ts and bun test",
  external: "none",
  exclusions: "Do not restore the old parser",
  recover: "parser-before-migration",
  next: "Update the README example",
};

const CONTINUATION_HANDOFF = {
  goal: "Continue the payments latency investigation",
  state: "Database indexes are healthy and pool max=50 remains the live operational limit",
  evidence: "findings.md; config/prod.yaml:23; retry commit 9f31c2a",
  external: "none",
  exclusions: "Do not reopen the settled database-index investigation",
  recover: "payments-latency-raw",
  next: "Write next-action.md with pool max=50; retry commit=9f31c2a; inspect services/payments/client.ts backoff bounds.",
};

function call(name, args = {}, details = {}) {
  return { name, args, isError: false, details };
}

function continuationContext({ environmentMode = "product-isolated", t1, t2, t3 } = {}) {
  const turns = [
    {
      events: [],
      toolCalls: t1 ?? [
        call("read", { path: "findings.md" }),
        call("acm_checkpoint", { name: "payments-latency-findings" }),
      ],
      assistantTexts: ["I read the findings and stopped at the requested save point."],
    },
    {
      events: [],
      toolCalls: t2 ?? [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: "pool max=50; retry commit=9f31c2a; inspect services/payments/client.ts backoff bounds.",
        }),
      ],
      assistantTexts: ["The handoff is complete and the next action was written."],
    },
    {
      events: [],
      toolCalls: t3 ?? (environmentMode === "core-only" ? [] : [
        call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH }),
        call("read", { path: TARGET_SELECTION_REFERENCE_PATH }),
      ]),
      assistantTexts: ["I need the surviving rollback boundary and next-task evidence before deciding; hold no travel."],
    },
  ];
  return {
    events: [],
    toolCalls: turns.flatMap((turn) => turn.toolCalls),
    assistantTexts: turns.flatMap((turn) => turn.assistantTexts),
    turnRecords: turns,
    environmentMode,
  };
}

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

describe("structured handoff continuation and advanced Skill scenario", () => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === "structured-handoff-continuation-and-skill");
  if (!scenario) throw new Error("structured handoff continuation scenario missing");

  test("does not leak the checkout Skill path into the model prompt", () => {
    const advancedPrompt = scenario.turns[2]?.prompt ?? "";

    expect(advancedPrompt).toContain("context-management advanced Skill");
    expect(advancedPrompt).not.toContain("SKILL.md");
    expect(advancedPrompt).not.toContain("references/target-selection.md");
    expect(advancedPrompt).not.toContain("/Users/");
  });

  test("requires first-pass travel, direct fact-carrying continuation, and product Skill reads", () => {
    const result = scenario.score(continuationContext());
    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 first travel attempt succeeded")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T3 read product advanced guidance")?.pass).toBe(true);
  });

  test("fails when the first travel attempt is rejected even if a later attempt succeeds", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }, { error: "invalid_handoff" }),
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: "pool max=50; retry commit=9f31c2a; inspect services/payments/client.ts backoff bounds.",
        }),
      ],
    }));

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T2 first travel attempt succeeded")?.pass).toBe(false);
  });

  test("fails a post-travel reread or wrong first continuation action", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("read", { path: "findings.md" }),
        call("write", {
          path: "next-action.md",
          content: "pool max=50; retry commit=9f31c2a; inspect services/payments/client.ts backoff bounds.",
        }),
      ],
    }));

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T2 direct first continuation write")?.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T2 did not reread archive material")?.pass).toBe(false);
  });

  test("accepts markdown formatting that preserves the required continuation facts", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: "**pool max**: 50; **retry commit**: `9f31c2a`; inspect `services/payments/client.ts` backoff bounds.",
        }),
      ],
    }));

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 write carries handoff facts")?.pass).toBe(true);
  });

  test("fails product-isolated runs that have the Skill but do not read both required guidance files", () => {
    const result = scenario.score(continuationContext({
      t3: [call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH })],
    }));

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T3 read product advanced guidance")?.pass).toBe(false);
  });

  test("core-only remains isolated and is rewarded for a conservative no-travel answer", () => {
    const baseline = scenario.score(continuationContext({ environmentMode: "core-only" }));
    expect(baseline.pass).toBe(true);
    expect(baseline.checks.find((check) => check.name === "T3 kept core-only isolation")?.pass).toBe(true);

    const leaked = scenario.score(continuationContext({
      environmentMode: "core-only",
      t3: [call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH })],
    }));
    expect(leaked.pass).toBe(false);
    expect(leaked.checks.find((check) => check.name === "T3 kept core-only isolation")?.pass).toBe(false);
  });
});
