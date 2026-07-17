// Live ACM behavior scenarios. Each scenario drives a real Pi RPC session
// against the local extension and scores observable tool calls + handoff shape.

/** @typedef {{
 *   id: string,
 *   family: string,
 *   description: string,
 *   thinkingLevel?: string,
 *   turns: Array<{ prompt: string, timeoutMs?: number }>,
 *   seedFiles?: Record<string, string>,
 *   score: (ctx: ScenarioContext) => ScoreResult,
 * }} Scenario */

/** @typedef {{
 *   events: object[],
 *   toolCalls: Array<{ name: string, args: any, resultText?: string, isError?: boolean }>,
 *   assistantTexts: string[],
 * }} ScenarioContext */

/** @typedef {{
 *   pass: boolean,
 *   checks: Array<{ name: string, pass: boolean, detail: string }>,
 * }} ScoreResult */

const HANDOFF_SLOTS = ["Goal", "State", "Evidence", "External", "Exclusions", "Recover", "NEXT"];

export function extractToolCalls(events) {
  /** @type {Array<{ name: string, args: any, resultText?: string, isError?: boolean }>} */
  const calls = [];
  const byId = new Map();
  for (const event of events) {
    if (event.type === "tool_execution_start") {
      const entry = {
        name: event.toolName,
        args: event.args ?? event.arguments ?? {},
        toolCallId: event.toolCallId,
      };
      byId.set(event.toolCallId, entry);
      calls.push(entry);
    } else if (event.type === "tool_execution_end") {
      const entry = byId.get(event.toolCallId) ?? calls.find((c) => c.name === event.toolName);
      if (entry) {
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
  return calls;
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

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

function scoreHandoff(summary) {
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, missing: [...HANDOFF_SLOTS], detail: "empty summary" };
  }
  const lines = summary.split(/\r?\n/);
  const found = [];
  for (const slot of HANDOFF_SLOTS) {
    const line = lines.find((l) => l.startsWith(`${slot}:`));
    if (!line) continue;
    const value = line.slice(slot.length + 1).trim();
    if (value.length > 0) found.push(slot);
  }
  const missing = HANDOFF_SLOTS.filter((s) => !found.includes(s));
  return {
    ok: missing.length === 0,
    missing,
    detail: missing.length === 0 ? "all seven slots present and non-empty" : `missing: ${missing.join(", ")}`,
  };
}

function pickTravel(toolCalls) {
  const travels = toolCalls.filter((c) => c.name === "acm_travel");
  return [...travels].reverse().find((c) => !c.isError && !c.details?.error) ?? travels.at(-1);
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
        pass: Boolean(timeline) && !timeline.isError,
        checks: [
          check("called acm_timeline", Boolean(timeline), timeline ? "called" : "missing"),
          check("timeline succeeded", timeline && !timeline.isError, timeline?.isError ? "error" : "ok"),
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
        pass: Boolean(cp) && !cp.isError && name === "baseline-before-refactor",
        checks: [
          check("called acm_checkpoint", Boolean(cp), cp ? "called" : "missing"),
          check("correct name", name === "baseline-before-refactor", `name=${name ?? "none"}`),
          check("checkpoint succeeded", cp && !cp.isError, cp?.isError ? "error" : "ok"),
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
        pass: Boolean(cp) && !cp.isError && !traveled && (cpBeforeEdit || !edited),
        checks: [
          check("saved before risk", Boolean(cp), cp ? `name=${cp.args?.name}` : "no checkpoint"),
          check("checkpoint before edit", cpBeforeEdit, cpBeforeEdit ? "order ok" : "edit preceded save or no save"),
          check("did not travel", !traveled, traveled ? "unexpected travel" : "no travel"),
          check("checkpoint succeeded", !cp || !cp.isError, cp?.isError ? "error" : "ok"),
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
          "Write a cold-start seven-slot handoff from the findings.",
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
      const handoff = scoreHandoff(travel?.args?.summary ?? "");
      const alone = travel && !travel.isError && travel.details?.error !== "mixed_tool_batch";
      return {
        pass: Boolean(cp) && Boolean(travel) && !travel.isError && handoff.ok && alone,
        checks: [
          check("checkpoint created", Boolean(cp) && !cp?.isError, cp ? "ok" : "missing"),
          check("called acm_travel", travels.length > 0, travels.length ? `${travels.length} attempt(s)` : "missing"),
          check("travel succeeded", travel && !travel.isError, travel?.isError ? (travel.resultText ?? "error") : "ok"),
          check("seven-slot handoff", handoff.ok, handoff.detail),
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
      const handoff = scoreHandoff(travel?.args?.summary ?? "");
      const readInvestigation = ctx.toolCalls.some((c) =>
        (c.name === "read" || c.name === "read_file")
        && String(c.args?.path ?? c.args?.file_path ?? "").includes("investigation.md"));
      return {
        pass: Boolean(travel) && !travel.isError && handoff.ok,
        checks: [
          check("read the distilled notes", readInvestigation, readInvestigation ? "read" : "skipped"),
          check("created a save point", Boolean(cp), cp ? `name=${cp.args?.name}` : "none"),
          check("called acm_travel", Boolean(travel), travel ? "called" : "missing — doctrine failed"),
          check("travel succeeded", travel && !travel.isError, travel?.isError ? (travel.resultText?.slice(0, 200) ?? "error") : "ok"),
          check("cold-start handoff", handoff.ok, handoff.detail),
        ],
      };
    },
  },
  {
    id: "pressure-keep-live-uncertainty",
    family: "judgment",
    description: "High pressure with open uncertainty — must NOT travel; correctness wins.",
    turns: [{
      prompt: [
        "ACM working-budget pressure is about 70%.",
        "You are mid-debug: four traces disagree about which worker owns a lock,",
        "and the next concrete action is to compare timestamps in src/lock.ts.",
        "A checkpoint lock-hunt-start already exists.",
        "Decide whether to acm_travel now. Then take the next useful action.",
        "Do not invent file contents — if you need the file, read it.",
      ].join(" "),
    }],
    seedFiles: {
      "src/lock.ts": "export const owners = ['a', 'b', 'c', 'd'];\n",
    },
    score(ctx) {
      const traveled = ctx.toolCalls.some((c) => c.name === "acm_travel");
      const continued = ctx.toolCalls.some((c) => c.name === "read" || c.name === "read_file" || c.name === "grep" || c.name === "bash")
        || ctx.assistantTexts.some((t) => /lock|timestamp|compar/i.test(t));
      return {
        pass: !traveled && continued,
        checks: [
          check("did not travel under open uncertainty", !traveled, traveled ? "incorrectly traveled" : "held travel"),
          check("continued the investigation", continued, continued ? "continued" : "stalled"),
        ],
      };
    },
  },
];

export function listScenarios({ family } = {}) {
  return SCENARIOS.filter((s) => !family || s.family === family);
}
