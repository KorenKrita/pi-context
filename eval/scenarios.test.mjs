import { describe, expect, test } from "bun:test";
import { buildJudgePrompt, buildTranscript, RUBRIC_VERSION } from "./judge.mjs";
import {
  CONTEXT_MANAGEMENT_SKILL_PATH,
  extractAssistantTranscript,
  extractTranscriptSegments,
  extractToolCalls,
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
  next: "Write next-action.md with pool max=50; retry commit=9f31c2a; next file to inspect: services/payments/client.ts backoff bounds.",
};

function call(name, args = {}, details = {}) {
  return { name, args, completed: true, isError: false, details };
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
    expect(toolSucceeded({ name: "acm_travel", completed: true, isError: false, details: {} })).toBe(true);
    expect(toolSucceeded({ name: "acm_travel", completed: false, isError: false, details: {} })).toBe(false);
    expect(toolSucceeded({ name: "acm_travel", completed: true, isError: true, details: {} })).toBe(false);
    expect(toolSucceeded({ name: "acm_travel", completed: true, isError: false, details: { error: "mixed_tool_batch" } })).toBe(false);
  });

  test("does not credit a tool start until its matching completion is observed", () => {
    const calls = extractToolCalls([{
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "read-1",
      args: { path: "file.md" },
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.completed).toBe(false);
    expect(toolSucceeded(calls[0])).toBe(false);
  });

  test("retains every visible assistant segment from a tool-using turn", () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer before travel" }] } },
      { type: "tool_execution_start", toolName: "acm_travel", toolCallId: "t", args: { target: "root" } },
      { type: "tool_execution_end", toolName: "acm_travel", toolCallId: "t", isError: false, result: { content: [] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "post-travel continuation" }] } },
    ];
    const transcript = extractAssistantTranscript(events);

    expect(transcript).toBe("answer before travel\n\npost-travel continuation");
    const rendered = buildTranscript([{
      phase: "P1",
      prompt: "Answer, then travel.",
      toolCalls: extractToolCalls(events),
      assistantText: transcript,
      segments: extractTranscriptSegments(events),
    }]);
    expect(rendered.indexOf("answer before travel")).toBeLessThan(rendered.indexOf("acm_travel"));
    expect(rendered.indexOf("acm_travel")).toBeLessThan(rendered.indexOf("post-travel continuation"));
  });

  test("does not credit a transport-successful but domain-rejected travel", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === "directed-travel-handoff");
    if (!scenario) throw new Error("directed travel scenario missing");

    const result = scenario.score({
      events: [],
      assistantTexts: [],
      toolCalls: [
        { name: "acm_checkpoint", args: { name: "latency-hunt-scan" }, completed: true, isError: false, details: {} },
        {
          name: "acm_travel",
          args: { handoff: VALID_HANDOFF, backupCurrentHeadAs: "latency-hunt-raw" },
          completed: true,
          isError: false,
          details: { error: "mixed_tool_batch" },
        },
      ],
    });

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "travel succeeded")?.pass).toBe(false);
  });

  test("selects a completed travel rather than a later domain-rejected attempt", () => {
    const applied = { name: "acm_travel", args: { handoff: VALID_HANDOFF }, completed: true, isError: false, details: {} };
    const rejected = {
      name: "acm_travel",
      args: { handoff: VALID_HANDOFF },
      completed: true,
      isError: false,
      details: { error: "invalid_handoff" },
    };

    expect(pickTravel([applied, rejected])).toBe(applied);
  });

  test("requires the exact structured-handoff field set", () => {
    expect(scoreHandoff(VALID_HANDOFF)).toMatchObject({ ok: true, extra: [] });
    expect(scoreHandoff(JSON.stringify(VALID_HANDOFF))).toMatchObject({ ok: true, extra: [] });
    expect(scoreHandoff("not json")).toMatchObject({ ok: false, detail: "invalid JSON-encoded structured handoff" });
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
        completed: true,
        isError: false,
        details: { error: "invalid_handoff" },
      }],
    }]);

    expect(transcript).toContain("acm_travel ✗ERROR");
  });

  test("renders a tool start without completion as incomplete evidence", () => {
    const transcript = buildTranscript([{
      phase: "P1",
      prompt: "Inspect guidance.",
      assistantText: "",
      toolCalls: [{
        name: "read",
        args: { path: CONTEXT_MANAGEMENT_SKILL_PATH },
        completed: false,
        isError: false,
      }],
    }]);

    expect(transcript).toContain("read(");
    expect(transcript).toContain("…INCOMPLETE");
  });
});

