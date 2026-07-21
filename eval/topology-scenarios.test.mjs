import { describe, expect, test } from "bun:test";
import {
  listTopologyScenarios,
  TOPOLOGY_RUNNER_INTEGRATION,
  TOPOLOGY_SCENARIOS,
} from "./topology-scenarios.mjs";

const PRECISE_NONCE = "topology-nonce-7K4M";
const PRECISE_BASE = "recovery-base-7K4M";
const PRECISE_DECOY = "recovery-decoy-7K4M";
const PRECISE_ARCHIVE = "recovery-raw-7K4M";
const REHYDRATE_NONCE = "rehydrate-nonce-Q9V2";
const REHYDRATE_BASE = "rehydrate-base-Q9V2";
const REHYDRATE_ARCHIVE = "rehydrate-raw-Q9V2";
const REHYDRATE_RETURN = "rehydrate-return-Q9V2";

const HANDOFF = Object.freeze({
  goal: "Continue the migration with the verified boundary intact.",
  state: "The durable migration state is current and the raw trail is archived.",
  evidence: "baseline.md and the durable checkpoint receipt.",
  external: "none",
  exclusions: "Do not treat a nearby archival marker as the fold base.",
  recover: "raw-recovery-pointer",
  next: "Perform the one concrete continuation action.",
});

function completed(name, args = {}, details = {}) {
  return { name, args, completed: true, isError: false, details };
}

function handoff(overrides = {}) {
  return { ...HANDOFF, ...overrides };
}

function context(turns) {
  return {
    events: [],
    assistantTexts: [],
    turnRecords: turns.map((toolCalls) => ({ events: [], toolCalls, assistantTexts: [] })),
    toolCalls: turns.flat(),
  };
}

function scenario(id) {
  const found = TOPOLOGY_SCENARIOS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`topology scenario ${id} missing`);
  return found;
}

function preciseHappyContext() {
  return context([
    [
      completed("read", { path: "brief.md" }),
      completed("acm_checkpoint", { name: PRECISE_BASE }),
    ],
    [
      completed("read", { path: "raw/trace.md" }),
      completed("acm_checkpoint", { name: PRECISE_DECOY }),
    ],
    [completed("acm_travel", {
      target: PRECISE_BASE,
      backupCurrentHeadAs: PRECISE_ARCHIVE,
      handoff: handoff({
        recover: PRECISE_ARCHIVE,
        state: `Raw trace concluded; exact remediation nonce is ${PRECISE_NONCE}.`,
        next: `On the next user instruction, write recovered-plan.md containing exact remediation nonce ${PRECISE_NONCE}.`,
      }),
    }, {
      target: PRECISE_BASE,
      backupCurrentHeadAs: PRECISE_ARCHIVE,
      backupOutcome: "applied",
      fromOffPath: false,
    })],
    [completed("write", { path: "recovered-plan.md", content: `remediation=${PRECISE_NONCE}\n` })],
  ]);
}

function rehydrateHappyContext() {
  return context([
    [completed("read", { path: "baseline.md" }), completed("acm_checkpoint", { name: REHYDRATE_BASE })],
    [completed("read", { path: "archive/provenance.txt" })],
    [completed("acm_travel", {
      target: REHYDRATE_BASE,
      backupCurrentHeadAs: REHYDRATE_ARCHIVE,
      handoff: handoff({
        recover: REHYDRATE_ARCHIVE,
        next: `On the next user instruction, create ${REHYDRATE_RETURN} before recovering the archived forensic detail.`,
      }),
    }, {
      target: REHYDRATE_BASE,
      backupCurrentHeadAs: REHYDRATE_ARCHIVE,
      backupOutcome: "applied",
      fromOffPath: false,
    })],
    [completed("acm_checkpoint", { name: REHYDRATE_RETURN })],
    [
      completed("acm_travel", {
        target: REHYDRATE_ARCHIVE,
        handoff: handoff({
          recover: REHYDRATE_RETURN,
          next: "Read archive/provenance.txt and extract the exact forensic correlation nonce.",
        }),
      }, { target: REHYDRATE_ARCHIVE, fromOffPath: true }),
      completed("read", { path: "archive/provenance.txt" }),
    ],
    [
      completed("acm_travel", {
        target: REHYDRATE_RETURN,
        handoff: handoff({
          state: `Recovered exact forensic correlation nonce ${REHYDRATE_NONCE} from the archived note.`,
          evidence: `archive/provenance.txt supplied ${REHYDRATE_NONCE}.`,
          recover: REHYDRATE_ARCHIVE,
          next: `Write migration-receipt.md containing exact forensic correlation nonce ${REHYDRATE_NONCE}.`,
        }),
      }, { target: REHYDRATE_RETURN, fromOffPath: true }),
      completed("write", { path: "migration-receipt.md", content: `forensic=${REHYDRATE_NONCE}\n` }),
    ],
  ]);
}

