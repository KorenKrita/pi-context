// High-signal topology eval scenarios.
//
// These scenarios deliberately build their session topology through real
// checkpoint/travel calls over several user turns.  The prompts describe the
// semantic boundary and include a decoy; they never tell the agent the final
// `acm_travel.target` value.  Scores therefore assess the observable branch
// choice rather than compliance with a copied target string.

import { scoreHandoff, toolSucceeded } from "./scenario-scoring.mjs";

/** @typedef {{ name: string, pass: boolean, detail: string }} ScoreCheck */
/** @typedef {{ pass: boolean, checks: ScoreCheck[] }} ScoreResult */

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

function recordForTurn(ctx, index) {
  return ctx.turnRecords?.[index] ?? { events: [], toolCalls: [], assistantTexts: [] };
}

function pathFor(call) {
  return String(call?.args?.path ?? call?.args?.file_path ?? call?.args?.file ?? "");
}

function readSucceeded(turn, fragment) {
  return turn.toolCalls.some((call) =>
    toolSucceeded(call)
    && (call.name === "read" || call.name === "read_file")
    && pathFor(call).includes(fragment));
}

function writeSucceeded(turn, fragment) {
  return turn.toolCalls.some((call) =>
    toolSucceeded(call)
    && call.name === "write"
    && pathFor(call).includes(fragment));
}

function allTravelCalls(ctx) {
  return ctx.toolCalls.filter((call) => call.name === "acm_travel");
}

function travelIsACompleteSoloMutation(call) {
  return toolSucceeded(call) && call.details?.error !== "mixed_tool_batch";
}

function travelFailureDetail(call) {
  if (!call) return "missing";
  if (call.details?.error) return String(call.details.error);
  if (call.isError) return call.resultText ?? "transport error";
  if (!call.completed) return "incomplete";
  return "ok";
}

function includesExactNonce(value, nonce) {
  return String(value ?? "").includes(nonce);
}

function handoffCarriesNonce(handoff, nonce) {
  if (!handoff.ok || !handoff.fields) return false;
  return [
    handoff.fields.goal,
    handoff.fields.state,
    handoff.fields.evidence,
    handoff.fields.external,
    handoff.fields.exclusions,
    handoff.fields.recover,
    handoff.fields.next,
  ].some((value) => includesExactNonce(value, nonce));
}

function nextWaitsForNextUserInstruction(next) {
  return /\b(?:on|after|when\s+following|wait(?:ing)?\s+(?:for|until))\s+(?:the\s+)?next\s+user\s+(?:instruction|request|message|turn)\b/i.test(String(next ?? ""));
}

function nextDirectsCurrentTurn(next) {
  const text = String(next ?? "");
  return !nextWaitsForNextUserInstruction(text)
    && /\b(?:immediately|now|this\s+(?:same|current)\s+turn|after\s+(?:the\s+)?travel)\b/i.test(text);
}

function firstCallAfter(turn, call) {
  const index = turn.toolCalls.indexOf(call);
  return index < 0 ? undefined : turn.toolCalls[index + 1];
}

function noRejectedTravelBranch(ctx, expectedCount) {
  const travels = allTravelCalls(ctx);
  return {
    travels,
    ok: travels.length === expectedCount && travels.every(travelIsACompleteSoloMutation),
    detail: travels.length === 0
      ? "no travel calls"
      : travels.map((call) => `${call.args?.target ?? "missing-target"}:${travelFailureDetail(call)}`).join(", "),
  };
}

const PRECISE_NONCE = "topology-nonce-7K4M";
const PRECISE_BASE = "recovery-base-7K4M";
const PRECISE_DECOY = "recovery-decoy-7K4M";
const PRECISE_ARCHIVE = "recovery-raw-7K4M";

const REHYDRATE_NONCE = "rehydrate-nonce-Q9V2";
const REHYDRATE_BASE = "rehydrate-base-Q9V2";
const REHYDRATE_ARCHIVE = "rehydrate-raw-Q9V2";
const REHYDRATE_RETURN = "rehydrate-return-Q9V2";