describe("structured handoff continuation and advanced Skill scenario", () => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === "structured-handoff-continuation-and-skill");
  if (!scenario) throw new Error("structured handoff continuation scenario missing");

  test("does not leak the checkout Skill path into the model prompt", () => {
    const advancedPrompt = scenario.turns[2]?.prompt ?? "";

    expect(advancedPrompt).toContain("context-management advanced Skill");
    expect(advancedPrompt).toContain("absence from that list is conclusive");
    expect(advancedPrompt).toContain("do not read Skill documentation");
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

  test("accepts the strict JSON-encoded handoff fallback through the full scenario", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", {
          target: "root",
          handoff: JSON.stringify(CONTINUATION_HANDOFF),
          backupCurrentHeadAs: "payments-latency-raw",
        }),
        call("write", {
          path: "next-action.md",
          content: "pool max=50; retry commit=9f31c2a; next file: services/payments/client.ts backoff bounds.",
        }),
      ],
    }));

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 structured handoff")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 handoff NEXT carries exact continuation")?.pass).toBe(true);
  });

  test("requires completed successful findings reads and REQUIRED NEXT writes", () => {
    for (const badRead of [
      { ...call("read", { path: "findings.md" }), completed: false },
      { ...call("read", { path: "findings.md" }), isError: true },
    ]) {
      const result = scenario.score(continuationContext({
        t1: [badRead, call("acm_checkpoint", { name: "payments-latency-findings" })],
      }));
      expect(result.pass).toBe(false);
      expect(result.checks.find((check) => check.name === "T1 read findings")?.pass).toBe(false);
    }

    for (const badWrite of [
      { ...call("write", { path: "next-action.md", content: "pool max=50; retry commit=9f31c2a; services/payments/client.ts" }), completed: false },
      { ...call("write", { path: "next-action.md", content: "pool max=50; retry commit=9f31c2a; services/payments/client.ts" }), isError: true },
    ]) {
      const result = scenario.score(continuationContext({
        t2: [
          call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
          badWrite,
        ],
      }));
      expect(result.pass).toBe(false);
      expect(result.checks.find((check) => check.name === "T2 direct first continuation write")?.pass).toBe(false);
    }
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
    expect(result.checks.find((check) => check.name === "T2 did not inspect before REQUIRED NEXT")?.pass).toBe(false);
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

  test("accepts markdown tables that preserve the required continuation facts", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: [
            "| Item | Value |",
            "| --- | --- |",
            "| Pool max | 50 |",
            "| Retry commit | 9f31c2a |",
            "Next file to inspect: `services/payments/client.ts` backoff bounds.",
          ].join("\n"),
        }),
      ],
    }));

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 write carries handoff facts")?.pass).toBe(true);
  });

  test("accepts separate retry semantics and commit facts without a contiguous phrase", () => {
    const handoff = {
      ...CONTINUATION_HANDOFF,
      next: "Write next-action.md with pool max 50. The retry loop was introduced in Commit 9f31c2a. Then inspect services/payments/client.ts backoff bounds.",
    };
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: "Retry Loop Introduced: Commit 9f31c2a. Pool max: 50. Next file: services/payments/client.ts backoff bounds.",
        }),
      ],
    }));

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 handoff NEXT carries exact continuation")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 write carries handoff facts")?.pass).toBe(true);
  });

  test("accepts a clarified pool-max label without losing the numeric fact", () => {
    const result = scenario.score(continuationContext({
      t2: [
        call("acm_travel", { target: "root", handoff: CONTINUATION_HANDOFF, backupCurrentHeadAs: "payments-latency-raw" }),
        call("write", {
          path: "next-action.md",
          content: "Pool max connections: 50. Retry commit: 9f31c2a. Next file: services/payments/client.ts backoff bounds.",
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

  test("accepts successful bash readers for the advanced Skill router and reference", () => {
    const result = scenario.score(continuationContext({
      t3: [
        call("bash", { command: `cat ${CONTEXT_MANAGEMENT_SKILL_PATH}` }),
        call("bash", { command: `sed -n '1,160p' ${TARGET_SELECTION_REFERENCE_PATH}` }),
      ],
    }));

    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T3 read product advanced guidance")?.pass).toBe(true);
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

describe("advanced pointer routing scenario", () => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === "advanced-pointer-routing");
  if (!scenario) throw new Error("advanced pointer routing scenario missing");

  const context = (environmentMode, extraCalls = []) => ({
    events: [],
    environmentMode,
    toolCalls: [
      call("acm_checkpoint", { name: "pointer-routing-base" }),
      call("acm_timeline", { view: "active" }),
      ...extraCalls,
    ],
    assistantTexts: ["Hold travel until the missing branch ownership and anchor facts are known before deciding."],
  });

  test("does not name or leak the advanced Skill in the user prompt", () => {
    const prompt = scenario.turns[0]?.prompt ?? "";
    expect(prompt).toContain("condition-specific advanced guidance");
    expect(prompt).not.toContain("context-management");
    expect(prompt).not.toContain("SKILL.md");
    expect(prompt).not.toContain("target-selection.md");
  });

  test("product mode follows the runtime pointer through router and reference", () => {
    const result = scenario.score(context("product-isolated", [
      call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH }),
      call("read", { path: TARGET_SELECTION_REFERENCE_PATH }),
    ]));
    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "followed exact advanced pointer")?.pass).toBe(true);
  });

  test("core-only mode stays isolated, while a missing product reference fails", () => {
    expect(scenario.score(context("core-only")).pass).toBe(true);
    const missingReference = scenario.score(context("product-isolated", [
      call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH }),
    ]));
    expect(missingReference.pass).toBe(false);
  });

  test("failed reads and filesystem probing do not count as successful routing", () => {
    const failedReads = scenario.score(context("product-isolated", [
      { ...call("read", { path: CONTEXT_MANAGEMENT_SKILL_PATH }), isError: true },
      { ...call("read", { path: TARGET_SELECTION_REFERENCE_PATH }), isError: true },
    ]));
    expect(failedReads.pass).toBe(false);

    const probedCore = scenario.score(context("core-only", [
      call("bash", { command: "find /tmp -name target-selection.md" }),
    ]));
    expect(probedCore.pass).toBe(false);
    expect(probedCore.checks.find((check) => check.name === "kept unavailable Skill isolated")?.pass).toBe(false);
  });

  test("accepts bash readers but not find-only path mentions for product routing", () => {
    const bashLoaded = scenario.score(context("product-isolated", [
      call("bash", { command: `head -n 80 ${CONTEXT_MANAGEMENT_SKILL_PATH}` }),
      call("bash", { command: `awk 'NR <= 160 { print }' ${TARGET_SELECTION_REFERENCE_PATH}` }),
    ]));
    expect(bashLoaded.pass).toBe(true);
    expect(bashLoaded.checks.find((check) => check.name === "followed exact advanced pointer")?.pass).toBe(true);

    const findOnly = scenario.score(context("product-isolated", [
      call("bash", { command: `find /tmp -path '*context-management*' -o -name target-selection.md # ${CONTEXT_MANAGEMENT_SKILL_PATH}` }),
      call("bash", { command: `find /tmp -name target-selection.md # ${TARGET_SELECTION_REFERENCE_PATH}` }),
    ]));
    expect(findOnly.pass).toBe(false);
    expect(findOnly.checks.find((check) => check.name === "followed exact advanced pointer")?.pass).toBe(false);
  });

  test("recognizes every supported bash reader command for exact guidance paths", () => {
    const readers = [
      ["cat", (path) => `cat ${path}`],
      ["sed", (path) => `sed -n '1,160p' ${path}`],
      ["head", (path) => `head -n 80 ${path}`],
      ["tail", (path) => `tail -n 80 ${path}`],
      ["awk", (path) => `awk 'NR <= 160 { print }' ${path}`],
    ];

    for (const [name, command] of readers) {
      const result = scenario.score(context("product-isolated", [
        call("bash", { command: command(CONTEXT_MANAGEMENT_SKILL_PATH) }),
        call("bash", { command: command(TARGET_SELECTION_REFERENCE_PATH) }),
      ]));
      expect(result.pass, name).toBe(true);
    }
  });

  test("does not treat a bash redirection or plain path mention as reading guidance", () => {
    const result = scenario.score(context("product-isolated", [
      call("bash", { command: `echo router is ${CONTEXT_MANAGEMENT_SKILL_PATH}; cat /tmp/input > ${CONTEXT_MANAGEMENT_SKILL_PATH}` }),
      call("bash", { command: `echo reference is ${TARGET_SELECTION_REFERENCE_PATH}; sed -n '1,10p' /tmp/input > ${TARGET_SELECTION_REFERENCE_PATH}` }),
    ]));

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "followed exact advanced pointer")?.pass).toBe(false);
  });
});

