// Live ACM behavior scenarios. Each scenario drives a real Pi RPC session
// against the local extension and scores observable tool calls + handoff shape.

import { join } from "node:path";
import { CONTEXT_MANAGEMENT_SKILL_PATH } from "./setup.mjs";
import { BEHAVIOR_SCENARIOS } from "./behavior-scenarios.mjs";
import { TOPOLOGY_SCENARIOS } from "./topology-scenarios.mjs";

export { CONTEXT_MANAGEMENT_SKILL_PATH };

/** @typedef {{
 *   id: string,
 *   family: string,
 *   description: string,
 *   thinkingLevel?: string,
 *   turns: Array<{ prompt: string, timeoutMs?: number }>,
 *   seedFiles?: Record<string, string>,
 *   score: (ctx: ScenarioContext) => ScoreResult | Promise<ScoreResult>,
 * }} Scenario */

/** @typedef {{
 *   events: object[],
 *   toolCalls: Array<{ name: string, args: any, resultText?: string, isError?: boolean, details?: any, completed?: boolean }>,
 *   assistantTexts: string[],
 *   turnRecords?: Array<{ events: object[], toolCalls: Array<{ name: string, args: any, resultText?: string, isError?: boolean, details?: any }>, assistantTexts: string[] }>,
 *   environmentMode?: "core-only" | "product-isolated" | "full-env",
 *   workspace?: string,
 * }} ScenarioContext */

/** @typedef {{
 *   pass: boolean,
 *   checks: Array<{ name: string, pass: boolean, detail: string }>,
 * }} ScoreResult */

const HANDOFF_FIELDS = ["goal", "state", "evidence", "external", "exclusions", "recover", "next"];
export const TARGET_SELECTION_REFERENCE_PATH = join(
  CONTEXT_MANAGEMENT_SKILL_PATH,
  "..",
  "references",
  "target-selection.md",
);

export function extractTranscriptSegments(events) {
  /** @type {Array<{ name: string, args: any, resultText?: string, isError?: boolean, completed: boolean }>} */
  const calls = [];
  const segments = [];
  const byId = new Map();
  for (const event of events) {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) segments.push({ kind: "assistant_text", text });
    } else if (event.type === "tool_execution_start") {
      const entry = {
        name: event.toolName,
        args: event.args ?? event.arguments ?? {},
        toolCallId: event.toolCallId,
        completed: false,
      };
      byId.set(event.toolCallId, entry);
      calls.push(entry);
      segments.push({ kind: "tool", call: entry });
    } else if (event.type === "tool_execution_end") {
      const entry = byId.get(event.toolCallId) ?? calls.find((c) => c.name === event.toolName);
      if (entry) {
        entry.completed = true;
        entry.isError = event.isError === true;
        const text = Array.isArray(event.result?.content)
          ? event.result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
          : typeof event.result === "string"
            ? event.result
            : "";
        entry.resultText = text;
        if (event.result?.details) entry.details = event.result.details;
      }
    }
  }
  return segments;
}

export function extractToolCalls(events) {
  return extractTranscriptSegments(events)
    .filter((segment) => segment.kind === "tool")
    .map((segment) => segment.call);
}

export function extractAssistantTexts(events) {
  return events
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => (e.message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""))
    .filter(Boolean);
}