describe("topology scenario prompt contracts", () => {
  test("does not feed the final travel target as a direct instruction", () => {
    const precise = scenario("checkpoint-precise-recovery");
    const rehydrate = scenario("rehydrate-round-trip");

    expect(rehydrate.turns).toHaveLength(6);
    expect(precise.turns[2]?.prompt).not.toContain(`target ${PRECISE_BASE}`);
    expect(precise.turns[2]?.prompt).toContain("rather than the nearer marker");
    expect(precise.turns[2]?.prompt).toContain("next user instruction");
    expect(rehydrate.turns[4]?.prompt).not.toContain(`target ${REHYDRATE_ARCHIVE}`);
    expect(rehydrate.turns[5]?.prompt).not.toContain(`target ${REHYDRATE_RETURN}`);
    expect(rehydrate.turns[4]?.prompt).toContain("archive recovery pointer");
    expect(rehydrate.turns[5]?.prompt).toContain("semantic return role");
    expect(rehydrate.turns[2]?.prompt).toContain("next user instruction");
    expect(rehydrate.turns[4]?.prompt).toContain("same turn");
    expect(rehydrate.turns[4]?.prompt).toContain("After the read, stop");
    expect(rehydrate.turns[4]?.prompt).toContain("do not return");
    expect(rehydrate.turns[4]?.prompt).toContain("do not call acm_travel again");
    expect(rehydrate.turns[5]?.prompt).toContain("same turn");
  });

  test("declares the existing runner integration seam rather than faking topology state", () => {
    expect(TOPOLOGY_RUNNER_INTEGRATION).toEqual({
      exportName: "TOPOLOGY_SCENARIOS",
      runnerChange: "append TOPOLOGY_SCENARIOS to the existing scenario list",
      requiredContextFields: ["turnRecords", "toolCalls"],
      requiredRunnerBehavior: ["real multi-turn Pi RPC session", "matching tool_execution_end required", "preserve travel details"],
    });
    expect(listTopologyScenarios()).toHaveLength(2);
    expect(listTopologyScenarios({ family: "topology" }).map((item) => item.id)).toEqual([
      "checkpoint-precise-recovery",
      "rehydrate-round-trip",
    ]);
  });
});

describe("checkpoint-precise-recovery scoring", () => {
  test("requires the pre-trace base, not the later decoy, plus a direct carried NEXT", () => {
    const result = scenario("checkpoint-precise-recovery").score(preciseHappyContext());

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T3 target is the pre-trace checkpoint")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T3 handoff leaves NEXT for the next user instruction")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T4 executes NEXT without archive reread")?.pass).toBe(true);
  });

  test("accepts matrix-observed equivalent ways to defer NEXT until a future user instruction", () => {
    const variants = [
      `Explicitly defer this action until the next user instruction: write recovered-plan.md containing the exact nonce ${PRECISE_NONCE}.`,
      `Defer until the next user instruction: write recovered-plan.md containing the nonce ${PRECISE_NONCE}.`,
      `Await the next user instruction — do nothing else first. Only when the user instructs, write recovered-plan.md containing the exact remediation nonce ${PRECISE_NONCE}.`,
    ];

    for (const next of variants) {
      const ctx = preciseHappyContext();
      const travel = ctx.turnRecords[2]?.toolCalls[0];
      if (!travel) throw new Error("precise travel missing");
      travel.args.handoff = handoff({
        recover: PRECISE_ARCHIVE,
        state: `Raw trace concluded; exact remediation nonce is ${PRECISE_NONCE}.`,
        next,
      });

      const result = scenario("checkpoint-precise-recovery").score(ctx);
      expect(result.pass, next).toBe(true);
    }
  });

  test("fails when the fold turn writes a NEXT reserved for the next user instruction", () => {
    const ctx = preciseHappyContext();
    const t3 = ctx.turnRecords[2];
    if (!t3) throw new Error("precise fold turn missing");
    t3.toolCalls.push(completed("write", {
      path: "recovered-plan.md",
      content: `remediation=${PRECISE_NONCE}\n`,
    }));
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("checkpoint-precise-recovery").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 does not execute the future-triggered write")?.pass).toBe(false);
  });

  test("fails if a nearby decoy is used as the travel target", () => {
    const ctx = preciseHappyContext();
    const travel = ctx.turnRecords[2]?.toolCalls[0];
    if (!travel) throw new Error("precise travel missing");
    travel.args.target = PRECISE_DECOY;
    travel.details.target = PRECISE_DECOY;

    const result = scenario("checkpoint-precise-recovery").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 target is the pre-trace checkpoint")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 does not follow the later decoy")?.pass).toBe(false);
  });

  test("fails a transport-successful but domain-rejected travel so it cannot credit a bad branch", () => {
    const ctx = preciseHappyContext();
    const travel = ctx.turnRecords[2]?.toolCalls[0];
    if (!travel) throw new Error("precise travel missing");
    travel.details.error = "mixed_tool_batch";

    const result = scenario("checkpoint-precise-recovery").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 travel succeeds alone")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "no rejected or extra travel branch")?.pass).toBe(false);
  });
});