describe("pressure-framing restraint scenario", () => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === "pressure-keep-live-uncertainty");
  if (!scenario) throw new Error("pressure restraint scenario missing");

  test("leaves the T2 travel decision to ACM judgment while requiring direct verification", () => {
    const prompt = scenario.turns[1]?.prompt.toLowerCase() ?? "";

    expect(prompt).toContain("pressure-framing probe");
    expect(prompt).toContain("uncertainty remains live");
    expect(prompt).toContain("timestamps in src/lock.ts");
    expect(prompt).not.toContain("do not acm_travel");
    expect(prompt).not.toContain("do not travel");
  });

  function context({ t1, t2 } = {}) {
    const turns = [
      {
        events: [],
        toolCalls: t1 ?? [
          call("read", { path: "src/lock.ts" }),
          call("acm_checkpoint", { name: "lock-hunt-start" }),
        ],
        assistantTexts: ["The save point is established; I will stop before comparing traces."],
      },
      {
        events: [],
        toolCalls: t2 ?? [call("read", { path: "src/lock.ts" })],
        assistantTexts: ["I compared the timestamp and owner trace evidence; the ownership remains live uncertainty."],
      },
    ];
    return {
      events: [],
      toolCalls: turns.flatMap((turn) => turn.toolCalls),
      assistantTexts: turns.flatMap((turn) => turn.assistantTexts),
      turnRecords: turns,
    };
  }

  test("creates the lock save point in T1, then continues the live investigation in T2", () => {
    const result = scenario.score(context());
    expect(result.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T1 created lock-hunt-start checkpoint")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 continued direct timestamp comparison")?.pass).toBe(true);
  });

  test("reports a rejected travel as an attempted violation, not an applied travel", () => {
    const result = scenario.score(context({
      t2: [
        call("acm_travel", { target: "lock-hunt-start", handoff: VALID_HANDOFF }, { error: "invalid_handoff" }),
        call("read", { path: "src/lock.ts" }),
      ],
    }));

    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T2 forbidden travel attempted")?.pass).toBe(false);
    expect(result.checks.find((check) => check.name === "T2 forbidden travel applied")?.pass).toBe(true);
    expect(result.checks.find((check) => check.name === "T2 forbidden travel applied")?.detail).toContain("no travel applied");
  });
});