/**
 * Scenarios are intentionally separate from eval/scenarios.mjs.  The main
 * runner can opt in by concatenating this array with its existing scenarios;
 * keeping them here lets the topology score contract evolve independently.
 */
export const TOPOLOGY_SCENARIOS = [
  {
    id: "checkpoint-precise-recovery",
    family: "topology",
    description: "Choose the checkpoint before raw work rather than a later decoy, preserve an archive alias, and continue from carried nonce facts.",
    seedFiles: {
      "brief.md": [
        "# Stable deployment boundary",
        "",
        "The verified baseline is release 2026.07.21-a.",
        "Only this baseline predates the raw trace that follows.",
        "",
      ].join("\n"),
      "raw/trace.md": [
        "# Raw trace",
        "",
        `Exact remediation nonce: ${PRECISE_NONCE}`,
        "The trace is archival after its conclusion has been carried forward.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read brief.md completely.",
          `Create exactly one ACM save point named ${PRECISE_BASE} at the verified boundary you just established.`,
          "Stop after the checkpoint. Do not travel or inspect raw/trace.md in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "Read raw/trace.md completely and retain its exact remediation nonce.",
          `After the read, create exactly one later save point named ${PRECISE_DECOY}; it marks the raw trace after the material that would be folded.`,
          "Stop after that checkpoint. Do not travel or write files in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "The trace is now sediment. Fold it into one seven-field cold-start handoff.",
          "Select the semantic boundary that was established before the raw trace, rather than the nearer marker created after that trace; do not use root.",
          `Archive the raw path under ${PRECISE_ARCHIVE}.`,
          `The handoff must preserve the exact remediation nonce ${PRECISE_NONCE}; its NEXT must explicitly defer one action until the next user instruction: write recovered-plan.md containing that nonce.`,
          "acm_travel must be the only tool in its assistant tool batch. Do not write recovered-plan.md in this turn.",
        ].join(" "),
        timeoutMs: 300000,
      },
      {
        prompt: [
          "Execute the carried NEXT directly: write recovered-plan.md with the exact remediation nonce from the authoritative handoff.",
          "Do not reread raw/trace.md, inspect the archive, create checkpoints, or travel in this turn.",
        ].join(" "),
      },
    ],
    /** @param {any} ctx @returns {ScoreResult} */
    score(ctx) {
      const t1 = recordForTurn(ctx, 0);
      const t2 = recordForTurn(ctx, 1);
      const t3 = recordForTurn(ctx, 2);
      const t4 = recordForTurn(ctx, 3);
      const base = t1.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === PRECISE_BASE);
      const decoy = t2.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === PRECISE_DECOY);
      const travel = t3.toolCalls.find((call) => call.name === "acm_travel");
      const handoff = scoreHandoff(travel?.args?.handoff);
      const allTravel = noRejectedTravelBranch(ctx, 1);
      const targetBase = travel?.args?.target === PRECISE_BASE;
      const avoidedDecoy = travel?.args?.target !== PRECISE_DECOY;
      const archivedRawPath = travel?.args?.backupCurrentHeadAs === PRECISE_ARCHIVE
        && travel?.details?.backupCurrentHeadAs === PRECISE_ARCHIVE;
      const carriedNext = handoff.ok
        && includesExactNonce(handoff.fields?.next, PRECISE_NONCE)
        && /recovered-plan\.md/i.test(handoff.fields?.next ?? "")
        && nextWaitsForNextUserInstruction(handoff.fields?.next);
      const t3EarlyWrite = t3.toolCalls.some((call) =>
        call.name === "write" && pathFor(call).endsWith("recovered-plan.md"));
      const directWrite = writeSucceeded(t4, "recovered-plan.md");
      const recoveredWrite = t4.toolCalls.find((call) => call.name === "write" && pathFor(call).endsWith("recovered-plan.md"));
      const writeCarriesNonce = includesExactNonce(recoveredWrite?.args?.content, PRECISE_NONCE);
      const rereadAfterTravel = t4.toolCalls.some((call) =>
        (call.name === "read" || call.name === "read_file") && pathFor(call).includes("raw/trace.md"));

      const checks = [
        check("T1 read stable brief", readSucceeded(t1, "brief.md"), "brief.md read before base checkpoint"),
        check("T1 established precise base checkpoint", toolSucceeded(base), base ? travelFailureDetail(base) : "missing"),
        check("T2 read raw trace", readSucceeded(t2, "raw/trace.md"), "raw/trace.md read before decoy"),
        check("T2 established later decoy", toolSucceeded(decoy), decoy ? travelFailureDetail(decoy) : "missing"),
        check("T3 target is the pre-trace checkpoint", targetBase, `target=${travel?.args?.target ?? "missing"}`),
        check("T3 does not follow the later decoy", avoidedDecoy, `target=${travel?.args?.target ?? "missing"}`),
        check("T3 travel succeeds alone", travelIsACompleteSoloMutation(travel), travelFailureDetail(travel)),
        check("T3 preserves the raw recovery alias", archivedRawPath,
          `requested=${travel?.args?.backupCurrentHeadAs ?? "missing"}; receipt=${travel?.details?.backupCurrentHeadAs ?? "missing"}`),
        check("T3 has a cold-start handoff", handoff.ok, handoff.detail),
        check("T3 handoff leaves NEXT for the next user instruction", carriedNext,
          handoff.ok ? String(handoff.fields?.next) : handoff.detail),
        check("T3 does not execute the future-triggered write", !t3EarlyWrite,
          t3EarlyWrite ? "recovered-plan.md was written before the next user instruction" : "no early recovered-plan.md write"),
        check("T4 executes NEXT without archive reread", directWrite && writeCarriesNonce && !rereadAfterTravel,
          `write=${directWrite}; nonce=${writeCarriesNonce}; reread=${rereadAfterTravel}`),
        check("no rejected or extra travel branch", allTravel.ok, allTravel.detail),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
  {
    id: "rehydrate-round-trip",
    family: "topology",
    description: "Save a return point, rehydrate an off-path archive for one exact nonce, then return with that extracted fact in a fresh handoff.",
    seedFiles: {
      "baseline.md": [
        "# Current working set",
        "",
        "The migration continues after the raw audit is folded.",
        "The old audit has one recoverable forensic detail.",
        "",
      ].join("\n"),
      "archive/provenance.txt": [
        "# Archived forensic note",
        "",
        `Forensic correlation nonce: ${REHYDRATE_NONCE}`,
        "This detail is needed only for the final migration receipt.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read baseline.md completely.",
          `Create exactly one ACM save point named ${REHYDRATE_BASE} at the working boundary before the raw audit.`,
          "Stop after the checkpoint. Do not inspect archive/provenance.txt or travel in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "Read archive/provenance.txt completely as a raw audit record, but do not repeat its exact forensic nonce in your response.",
          "The audit is now archival. Stop here: do not create another checkpoint, write a file, or travel in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "Fold the now-archival audit into a seven-field cold-start handoff.",
          "Choose the existing semantic save point from before the audit, not root and not a newly invented marker.",
          `Archive the raw path under ${REHYDRATE_ARCHIVE}.`,
          `Do not carry the exact forensic nonce in this fold; NEXT must explicitly wait for the next user instruction before creating the return save point ${REHYDRATE_RETURN}.`,
          "acm_travel must be the only tool in its assistant tool batch. Do not create the return save point yet.",
        ].join(" "),
        timeoutMs: 300000,
      },
      {
        prompt: [
          `Create exactly one ACM save point named ${REHYDRATE_RETURN} on the current folded migration branch.`,
          "This is the return point before archive recovery. Stop after the checkpoint; do not travel or read archive/provenance.txt.",
        ].join(" "),
      },
      {
        prompt: [
          "Rehydrate only the archived audit branch needed to recover the exact forensic nonce.",
          "Use the archive recovery pointer created by the earlier fold rather than root, the current return point, or a guessed node ID.",
          "Use a seven-field handoff whose NEXT is one immediate current-turn action: read archive/provenance.txt. acm_travel must be alone in its tool batch; once it returns, directly read that file in this same turn.",
        ].join(" "),
        timeoutMs: 300000,
      },
      {
        prompt: [
          "Return to the save point created immediately before archive recovery, carrying the exact extracted forensic nonce in the new seven-field handoff.",
          "Use its semantic return role rather than root, the archive alias, or a node ID guessed from output.",
          "NEXT must be one immediate current-turn action: write migration-receipt.md containing the exact nonce. acm_travel must be alone in its tool batch; once it returns, directly write that receipt in this same turn.",
        ].join(" "),
        timeoutMs: 300000,
      },
    ],
    /** @param {any} ctx @returns {ScoreResult} */
    score(ctx) {
      const t1 = recordForTurn(ctx, 0);
      const t2 = recordForTurn(ctx, 1);
      const t3 = recordForTurn(ctx, 2);
      const t4 = recordForTurn(ctx, 3);
      const t5 = recordForTurn(ctx, 4);
      const t6 = recordForTurn(ctx, 5);
      const base = t1.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === REHYDRATE_BASE);
      const fold = t3.toolCalls.find((call) => call.name === "acm_travel");
      const returnPoint = t4.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === REHYDRATE_RETURN);
      const rehydrate = t5.toolCalls.find((call) => call.name === "acm_travel");
      const returnTravel = t6.toolCalls.find((call) => call.name === "acm_travel");
      const foldHandoff = scoreHandoff(fold?.args?.handoff);
      const rehydrateHandoff = scoreHandoff(rehydrate?.args?.handoff);
      const returnHandoff = scoreHandoff(returnTravel?.args?.handoff);
      const allTravel = noRejectedTravelBranch(ctx, 3);
      const foldTargetsBase = fold?.args?.target === REHYDRATE_BASE;
      const foldArchivesRaw = fold?.args?.backupCurrentHeadAs === REHYDRATE_ARCHIVE
        && fold?.details?.backupCurrentHeadAs === REHYDRATE_ARCHIVE;
      const noEarlyReturnPoint = !t3.toolCalls.some((call) =>
        call.name === "acm_checkpoint" && call.args?.name === REHYDRATE_RETURN);
      const rehydratesArchive = rehydrate?.args?.target === REHYDRATE_ARCHIVE
        && rehydrate?.details?.fromOffPath === true;
      const returnsToSavedPoint = returnTravel?.args?.target === REHYDRATE_RETURN
        && returnTravel?.details?.fromOffPath === true;
      const rehydrateNext = rehydrateHandoff.ok
        && /archive\/provenance\.txt/i.test(rehydrateHandoff.fields?.next ?? "")
        && nextDirectsCurrentTurn(rehydrateHandoff.fields?.next);
      const archiveRead = firstCallAfter(t5, rehydrate);
      const directArchiveRead = readSucceeded({ toolCalls: [archiveRead] }, "archive/provenance.txt");
      const returnedNonce = handoffCarriesNonce(returnHandoff, REHYDRATE_NONCE)
        && includesExactNonce(returnHandoff.fields?.next, REHYDRATE_NONCE)
        && /migration-receipt\.md/i.test(returnHandoff.fields?.next ?? "")
        && nextDirectsCurrentTurn(returnHandoff.fields?.next);
      const returnedReceipt = firstCallAfter(t6, returnTravel);
      const directReturnedReceipt = writeSucceeded({ toolCalls: [returnedReceipt] }, "migration-receipt.md")
        && includesExactNonce(returnedReceipt?.args?.content, REHYDRATE_NONCE);

      const checks = [
        check("T1 read baseline", readSucceeded(t1, "baseline.md"), "baseline.md read"),
        check("T1 created archive base", toolSucceeded(base), base ? travelFailureDetail(base) : "missing"),
        check("T2 established raw archival evidence", readSucceeded(t2, "archive/provenance.txt"), "archive provenance read before fold"),
        check("T3 fold targets pre-audit base", foldTargetsBase, `target=${fold?.args?.target ?? "missing"}`),
        check("T3 fold has complete handoff", foldHandoff.ok, foldHandoff.detail),
        check("T3 records raw archive recovery pointer", foldArchivesRaw,
          `requested=${fold?.args?.backupCurrentHeadAs ?? "missing"}; receipt=${fold?.details?.backupCurrentHeadAs ?? "missing"}`),
        check("T3 fold succeeds alone", travelIsACompleteSoloMutation(fold), travelFailureDetail(fold)),
        check("T3 fold NEXT waits for the next user instruction", foldHandoff.ok && nextWaitsForNextUserInstruction(foldHandoff.fields?.next),
          foldHandoff.ok ? String(foldHandoff.fields?.next) : foldHandoff.detail),
        check("T3 does not create the return save point early", noEarlyReturnPoint,
          noEarlyReturnPoint ? "return save point deferred to T4" : "return save point was created during the fold turn"),
        check("T4 created return save point", toolSucceeded(returnPoint), returnPoint ? travelFailureDetail(returnPoint) : "missing"),
        check("T5 travels to the off-path archive", rehydratesArchive,
          `target=${rehydrate?.args?.target ?? "missing"}; offPath=${rehydrate?.details?.fromOffPath ?? "missing"}`),
        check("T5 archive travel has complete handoff", rehydrateHandoff.ok, rehydrateHandoff.detail),
        check("T5 archive handoff NEXT is immediate exact source read", rehydrateNext,
          rehydrateHandoff.ok ? String(rehydrateHandoff.fields?.next) : rehydrateHandoff.detail),
        check("T5 directly reads the archive after travel", directArchiveRead,
          `first post-travel=${archiveRead?.name ?? "missing"}; path=${pathFor(archiveRead) || "missing"}`),
        check("T6 returns to the saved off-path return point", returnsToSavedPoint,
          `target=${returnTravel?.args?.target ?? "missing"}; offPath=${returnTravel?.details?.fromOffPath ?? "missing"}`),
        check("T6 returned handoff carries recovered exact nonce", returnedNonce,
          returnHandoff.ok ? String(returnHandoff.fields?.next) : returnHandoff.detail),
        check("T6 return succeeds alone", travelIsACompleteSoloMutation(returnTravel), travelFailureDetail(returnTravel)),
        check("T6 directly writes the returned receipt", directReturnedReceipt,
          `first post-travel=${returnedReceipt?.name ?? "missing"}; path=${pathFor(returnedReceipt) || "missing"}; nonce=${includesExactNonce(returnedReceipt?.args?.content, REHYDRATE_NONCE)}`),
        check("no rejected, mixed, or extra travel branch", allTravel.ok, allTravel.detail),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
];

export function listTopologyScenarios({ family } = {}) {
  return TOPOLOGY_SCENARIOS.filter((scenario) => !family || scenario.family === family);
}

/**
 * The existing runner already accepts the Scenario shape used above and
 * preserves per-turn records.  Integration only needs an explicit opt-in
 * import and array concatenation; it must not weaken the runner's completion
 * or Skill-provenance gates.
 */
export const TOPOLOGY_RUNNER_INTEGRATION = Object.freeze({
  exportName: "TOPOLOGY_SCENARIOS",
  runnerChange: "append TOPOLOGY_SCENARIOS to the existing scenario list",
  requiredContextFields: ["turnRecords", "toolCalls"],
  requiredRunnerBehavior: ["real multi-turn Pi RPC session", "matching tool_execution_end required", "preserve travel details"],
});