describe("rehydrate-round-trip scoring", () => {
  test("requires both off-path directions, same-turn continuations, and the extracted nonce in the returned NEXT", () => {
    const result = scenario("rehydrate-round-trip").score(rehydrateHappyContext());

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T5 travels to the off-path archive")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T3 fold NEXT waits for the next user instruction")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T3 does not create the return save point early")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T5 directly reads the archive after travel")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T6 returns to the saved off-path return point")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T6 returned handoff carries recovered exact nonce")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T6 directly writes the returned receipt")?.pass).toBe(true);
  });

  test("accepts next-explicit-user wording for the deferred return checkpoint", () => {
    const ctx = rehydrateHappyContext();
    const fold = ctx.turnRecords[2]?.toolCalls[0];
    if (!fold) throw new Error("fold travel missing");
    fold.args.handoff = handoff({
      recover: REHYDRATE_ARCHIVE,
      next: `Wait for the next explicit user instruction before creating the return save point ${REHYDRATE_RETURN}.`,
    });

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(true);
  });

  test("accepts an explicit-wait adverb before the next-user trigger", () => {
    const ctx = rehydrateHappyContext();
    const fold = ctx.turnRecords[2]?.toolCalls[0];
    if (!fold) throw new Error("fold travel missing");
    fold.args.handoff = handoff({
      recover: REHYDRATE_ARCHIVE,
      next: `Wait explicitly for the next user instruction before creating the return save point ${REHYDRATE_RETURN}; take no further action now.`,
    });

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(true);
  });

  test("accepts explicit-next adjective order for the deferred user trigger", () => {
    const ctx = rehydrateHappyContext();
    const fold = ctx.turnRecords[2]?.toolCalls[0];
    if (!fold) throw new Error("fold travel missing");
    fold.args.handoff = handoff({
      recover: REHYDRATE_ARCHIVE,
      next: `Wait for explicit next user instruction before creating the return save point ${REHYDRATE_RETURN}.`,
    });

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(true);
  });

  test("accepts Kimi's possessive future-user wording while still rejecting its early return", () => {
    const ctx = rehydrateHappyContext();
    const fold = ctx.turnRecords[2]?.toolCalls[0];
    const archiveTurn = ctx.turnRecords[4];
    if (!fold || !archiveTurn) throw new Error("Kimi regression fixture missing topology turns");
    fold.args.handoff = handoff({
      recover: REHYDRATE_ARCHIVE,
      next: `Wait for the user's next instruction before taking any action — specifically, do NOT create the return save point ${REHYDRATE_RETURN} until the user explicitly directs it; when directed, save ${REHYDRATE_RETURN} first, then rehydrate ${REHYDRATE_ARCHIVE} to fetch the forensic nonce for the final migration receipt.`,
    });
    archiveTurn.toolCalls.push(completed("acm_travel", {
      target: REHYDRATE_RETURN,
      handoff: handoff({ next: "Return to the folded branch." }),
    }, { target: REHYDRATE_RETURN, fromOffPath: true }));
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 fold NEXT waits for the next user instruction")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "no rejected, mixed, or extra travel branch")?.pass).toBe(false);
  });

  test("accepts direct imperative archive-read and receipt-write NEXT without temporal adverbs", () => {
    const result = scenario("rehydrate-round-trip").score(rehydrateHappyContext());

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T5 archive handoff NEXT is exact source read")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "T6 returned handoff carries recovered exact nonce")?.pass).toBe(true);
  });

  test("still requires explicit read and write action facts in the handoff NEXT fields", () => {
    const missingRead = rehydrateHappyContext();
    const archiveTravel = missingRead.turnRecords[4]?.toolCalls[0];
    if (!archiveTravel) throw new Error("archive travel missing");
    archiveTravel.args.handoff = handoff({
      recover: REHYDRATE_RETURN,
      next: "The exact forensic correlation nonce remains in archive/provenance.txt.",
    });

    const missingWrite = rehydrateHappyContext();
    const returnTravel = missingWrite.turnRecords[5]?.toolCalls[0];
    if (!returnTravel) throw new Error("return travel missing");
    returnTravel.args.handoff = handoff({
      state: `Recovered exact forensic correlation nonce ${REHYDRATE_NONCE} from the archived note.`,
      recover: REHYDRATE_ARCHIVE,
      next: `migration-receipt.md must contain exact forensic correlation nonce ${REHYDRATE_NONCE}.`,
    });

    const readResult = scenario("rehydrate-round-trip").score(missingRead);
    const writeResult = scenario("rehydrate-round-trip").score(missingWrite);
    expect(readResult.pass).toBe(false);
    expect(readResult.checks.find((item) => item.name === "T5 archive handoff NEXT is exact source read")?.pass).toBe(false);
    expect(writeResult.pass).toBe(false);
    expect(writeResult.checks.find((item) => item.name === "T6 returned handoff carries recovered exact nonce")?.pass).toBe(false);
  });

  test("fails when the archive turn returns early after the required direct read", () => {
    const ctx = rehydrateHappyContext();
    const t5 = ctx.turnRecords[4];
    if (!t5) throw new Error("archive turn missing");
    t5.toolCalls.push(completed("acm_travel", {
      target: REHYDRATE_RETURN,
      handoff: handoff({ next: "Return to the folded branch." }),
    }, { target: REHYDRATE_RETURN, fromOffPath: true }));
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "no rejected, mixed, or extra travel branch")?.pass).toBe(false);
  });

  test("fails when the archive read is deferred beyond the archive travel turn", () => {
    const ctx = rehydrateHappyContext();
    const t5 = ctx.turnRecords[4];
    const t6 = ctx.turnRecords[5];
    if (!t5 || !t6) throw new Error("rehydrate continuation turns missing");
    const read = t5.toolCalls.pop();
    if (!read) throw new Error("archive read missing");
    t6.toolCalls.unshift(read);
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T5 directly reads the archive after travel")?.pass).toBe(false);
  });

  test("fails when the fold creates the return save point before its next-user trigger", () => {
    const ctx = rehydrateHappyContext();
    const t3 = ctx.turnRecords[2];
    if (!t3) throw new Error("fold turn missing");
    t3.toolCalls.push(completed("acm_checkpoint", { name: REHYDRATE_RETURN }));
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T3 does not create the return save point early")?.pass).toBe(false);
  });

  test("fails when a rehydrate target is not the archive recovery alias", () => {
    const ctx = rehydrateHappyContext();
    const rehydrate = ctx.turnRecords[4]?.toolCalls[0];
    if (!rehydrate) throw new Error("rehydrate travel missing");
    rehydrate.args.target = REHYDRATE_RETURN;
    rehydrate.details.target = REHYDRATE_RETURN;
    rehydrate.details.fromOffPath = false;

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T5 travels to the off-path archive")?.pass).toBe(false);
  });

  test("fails if the return handoff omits the recovered nonce even when the branch round trip succeeds", () => {
    const ctx = rehydrateHappyContext();
    const returned = ctx.turnRecords[5]?.toolCalls[0];
    if (!returned) throw new Error("return travel missing");
    returned.args.handoff = handoff({
      recover: REHYDRATE_ARCHIVE,
      next: "Write migration-receipt.md with the recovered forensic detail.",
    });

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T6 returned handoff carries recovered exact nonce")?.pass).toBe(false);
  });

  test("fails when the returned receipt is deferred beyond the return travel turn", () => {
    const ctx = rehydrateHappyContext();
    const t6 = ctx.turnRecords[5];
    if (!t6) throw new Error("return turn missing");
    t6.toolCalls.pop();
    ctx.toolCalls = ctx.turnRecords.flatMap((turn) => turn.toolCalls);

    const result = scenario("rehydrate-round-trip").score(ctx);
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "T6 directly writes the returned receipt")?.pass).toBe(false);
  });
});