export function extractAssistantTranscript(events) {
  return extractAssistantTexts(events).join("\n\n");
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

/**
 * A tool event can transport a domain failure in result.details without being
 * marked as an RPC-level error. Treat both channels as the observable success
 * contract, so a rejected travel is never credited as a completed fold.
 */
export function toolSucceeded(call) {
  return Boolean(call) && call.completed === true && call.isError !== true && !call.details?.error;
}

export function scoreHandoff(handoff) {
  let decoded = handoff;
  if (typeof handoff === "string") {
    try {
      decoded = JSON.parse(handoff);
    } catch {
      return { ok: false, missing: [...HANDOFF_FIELDS], detail: "invalid JSON-encoded structured handoff" };
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, missing: [...HANDOFF_FIELDS], detail: "missing structured handoff" };
  }
  const missing = HANDOFF_FIELDS.filter((field) => typeof decoded[field] !== "string" || decoded[field].trim().length === 0);
  const invalidAuthoritative = ["goal", "state", "next"].filter((field) =>
    typeof decoded[field] === "string" && decoded[field].trim().toLowerCase() === "none");
  const extra = Object.keys(decoded).filter((field) => !HANDOFF_FIELDS.includes(field));
  const ok = missing.length === 0 && invalidAuthoritative.length === 0 && extra.length === 0;
  return {
    ok,
    missing,
    invalidAuthoritative,
    extra,
    ...(ok ? { fields: decoded } : {}),
    detail: missing.length > 0
      ? `missing: ${missing.join(", ")}`
      : invalidAuthoritative.length > 0
        ? `none not allowed: ${invalidAuthoritative.join(", ")}`
        : extra.length > 0
          ? `unexpected fields: ${extra.join(", ")}`
          : "all seven structured fields present",
  };
}

export function pickTravel(toolCalls) {
  const travels = toolCalls.filter((c) => c.name === "acm_travel");
  return [...travels].reverse().find(toolSucceeded) ?? travels.at(-1);
}

function toolPath(call) {
  return String(call?.args?.path ?? call?.args?.file_path ?? call?.args?.file ?? "");
}

function isReadOf(call, pathFragment) {
  return (call?.name === "read" || call?.name === "read_file") && toolPath(call).includes(pathFragment);
}

function successfullyRead(call, pathFragment) {
  return toolSucceeded(call) && isReadOf(call, pathFragment);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A bash command is an advanced-guidance load only when a reader command
 * directly receives the exact runtime-provided path. Discovery (`find`) and
 * prose/echo references deliberately do not establish that the file was read.
 */
function bashReadsExactPath(call, path) {
  if (!toolSucceeded(call) || call?.name !== "bash") return false;
  const command = String(call.args?.command ?? call.args?.script ?? call.args?.cmd ?? "");
  const pathToken = new RegExp(`(^|[\\s"'])${escapeRegExp(path)}(?=$|[\\s"'])`, "g");
  return command
    .split(/[;|&\n]+/)
    .some((segment) => {
      if (!/^\s*(?:command\s+)?(?:cat|sed|head|tail|awk)\b/i.test(segment)) return false;
      for (const match of segment.matchAll(pathToken)) {
        const pathStart = (match.index ?? 0) + match[1].length;
        const beforePath = segment.slice(0, pathStart);
        if (!/>{1,2}\s*$/.test(beforePath)) return true;
      }
      return false;
    });
}

function successfullyLoadedGuidance(call, path) {
  return successfullyRead(call, path) || bashReadsExactPath(call, path);
}

function probesAdvancedGuidance(call) {
  if (!call || !["read", "read_file", "find", "grep", "bash", "ls"].includes(call.name)) return false;
  const payload = JSON.stringify(call.args ?? {}).toLowerCase();
  return payload.includes("context-management")
    || payload.includes("target-selection")
    || payload.includes("skills.md")
    || payload.includes("/skills/")
    || payload.includes("references/");
}

function recordForTurn(ctx, index) {
  return ctx.turnRecords?.[index] ?? { events: [], toolCalls: [], assistantTexts: [] };
}

function textForTurn(ctx, index) {
  return recordForTurn(ctx, index).assistantTexts.join("\n");
}

function containsRequiredFacts(value) {
  const text = String(value ?? "");
  const normalized = text
    .replace(/[^a-zA-Z0-9./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const poolMax = /\bpool max(?: [a-z]+){0,3} 50\b/.test(normalized);
  const retrySemantic = /\bretry\b/.test(normalized);
  const commit = /\bcommit\b/.test(normalized) && /\b9f31c2a\b/.test(normalized);
  const nextFile = normalized.includes("services/payments/client.ts");
  return poolMax && retrySemantic && commit && nextFile;
}

function containsRequiredNextFacts(value) {
  return String(value ?? "").includes("next-action.md") && containsRequiredFacts(value);
}

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: "directed-timeline",
    family: "mechanics",
    description: "Explicitly asked to orient via acm_timeline.",
    turns: [{
      prompt: 'Call acm_timeline with view "active". Then reply with one short sentence about what the HUD reported.',
    }],
    score(ctx) {
      const timeline = ctx.toolCalls.find((c) => c.name === "acm_timeline");
      return {
        pass: toolSucceeded(timeline),
        checks: [
          check("called acm_timeline", Boolean(timeline), timeline ? "called" : "missing"),
          check("timeline succeeded", toolSucceeded(timeline), !timeline ? "missing" : timeline.details?.error ?? (timeline.isError ? "error" : "ok")),
        ],
      };
    },
  },
  {
    id: "directed-checkpoint",
    family: "mechanics",
    description: "Explicitly asked to create a semantic save point.",
    turns: [{
      prompt: [
        "Create an ACM save point named baseline-before-refactor on the current meaningful turn.",
        "Do not travel. After the tool returns, reply with one sentence confirming the checkpoint name.",
      ].join(" "),
    }],
    score(ctx) {
      const cp = ctx.toolCalls.find((c) => c.name === "acm_checkpoint");
      const name = cp?.args?.name;
      return {
        pass: toolSucceeded(cp) && name === "baseline-before-refactor",
        checks: [
          check("called acm_checkpoint", Boolean(cp), cp ? "called" : "missing"),
          check("correct name", name === "baseline-before-refactor", `name=${name ?? "none"}`),
          check("checkpoint succeeded", toolSucceeded(cp), !cp ? "missing" : cp.details?.error ?? (cp.isError ? "error" : "ok")),
          check("did not travel", !ctx.toolCalls.some((c) => c.name === "acm_travel"), "travel absent"),
        ],
      };
    },
  },
  {
    id: "spontaneous-checkpoint-before-risk",
    family: "judgment",
    description: "Risky edit request — agent should save before mutating without being told the tool name.",
    seedFiles: {
      "src/parser.ts": [
        "export function parse(input: string): number {",
        "  // naive parser — baseline is known-good",
        "  return Number(input);",
        "}",
        "",
      ].join("\n"),
    },
    turns: [{
      prompt: [
        "The current parser in src/parser.ts is a verified baseline.",
        "I want you to try a more aggressive rewrite that may break callers.",
        "Protect recoverability first, then make a small edit to src/parser.ts that adds a TODO comment.",
        "Do not fold or travel yet.",
      ].join(" "),
    }],
    score(ctx) {
      const cp = ctx.toolCalls.find((c) => c.name === "acm_checkpoint");
      const edited = ctx.toolCalls.some((c) => c.name === "edit" || c.name === "write");
      const traveled = ctx.toolCalls.some((c) => c.name === "acm_travel");
      const cpBeforeEdit = (() => {
        if (!cp || !edited) return Boolean(cp);
        const cpIndex = ctx.toolCalls.indexOf(cp);
        const editIndex = ctx.toolCalls.findIndex((c) => c.name === "edit" || c.name === "write");
        return cpIndex >= 0 && editIndex >= 0 && cpIndex < editIndex;
      })();
      return {
        pass: toolSucceeded(cp) && !traveled && (cpBeforeEdit || !edited),
        checks: [
          check("saved before risk", Boolean(cp), cp ? `name=${cp.args?.name}` : "no checkpoint"),
          check("checkpoint before edit", cpBeforeEdit, cpBeforeEdit ? "order ok" : "edit preceded save or no save"),
          check("did not travel", !traveled, traveled ? "unexpected travel" : "no travel"),
          check("checkpoint succeeded", !cp || toolSucceeded(cp), cp?.details?.error ?? (cp?.isError ? "error" : "ok")),
        ],
      };
    },
  },
  {
    id: "directed-travel-handoff",
    family: "mechanics",
    description: "Explicit fold with a seven-slot handoff; must run alone and pass cold-start shape.",
    seedFiles: {
      "findings.md": [
        "# Latency hunt",
        "",
        "Settled: DB indexes healthy; query times flat vs 2026-07-01 baseline.",
        "Open: pool exhaustion vs payments retry loop added in v2.3.0.",
        "Hot: pool max=50 in config/prod.yaml:23; retry commit 9f31c2a.",
        "Next: read services/payments/client.ts backoff bounds.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "First create a save point named latency-hunt-scan.",
          "Then stop — do not travel in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "The latency investigation findings in findings.md are distilled.",
          "Fold the raw process away with acm_travel targeting latency-hunt-scan.",
          "Fill the structured cold-start handoff fields from the findings.",
          "Backup the current head as latency-hunt-raw.",
          "acm_travel must be alone in its tool batch.",
          "After travel succeeds, reply with one sentence stating the NEXT action.",
        ].join(" "),
        timeoutMs: 300000,
      },
    ],
    score(ctx) {
      const cp = ctx.toolCalls.find((c) => c.name === "acm_checkpoint" && c.args?.name === "latency-hunt-scan");
      const travels = ctx.toolCalls.filter((c) => c.name === "acm_travel");
      const travel = pickTravel(ctx.toolCalls);
      const handoff = scoreHandoff(travel?.args?.handoff);
      const travelSucceeded = toolSucceeded(travel);
      const alone = travelSucceeded && travel.details?.error !== "mixed_tool_batch";
      return {
        pass: toolSucceeded(cp) && travelSucceeded && handoff.ok && alone,
        checks: [
          check("checkpoint created", toolSucceeded(cp), cp ? cp.details?.error ?? "ok" : "missing"),
          check("called acm_travel", travels.length > 0, travels.length ? `${travels.length} attempt(s)` : "missing"),
          check("travel succeeded", travelSucceeded, travel?.details?.error ?? (travel?.isError ? (travel.resultText ?? "error") : "ok")),
          check("structured handoff", handoff.ok, handoff.detail),
          check("travel alone / not mixed", alone, alone ? "ok" : "mixed or failed"),
          check("backup named", travel?.args?.backupCurrentHeadAs === "latency-hunt-raw",
            `backup=${travel?.args?.backupCurrentHeadAs ?? "none"}`),
        ],
      };
    },
  },
  {
    id: "spontaneous-fold-after-distill",
    family: "judgment",
    description: "After a distilled investigation, agent should weigh fold without being ordered to travel.",
    seedFiles: {
      "notes/investigation.md": [
        "Investigation closed.",
        "Cause: missing await in src/queue/worker.ts:88.",
        "Fix applied and tests green.",
        "Rejected: rewriting the whole queue module.",
        "Hot set: worker.ts:88, test/queue.test.ts.",
        "Nothing else remains in the raw search trail.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read notes/investigation.md.",
          "The investigation is finished and distilled; the raw search trail is sediment.",
          "Prepare recoverability, then compress the finished process into a working-set handoff so we can start an unrelated UI task next.",
          "Use your judgment about which ACM tools to call.",
        ].join(" "),
        timeoutMs: 360000,
      },
    ],
    score(ctx) {
      const cp = ctx.toolCalls.find((c) => c.name === "acm_checkpoint");
      const travel = pickTravel(ctx.toolCalls);
      const handoff = scoreHandoff(travel?.args?.handoff);
      const readInvestigation = ctx.toolCalls.some((c) =>
        (c.name === "read" || c.name === "read_file")
        && String(c.args?.path ?? c.args?.file_path ?? "").includes("investigation.md"));
      return {
        pass: toolSucceeded(travel) && handoff.ok,
        checks: [
          check("read the distilled notes", readInvestigation, readInvestigation ? "read" : "skipped"),
          check("created a save point", Boolean(cp), cp ? `name=${cp.args?.name}` : "none"),
          check("called acm_travel", Boolean(travel), travel ? "called" : "missing — doctrine failed"),
          check("travel succeeded", toolSucceeded(travel), travel?.details?.error ?? (travel?.isError ? (travel.resultText?.slice(0, 200) ?? "error") : "ok")),
          check("cold-start handoff", handoff.ok, handoff.detail),
        ],
      };
    },
  },
  {
    id: "pressure-keep-live-uncertainty",
    family: "judgment",
    description: "Pressure-framing probe (not a measured runtime-70% signal): live timestamp/owner uncertainty must stay live while investigation continues.",
    seedFiles: {
      "src/lock.ts": [
        "export const lockTraces = [",
        "  { owner: 'worker-a', timestamp: '2026-07-21T03:00:03.000Z', lock: 'payments' },",
        "  { owner: 'worker-b', timestamp: '2026-07-21T03:00:02.000Z', lock: 'payments' },",
        "  { owner: 'worker-c', timestamp: '2026-07-21T03:00:04.000Z', lock: 'payments' },",
        "  { owner: 'worker-d', timestamp: '2026-07-21T03:00:01.000Z', lock: 'payments' },",
        "] as const;",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read src/lock.ts, which contains four timestamp/owner traces that must be compared later.",
          "After reading it, create exactly one ACM save point named lock-hunt-start.",
          "Then stop this turn. Do not travel, compare the traces, or resolve the owner yet.",
        ].join(" "),
      },
      {
        prompt: [
          "This is a pressure-framing probe, not a measured runtime 70% context signal.",
          "The four timestamp/owner traces still disagree, so the ownership uncertainty remains live.",
          "Do not acm_travel: continue the investigation by directly comparing the timestamps in src/lock.ts.",
          "Do not merely restate the plan or invent contents; take the comparison action.",
        ].join(" "),
      },
    ],
    score(ctx) {
      const t1 = recordForTurn(ctx, 0);
      const t2 = recordForTurn(ctx, 1);
      const t1Read = t1.toolCalls.find((call) => successfullyRead(call, "src/lock.ts"));
      const checkpoint = t1.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === "lock-hunt-start");
      const t1ReadIndex = t1.toolCalls.indexOf(t1Read);
      const checkpointIndex = t1.toolCalls.indexOf(checkpoint);
      const checkpointAfterRead = t1ReadIndex >= 0 && checkpointIndex > t1ReadIndex;
      const t1Stopped = !t1.toolCalls.some((call) =>
        call.name === "acm_travel" || call.name === "write" || call.name === "edit" || call.name === "grep" || call.name === "bash");

      const travelAttempts = t2.toolCalls.filter((call) => call.name === "acm_travel");
      const travelApplied = travelAttempts.some(toolSucceeded);
      const continued = t2.toolCalls.some((call) => successfullyRead(call, "src/lock.ts"));
      return {
        pass: toolSucceeded(checkpoint) && checkpointAfterRead && t1Stopped && travelAttempts.length === 0 && !travelApplied && continued,
        checks: [
          check("T1 read four lock traces", Boolean(t1Read), t1Read ? "src/lock.ts read" : "src/lock.ts was not read"),
          check("T1 created lock-hunt-start checkpoint", toolSucceeded(checkpoint), checkpoint ? checkpoint.details?.error ?? "ok" : "missing lock-hunt-start"),
          check("T1 checkpoint followed lock read", checkpointAfterRead, checkpointAfterRead ? "order ok" : "checkpoint preceded lock read"),
          check("T1 stopped before investigation", t1Stopped, t1Stopped ? "stopped after checkpoint" : "continued beyond the requested save point"),
          check("T2 forbidden travel attempted", travelAttempts.length === 0,
            travelAttempts.length === 0 ? "no travel attempt" : `${travelAttempts.length} forbidden travel attempt(s)`),
          check("T2 forbidden travel applied", !travelApplied,
            travelApplied ? "a forbidden travel was applied" : "no travel applied"),
          check("T2 continued direct timestamp comparison", continued,
            continued ? "read src/lock.ts for direct comparison" : "did not continue the comparison investigation"),
        ],
      };
    },
  },
  {
    id: "structured-handoff-continuation-and-skill",
    family: "handoff-and-skill",
    description: "Three-turn contract: first-pass structured travel, direct continuation, then conditional advanced-Skill target reasoning.",
    seedFiles: {
      "findings.md": [
        "# Payments latency investigation",
        "",
        "Settled: DB indexes are healthy; query time is flat against the 2026-07-01 baseline.",
        "Open: pool exhaustion versus the payments retry loop introduced in commit 9f31c2a.",
        "Exact operational fact: pool max=50 in config/prod.yaml:23.",
        "Next action: inspect services/payments/client.ts backoff bounds.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read findings.md completely.",
          "Create exactly one ACM save point named payments-latency-findings after reading it.",
          "Then stop. Do not travel, write files, or start the next action in this turn.",
        ].join(" "),
      },
      {
        prompt: [
          "The investigation trail is now ready to fold.",
          "Your first acm_travel attempt must target root — the last clean point before this investigation — and use a seven-field structured handoff,",
          "and be the only action in its tool batch. Backup the current head as payments-latency-raw.",
          "Keep payments-latency-findings in Recover as the precise archived findings save point; it is recovery evidence, not this fold target.",
          "The handoff NEXT must be one action only: write next-action.md containing `pool max=50`,",
          "`retry commit=9f31c2a`, and `next file to inspect: services/payments/client.ts backoff bounds`.",
          "All facts needed for that write already belong in State/NEXT. Use direct carried facts or `none` in Evidence; do not name findings.md or another file as something to reread. External is `none`.",
          "Do not inspect that source file yet; this step only writes the carried action note.",
          "After a successful travel, make that write your first useful tool action directly.",
          "Do not reread findings.md, call acm_timeline, or inspect an archive before writing next-action.md.",
        ].join(" "),
        timeoutMs: 300000,
      },
      {
        prompt: [
          "Do not travel in this turn. We have an advanced target-selection ambiguity: a possible future rebase could use",
          "the oldest stable service baseline or the newer payments-latency-findings save point, but the surviving external",
          "rollback boundary and the next task's evidence needs are not yet known. Recommend what additional facts decide it.",
          "If the context-management advanced Skill is offered in this session, load it and its target-selection reference before answering.",
          "Use only the system-provided available Skills list to decide whether it is offered; absence from that list is conclusive.",
          "If it is absent, do not read Skill documentation or search the filesystem for it; hold the conservative no-travel position and state the missing facts.",
        ].join(" "),
      },
    ],
    score(ctx) {
      const t1 = recordForTurn(ctx, 0);
      const t2 = recordForTurn(ctx, 1);
      const t3 = recordForTurn(ctx, 2);
      const mode = ctx.environmentMode ?? "core-only";

      const t1Read = t1.toolCalls.some((call) => successfullyRead(call, "findings.md"));
      const checkpoint = t1.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === "payments-latency-findings");
      const t1ReadIndex = t1.toolCalls.findIndex((call) => successfullyRead(call, "findings.md"));
      const checkpointIndex = t1.toolCalls.indexOf(checkpoint);
      const t1ReadBeforeCheckpoint = t1ReadIndex >= 0 && checkpointIndex > t1ReadIndex;
      const t1Stopped = !t1.toolCalls.some((call) => call.name === "acm_travel" || call.name === "write" || call.name === "edit");

      const travels = t2.toolCalls.filter((call) => call.name === "acm_travel");
      const firstTravel = travels[0];
      const firstTravelSucceeded = toolSucceeded(firstTravel);
      const handoff = scoreHandoff(firstTravel?.args?.handoff);
      const exclusiveTravel = firstTravelSucceeded && firstTravel?.details?.error !== "mixed_tool_batch";
      const targetRoot = firstTravel?.args?.target === "root";
      const backupNamed = firstTravel?.args?.backupCurrentHeadAs === "payments-latency-raw";
      const handoffCarriesFacts = containsRequiredNextFacts(handoff.fields?.next);

      const firstTravelIndex = t2.toolCalls.indexOf(firstTravel);
      const postTravelCalls = firstTravelIndex >= 0 ? t2.toolCalls.slice(firstTravelIndex + 1) : [];
      const firstPostTravel = postTravelCalls[0];
      const directWrite = toolSucceeded(firstPostTravel)
        && firstPostTravel?.name === "write"
        && toolPath(firstPostTravel).endsWith("next-action.md");
      const writeCarriesFacts = directWrite && containsRequiredFacts(firstPostTravel?.args?.content);
      const requiredWriteIndex = postTravelCalls.findIndex((call) => call.name === "write" && toolPath(call).endsWith("next-action.md"));
      const beforeRequiredWrite = requiredWriteIndex < 0 ? postTravelCalls : postTravelCalls.slice(0, requiredWriteIndex);
      const inspectedBeforeNext = beforeRequiredWrite.some((call) =>
        ["read", "read_file", "find", "grep", "bash", "acm_timeline"].includes(call.name));

      const t3Travel = t3.toolCalls.some((call) => call.name === "acm_travel");
      const routerRead = t3.toolCalls.some((call) => successfullyLoadedGuidance(call, CONTEXT_MANAGEMENT_SKILL_PATH));
      const targetReferenceRead = t3.toolCalls.some((call) => successfullyLoadedGuidance(call, TARGET_SELECTION_REFERENCE_PATH));
      const advancedProbe = t3.toolCalls.some(probesAdvancedGuidance);
      const conservativeAnswer = /need|missing|uncertain|insufficient|hold|defer|not travel|no.travel|before deciding/i.test(textForTurn(ctx, 2));
      const skillMode = mode !== "core-only";
      const advancedGuidance = skillMode ? routerRead && targetReferenceRead : !advancedProbe;
      const t3Conservative = !t3Travel && conservativeAnswer;

      const checks = [
        check("T1 read findings", t1Read, t1Read ? "read" : "findings.md was not read"),
        check("T1 checkpoint created", toolSucceeded(checkpoint), checkpoint ? checkpoint.details?.error ?? "ok" : "missing payments-latency-findings"),
        check("T1 read before checkpoint", t1ReadBeforeCheckpoint, t1ReadBeforeCheckpoint ? "order ok" : "checkpoint preceded findings read"),
        check("T1 stopped before travel", t1Stopped, t1Stopped ? "no travel or write" : "continued past the requested stop"),
        check("T2 first travel attempt succeeded", firstTravelSucceeded,
          !firstTravel ? "missing" : firstTravel.details?.error ?? (firstTravel.isError ? "error" : "ok")),
        check("T2 structured handoff", handoff.ok, handoff.detail),
        check("T2 travel batch exclusive", exclusiveTravel, exclusiveTravel ? "not mixed" : "mixed or failed"),
        check("T2 chose the pre-investigation root boundary", targetRoot, `target=${firstTravel?.args?.target ?? "none"}`),
        check("T2 backup alias", backupNamed, `backup=${firstTravel?.args?.backupCurrentHeadAs ?? "none"}`),
        check("T2 handoff NEXT carries exact continuation", handoffCarriesFacts, handoffCarriesFacts ? "facts preserved" : "NEXT missed a required exact fact"),
        check("T2 direct first continuation write", directWrite, directWrite ? "next-action.md first" : "first post-travel action was not write next-action.md"),
        check("T2 write carries handoff facts", writeCarriesFacts, writeCarriesFacts ? "facts written" : "next-action.md missed a required exact fact"),
        check("T2 did not inspect before REQUIRED NEXT", !inspectedBeforeNext, inspectedBeforeNext ? "inspection occurred before the required write" : "direct continuation"),
        check("T3 no travel under ambiguity", !t3Travel, t3Travel ? "unexpected travel" : "held travel"),
        check(skillMode ? "T3 read product advanced guidance" : "T3 kept core-only isolation", advancedGuidance,
          skillMode
            ? `router=${routerRead} target-reference=${targetReferenceRead}`
            : `advanced-probe=${advancedProbe}`),
        check("T3 conservative target decision", t3Conservative, t3Conservative ? "held travel pending facts" : "missing conservative no-travel explanation"),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
  {
    id: "advanced-pointer-routing",
    family: "handoff-and-skill",
    description: "Timeline names the exact advanced resource for an ambiguous target; product mode should follow it without the user naming the Skill.",
    turns: [{
      prompt: [
        "Create one ACM save point named pointer-routing-base.",
        "Then call acm_timeline with view active before answering.",
        "A future fold target is ambiguous because interleaved fronts and a possibly missing older anchor make the nearest save point unreliable.",
        "Do not travel. If the timeline result names condition-specific advanced guidance that is offered in this session, load that guidance before stating what facts decide the target.",
        "If the named resource is not offered, do not search the filesystem for it; keep the conservative no-travel position and state the missing facts.",
      ].join(" "),
      timeoutMs: 300000,
    }],
    score(ctx) {
      const checkpoint = ctx.toolCalls.find((call) => call.name === "acm_checkpoint" && call.args?.name === "pointer-routing-base");
      const timeline = ctx.toolCalls.find((call) => call.name === "acm_timeline" && (call.args?.view ?? "active") === "active");
      const checkpointIndex = ctx.toolCalls.indexOf(checkpoint);
      const timelineIndex = ctx.toolCalls.indexOf(timeline);
      const timelineAfterCheckpoint = checkpointIndex >= 0 && timelineIndex > checkpointIndex;
      const routerRead = ctx.toolCalls.some((call) => successfullyLoadedGuidance(call, CONTEXT_MANAGEMENT_SKILL_PATH));
      const targetReferenceRead = ctx.toolCalls.some((call) => successfullyLoadedGuidance(call, TARGET_SELECTION_REFERENCE_PATH));
      const advancedProbe = ctx.toolCalls.some(probesAdvancedGuidance);
      const traveled = ctx.toolCalls.some((call) => call.name === "acm_travel");
      const skillMode = ctx.environmentMode !== "core-only";
      const routing = skillMode ? routerRead && targetReferenceRead : !advancedProbe;
      const conservativeAnswer = /missing|unknown|uncertain|need|before deciding|hold|defer|no.travel/i.test(ctx.assistantTexts.join("\n"));
      const checks = [
        check("checkpoint created", toolSucceeded(checkpoint), checkpoint ? checkpoint.details?.error ?? "ok" : "missing"),
        check("timeline followed checkpoint", toolSucceeded(timeline) && timelineAfterCheckpoint,
          timelineAfterCheckpoint ? "active timeline after save point" : "timeline missing or ran before checkpoint"),
        check("did not travel under ambiguity", !traveled, traveled ? "unexpected travel" : "held travel"),
        check(skillMode ? "followed exact advanced pointer" : "kept unavailable Skill isolated", routing,
          skillMode ? `router=${routerRead} target-reference=${targetReferenceRead}` : `advanced-probe=${advancedProbe}`),
        check("reported decision-changing missing facts", conservativeAnswer,
          conservativeAnswer ? "missing facts named" : "no conservative target rationale"),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
  ...BEHAVIOR_SCENARIOS,
  ...TOPOLOGY_SCENARIOS,
];

export function listScenarios({ family } = {}) {
  return SCENARIOS.filter((s) => !family || s.family === family);
}
