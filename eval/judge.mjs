// LLM-as-judge for the de-primed ACM activation flow.
//
// A fixed strong model reads the full transcript of a run and scores ACM
// behavior on six dimensions, with an attribution tag per dimension so that
// (a) the same model set can be compared across guidance/code versions, and
// (b) the same flow can rank different models by how well they self-manage
// context. Scoring is judgment, not a mechanical checklist — but the rubric
// is version-pinned so every comparison uses the same ruler.

import { PiRpcDriver } from "./driver.mjs";
import { renameSync, writeFileSync } from "node:fs";

export const JUDGE_MODEL = { provider: "local-claude", modelId: "claude-opus-4-8" };
// v3 is outcome-first. v2 treated any fold during an unfinished turn as a
// timing failure; v3 instead judges whether the handoff preserves that
// obligation and whether continuation actually degrades. v1/v2 scores are
// therefore not directly comparable with v3 scores.
export const RUBRIC_VERSION = "acm-outcome-v3";
export const RUBRIC_COMPARABILITY_NOTE = "v3 judges outcome rather than an unfinished-turn prohibition; v1/v2 scores are not directly comparable.";
export const HISTORICAL_RUBRIC_VERSIONS = Object.freeze(["acm-activation-v1", "acm-activation-v2"]);
export const KNOWN_RUBRIC_VERSIONS = Object.freeze([...HISTORICAL_RUBRIC_VERSIONS, RUBRIC_VERSION]);

export const JUDGE_DIMENSIONS = Object.freeze([
  "activation",
  "timing_and_measure",
  "handoff_quality",
  "recoverability",
  "ceiling",
  "task_completion",
]);
export const ATTRIBUTIONS = Object.freeze([
  "healthy",
  "never-activated",
  "event-driven-overfold",
  "negation-suppressed-inaction",
  "bad-handoff",
  "lost-recoverability",
  "anchor-gravity-wrong-target",
  "thrash",
  "task-degraded",
]);
export const MODEL_TIERS = Object.freeze(["weak", "mid", "strong"]);

const ACM_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);
const REQUIRED_VERDICT_KEYS = ["rubricVersion", "perPhase", "dimensions", "overall", "topAttributions"];
const REQUIRED_PHASE_KEYS = ["phase", "opportunityTaken", "action", "quality", "note"];
const REQUIRED_DIMENSION_KEYS = ["score", "attribution", "note"];
const REQUIRED_OVERALL_KEYS = ["score", "modelTier", "summary"];

/** Compact one-line summary of a non-ACM tool call's args. */
function summarizeArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  const pick = (k) => (args[k] === undefined ? undefined : String(args[k]));
  const path = pick("path") ?? pick("file_path") ?? pick("file");
  if (path) return path;
  const cmd = pick("command") ?? pick("cmd");
  if (cmd) return cmd.slice(0, 120);
  const pattern = pick("pattern") ?? pick("query");
  if (pattern) return `/${pattern}/`;
  const keys = Object.keys(args);
  return keys.length ? `${keys[0]}=${String(args[keys[0]]).slice(0, 60)}` : "";
}

/**
 * Render the run as a readable transcript. ACM tool calls are shown in full
 * (args + result) because they are the load-bearing evidence; other tools are
 * shown compactly so the judge can follow the work without drowning in it.
 *
 * @param {Array<{ phase: string, prompt: string, toolCalls: any[], assistantText: string }>} turnRecords
 */
export function buildTranscript(turnRecords) {
  const out = [];
  const renderCall = (call) => {
    const lines = [];
    const status = call.completed !== true
      ? "…INCOMPLETE"
      : call.isError || call.details?.error
        ? "✗ERROR"
        : "✓";
    if (ACM_TOOLS.has(call.name)) {
      const args = JSON.stringify(call.args ?? {}, null, 2);
      lines.push(`  ◆ ${call.name} ${status}`);
      lines.push(`    args: ${args.replace(/\n/g, "\n    ")}`);
      const result = (call.resultText ?? "").trim();
      if (result) lines.push(`    result: ${result.replace(/\n/g, "\n    ")}`);
      if (call.details) lines.push(`    details: ${JSON.stringify(call.details).slice(0, 800)}`);
    } else {
      const summary = summarizeArgs(call.name, call.args);
      lines.push(`  → ${call.name}(${summary}) ${status}`);
    }
    return lines;
  };
  for (const turn of turnRecords) {
    out.push(`\n════════ 阶段 ${turn.phase} ════════`);
    out.push(`【用户】${turn.prompt}`);
    if (Array.isArray(turn.segments)) {
      let previousKind = null;
      for (const segment of turn.segments) {
        if (segment.kind === "assistant_text") {
          out.push(`【助手回复】${segment.text}`);
        } else if (segment.kind === "tool") {
          if (previousKind !== "tool") out.push("【助手动作】");
          out.push(...renderCall(segment.call));
        }
        previousKind = segment.kind;
      }
    } else {
      if (turn.toolCalls.length) {
        out.push("【助手动作】");
        for (const call of turn.toolCalls) out.push(...renderCall(call));
      }
      const reply = (turn.assistantText ?? "").trim();
      if (reply) out.push(`【助手回复】${reply}`);
    }
  }
  return out.join("\n");
}

function buildOpportunityKey(opportunities) {
  return opportunities
    .map((o, i) => `${i + 1}. 【${o.phase}】${o.intent}`)
    .join("\n");
}

export function buildJudgePrompt({ opportunities, transcript, taskCompletionDesc }) {
  return `你是 ACM(Agentic Context Management)行为的资深评审。你要评估一个编码 agent 在一段真实开发会话里,\
**在完全没有被提示的情况下**,是否恰当地主动管理了自己的上下文(working set)。

## ACM 背景
被评估的 agent 拥有三个工具:
- \`acm_checkpoint\` — 给当前状态打一个可恢复的存档点(save point),不改变上下文。
- \`acm_timeline\` — 查看会话树、存档点、summary 深度、上下文用量。
- \`acm_travel\` — 用一份 structured handoff(goal/state/evidence/external/exclusions/recover/next)把已成 sediment 的\
原始过程折叠(fold)成 working set;也可 rebase 到更早的基底,或 rehydrate 取回归档细节。

**关键:这段会话是去 priming 的——用户从头到尾没有提过 context、压缩、存档、折叠、rebase,也没提过任何 acm_* 工具。**\
因此"是否自发使用"本身就是核心信号。

## 每个阶段本应存在的机会(答案钥匙,agent 并不知道)
${buildOpportunityKey(opportunities)}

## 标尺版本
本轮使用 **${RUBRIC_VERSION}**。它把时机判断改为 outcome-first：旧版 v1/v2 的分数与本轮**不可直接比较**，
因为旧版曾把“当前回合仍有义务时 travel”本身视作时机错误。

## 评分维度(每项 0-3 分:0=缺失/错误,1=差,2=合格,3=优秀)并给出 attribution
1. **activation 激活**:在无提示下到底用没用 ACM。弱模型的地板是哪怕只做了压缩/rebase。
2. **timing_and_measure 时机与度（outcome-first）**:有真 sediment 才折;**没有为折而折**;当不确定性还活着、下一步动作明确时通常应继续。\
   机械地“到阶段就折”是缺陷不是优点。但“当前回合还有义务”**本身不是自动扣分条件**：若 handoff 明确保留了测试、回答、未完成改动等义务，\
   travel 后 agent 直接从 NEXT 继续，且没有丢失事实、无谓重读、thrash 或转去错误工作，这可以是正确的时机选择。\
   只有 transcript 显示 travel 造成义务遗漏/扭曲、继续被打断、重复探索、错误行动或任务事实性变差，才把它判为时机错误。
3. **handoff_quality**:折叠产生的 handoff 能否通过 cold start——新 agent 只凭它和指针能否立刻接着干,\
   structured fields 是否完整、State 是否带了 hot set 和未决项。
4. **recoverability 可恢复性**:高风险改动/分叉前是否先 save;需要回退/取回时是否命中**精确正确的节点**,\
   而不是就近的标签(anchor gravity)。
5. **ceiling 天花板**:是否出现高级/涌现操作——fork、rehydrate 往返、rebase 到最早安全基底、精确 target 选择,\
   乃至设计者都没预设的巧妙用法。强模型在这里加分,弱模型给 0-1 不扣激活分。\
   注意:rehydrate 是取回**确实已不在 working set(含 handoff State)**的细节时的兑底手段,不是仪式——\
   handoff 已携带所需细节时直接作答是正确表现,不得记为"错失 rehydrate";\
   对可重导的事实(如重跑代码验证语义),实证重跑与 rehydrate 同等有效。
6. **task_completion 任务完成度**:${taskCompletionDesc ?? "任务本身做得如何。"}\
   用来抓"为折而折拖垮任务"(折叠拖垮或折坏导致任务事实性变差,就是 task 受损)。

## attribution 标签(每维度选最贴切的一个)
healthy / never-activated / event-driven-overfold / negation-suppressed-inaction / bad-handoff / \
lost-recoverability / anchor-gravity-wrong-target / thrash / task-degraded

## 输出
**只输出一个 JSON 代码块,不要调用任何工具,不要有多余文字。** 所有 <code>quality</code>、六个维度的
<code>score</code> 和 <code>overall.score</code> 都必须是 <strong>0、1、2、3 中的一个整数</strong>；
<code>overall.score</code> 不是六个维度的总和。键名必须与下列结构完全一致。结构:
\`\`\`json
{
  "rubricVersion": "${RUBRIC_VERSION}",
  "perPhase": [
    { "phase": "P1-摸底", "opportunityTaken": true, "action": "简述 agent 做了什么", "quality": 0, "note": "简短归因" }
  ],
  "dimensions": {
    "activation": { "score": 0, "attribution": "标签", "note": "" },
    "timing_and_measure": { "score": 0, "attribution": "标签", "note": "" },
    "handoff_quality": { "score": 0, "attribution": "标签", "note": "" },
    "recoverability": { "score": 0, "attribution": "标签", "note": "" },
    "ceiling": { "score": 0, "attribution": "标签", "note": "" },
    "task_completion": { "score": 0, "attribution": "标签", "note": "" }
  },
  "overall": { "score": 0, "modelTier": "weak|mid|strong", "summary": "两三句总体归因" },
  "topAttributions": ["最能解释这次表现的 1-3 个标签"]
}
\`\`\`

## 待评审的会话 transcript
${transcript}
`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addUnexpectedAndMissingKeyErrors(value, expectedKeys, path, errors) {
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing required key`);
  }
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) errors.push(`${path}.${key}: unexpected key`);
  }
}

function requireNonEmptyString(value, path, errors) {
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string`);
  } else if (!value.trim()) {
    errors.push(`${path}: expected a non-empty string`);
  }
}

function requireScore(value, path, errors) {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    errors.push(`${path}: expected an integer from 0 through 3`);
  }
}

/**
 * Validate the shared structural contract for every known judge rubric without
 * coercing or repairing it. Current production output adds an exact-v3 gate in
 * validateVerdict(); historical consumers use this function through
 * validatePersistedVerdict().
 */
export function validateVerdictStructure(verdict, { expectedPhases } = {}) {
  const errors = [];
  if (!isPlainObject(verdict)) {
    return { ok: false, errors: ["$: expected a plain object"], error: "$: expected a plain object" };
  }

  addUnexpectedAndMissingKeyErrors(verdict, REQUIRED_VERDICT_KEYS, "$", errors);
  if (!KNOWN_RUBRIC_VERSIONS.includes(verdict.rubricVersion)) {
    errors.push(`$.rubricVersion: unsupported rubric ${JSON.stringify(verdict.rubricVersion)}`);
  }

  if (!Array.isArray(verdict.perPhase)) {
    errors.push("$.perPhase: expected an array");
  } else {
    if (verdict.perPhase.length === 0) errors.push("$.perPhase: expected at least one phase record");
    const seenPhases = new Set();
    verdict.perPhase.forEach((phase, index) => {
      const path = `$.perPhase[${index}]`;
      if (!isPlainObject(phase)) {
        errors.push(`${path}: expected a plain object`);
        return;
      }
      addUnexpectedAndMissingKeyErrors(phase, REQUIRED_PHASE_KEYS, path, errors);
      requireNonEmptyString(phase.phase, `${path}.phase`, errors);
      if (typeof phase.opportunityTaken !== "boolean") {
        errors.push(`${path}.opportunityTaken: expected a boolean`);
      }
      requireNonEmptyString(phase.action, `${path}.action`, errors);
      requireScore(phase.quality, `${path}.quality`, errors);
      requireNonEmptyString(phase.note, `${path}.note`, errors);
      if (typeof phase.phase === "string") {
        if (seenPhases.has(phase.phase)) errors.push(`${path}.phase: duplicate phase ${JSON.stringify(phase.phase)}`);
        seenPhases.add(phase.phase);
      }
    });
    if (expectedPhases !== undefined) {
      if (!Array.isArray(expectedPhases)) {
        errors.push("$.perPhase: expectedPhases must be an array when supplied");
      } else {
        if (verdict.perPhase.length !== expectedPhases.length) {
          errors.push(`$.perPhase: expected ${expectedPhases.length} phase records, received ${verdict.perPhase.length}`);
        }
        expectedPhases.forEach((expectedPhase, index) => {
          const actualPhase = verdict.perPhase[index]?.phase;
          if (actualPhase !== expectedPhase) {
            errors.push(`$.perPhase[${index}].phase: expected exactly ${JSON.stringify(expectedPhase)}, received ${JSON.stringify(actualPhase)}`);
          }
        });
      }
    }
  }

  if (!isPlainObject(verdict.dimensions)) {
    errors.push("$.dimensions: expected a plain object");
  } else {
    addUnexpectedAndMissingKeyErrors(verdict.dimensions, JUDGE_DIMENSIONS, "$.dimensions", errors);
    for (const dimension of JUDGE_DIMENSIONS) {
      const path = `$.dimensions.${dimension}`;
      const score = verdict.dimensions[dimension];
      if (!isPlainObject(score)) {
        errors.push(`${path}: expected a plain object`);
        continue;
      }
      addUnexpectedAndMissingKeyErrors(score, REQUIRED_DIMENSION_KEYS, path, errors);
      requireScore(score.score, `${path}.score`, errors);
      if (!ATTRIBUTIONS.includes(score.attribution)) {
        errors.push(`${path}.attribution: expected one of ${ATTRIBUTIONS.join(", ")}`);
      }
      requireNonEmptyString(score.note, `${path}.note`, errors);
    }
  }

  if (!isPlainObject(verdict.overall)) {
    errors.push("$.overall: expected a plain object");
  } else {
    addUnexpectedAndMissingKeyErrors(verdict.overall, REQUIRED_OVERALL_KEYS, "$.overall", errors);
    requireScore(verdict.overall.score, "$.overall.score", errors);
    if (!MODEL_TIERS.includes(verdict.overall.modelTier)) {
      errors.push(`$.overall.modelTier: expected one of ${MODEL_TIERS.join(", ")}`);
    }
    requireNonEmptyString(verdict.overall.summary, "$.overall.summary", errors);
  }

  if (!Array.isArray(verdict.topAttributions)) {
    errors.push("$.topAttributions: expected an array");
  } else {
    if (verdict.topAttributions.length < 1 || verdict.topAttributions.length > 3) {
      errors.push("$.topAttributions: expected between 1 and 3 entries");
    }
    const seen = new Set();
    verdict.topAttributions.forEach((attribution, index) => {
      const path = `$.topAttributions[${index}]`;
      if (!ATTRIBUTIONS.includes(attribution)) {
        errors.push(`${path}: expected one of ${ATTRIBUTIONS.join(", ")}`);
      }
      if (seen.has(attribution)) errors.push(`${path}: duplicate attribution`);
      seen.add(attribution);
    });
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors, error: errors.join("; ") };
}

/** Validate a new producer verdict against the current, exact v3 rubric. */
export function validateVerdict(verdict, options = {}) {
  const structural = validateVerdictStructure(verdict, options);
  if (!isPlainObject(verdict) || verdict.rubricVersion === RUBRIC_VERSION) return structural;
  const error = `$.rubricVersion: expected exactly ${JSON.stringify(RUBRIC_VERSION)}`;
  if (structural.ok) return { ok: false, errors: [error], error };
  return { ok: false, errors: [...structural.errors, error], error: [...structural.errors, error].join("; ") };
}

/** Validate a persisted artifact against the schema for its declared known rubric. */
export function validatePersistedVerdict(verdict, options = {}) {
  return validateVerdictStructure(verdict, options);
}

function judgeReplyTexts(events) {
  return events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => (event.message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(""))
    .filter(Boolean);
}

function extractJsonCandidates(text) {
  const candidates = [];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fences) {
    candidates.push({ text: match[1], start: match.index ?? 0 });
  }
  if (fences.length === 0) candidates.push({ text, start: 0 });

  // Preserve the old brace-span compatibility fallback for prose replies.
  // When fenced candidates exist, a span across multiple fences is not a
  // candidate at all and must not hide a useful schema error from the latest
  // actual JSON block.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (fences.length === 0 && first >= 0 && last > first) {
    candidates.push({ text: text.slice(first, last + 1), start: first });
  }
  return candidates.sort((a, b) => a.start - b.start);
}

/** Pull the last syntactically and schema-valid JSON verdict out of a judge reply. */
export function parseVerdict(text, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "$: empty judge reply", errors: ["$: empty judge reply"] };
  }
  let mostRecentFailure;
  const validate = options.acceptHistorical ? validatePersistedVerdict : validateVerdict;
  for (const candidate of extractJsonCandidates(text).reverse()) {
    try {
      const verdict = JSON.parse(candidate.text.trim());
      const validation = validate(verdict, { expectedPhases: options.expectedPhases });
      if (validation.ok) return { ok: true, verdict };
      mostRecentFailure ??= validation;
    } catch (error) {
      mostRecentFailure ??= {
        ok: false,
        error: `$: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
        errors: [`$: invalid JSON (${error instanceof Error ? error.message : String(error)})`],
      };
    }
  }
  return {
    ok: false,
    error: mostRecentFailure?.error ?? "$: no JSON candidate in judge reply",
    errors: mostRecentFailure?.errors ?? ["$: no JSON candidate in judge reply"],
    raw: text.slice(0, 500),
  };
}

export function buildJudgeRepairPrompt(errors) {
  const listedErrors = Array.isArray(errors) && errors.length
    ? errors.map((error) => `- ${error}`).join("\n")
    : "- $: output was not valid JSON";
  return `你的上一轮裁决输出未通过机器校验。请只修复并重新输出完整裁决 JSON；不要重发 transcript、不要解释、不要调用工具。

校验错误：
${listedErrors}

必须输出一个完整 JSON 代码块，且键名完全匹配原结构。rubricVersion 必须是 ${JSON.stringify(RUBRIC_VERSION)}；
每个 perPhase.quality、六个 dimensions.*.score 和 overall.score 都必须是整数 0、1、2、3 中的一项（overall.score 不是总和）；
dimensions 必须含 activation、timing_and_measure、handoff_quality、recoverability、ceiling、task_completion；
attribution 必须使用原提示给出的标签，modelTier 必须是 weak、mid、strong 之一，topAttributions 必须是 1-3 个不重复的有效标签。`;
}

/** Write a replacement artifact via same-directory rename, never in place. */
export function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  renameSync(temporaryPath, path);
}

function judgeFailure({ transcript, raw, attempts, judgeModel, error, errors }) {
  return {
    transcript,
    raw,
    ok: false,
    error: `judge invalid after ${attempts.length} attempts: ${error}`,
    errors,
    rubricVersion: RUBRIC_VERSION,
    attempts,
    judgeModel,
  };
}

function errorDetails(error, stage) {
  const detail = error instanceof Error ? error.message : String(error);
  const pathError = `$: judge ${stage} failure (${detail})`;
  return { error: pathError, errors: [pathError] };
}

/**
 * Judge a completed run.
 *
 * @param {{
 *   transcript: string,
 *   opportunities: Array<{ phase, intent }>,
 *   judgeAgentDir: string,
 *   sessionDir: string,
 *   cwd: string,
 *   model?: { provider: string, modelId: string },
 *   thinkingLevel?: string,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   driverFactory?: (options: object) => { start(): void, prompt(message: string, options: object): Promise<any[]>, stop(): Promise<void> },
 * }} options
 */
export async function judgeTranscript(options) {
  const model = options.model ?? JUDGE_MODEL;
  const transcript = options.transcript;
  const prompt = buildJudgePrompt({ opportunities: options.opportunities, transcript, taskCompletionDesc: options.taskCompletionDesc });
  const expectedPhases = Array.isArray(options.opportunities)
    ? options.opportunities.map((opportunity) => opportunity?.phase)
    : undefined;
  const now = options.now ?? (() => Date.now());
  const totalTimeoutMs = options.timeoutMs ?? 300000;
  const deadline = now() + totalTimeoutMs;

  const driverOptions = {
    cwd: options.cwd,
    agentDir: options.judgeAgentDir,
    sessionDir: options.sessionDir,
    // No extension: the judge must not load the ACM tools/prompt itself.
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: options.thinkingLevel ?? "high",
  };
  const attempts = [];
  let latestRaw = "";
  let latestParsed;
  let driver;
  let outcome;
  try {
    driver = options.driverFactory ? options.driverFactory(driverOptions) : new PiRpcDriver(driverOptions);
    driver.start();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const kind = attempt === 1 ? "initial" : "repair";
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        const error = `$.judge.${kind}: total deadline exhausted before prompt`;
        attempts.push({ attempt, kind, raw: "", ok: false, error, errors: [error] });
        outcome = judgeFailure({ transcript, raw: latestRaw, attempts, judgeModel: model, error, errors: [error] });
        break;
      }
      const attemptPrompt = attempt === 1 ? prompt : buildJudgeRepairPrompt(latestParsed?.errors);
      let events;
      try {
        events = await driver.prompt(attemptPrompt, { timeoutMs: remainingMs });
      } catch (error) {
        const failure = errorDetails(error, kind);
        attempts.push({ attempt, kind, raw: "", ok: false, ...failure });
        outcome = judgeFailure({ transcript, raw: latestRaw, attempts, judgeModel: model, ...failure });
        break;
      }
      latestRaw = judgeReplyTexts(events).at(-1) ?? "";
      latestParsed = parseVerdict(latestRaw, { expectedPhases });
      if (now() > deadline) {
        const error = `$.judge.${kind}: total deadline exhausted after prompt`;
        const errors = [...(latestParsed.ok ? [] : latestParsed.errors ?? []), error];
        attempts.push({ attempt, kind, raw: latestRaw, ok: false, error, errors });
        outcome = judgeFailure({ transcript, raw: latestRaw, attempts, judgeModel: model, error, errors });
        break;
      }
      attempts.push({
        attempt,
        kind,
        raw: latestRaw,
        ok: latestParsed.ok,
        ...(latestParsed.ok ? {} : { error: latestParsed.error, errors: latestParsed.errors ?? [] }),
      });
      if (latestParsed.ok) {
        outcome = {
          transcript,
          raw: latestRaw,
          ok: true,
          verdict: latestParsed.verdict,
          rubricVersion: RUBRIC_VERSION,
          attempts,
          judgeModel: model,
        };
        break;
      }
    }
    outcome ??= judgeFailure({
      transcript,
      raw: latestRaw,
      attempts,
      judgeModel: model,
      error: latestParsed?.error ?? "$: no verdict",
      errors: latestParsed?.errors ?? ["$: no verdict"],
    });
  } catch (error) {
    const failure = errorDetails(error, "startup");
    attempts.push({ attempt: attempts.length + 1, kind: "startup", raw: "", ok: false, ...failure });
    outcome = judgeFailure({ transcript, raw: latestRaw, attempts, judgeModel: model, ...failure });
  } finally {
    if (driver) {
      try {
        await driver.stop();
      } catch (error) {
        const failure = errorDetails(error, "shutdown");
        attempts.push({ attempt: attempts.length + 1, kind: "shutdown", raw: latestRaw, ok: false, ...failure });
        outcome = judgeFailure({ transcript, raw: latestRaw, attempts, judgeModel: model, ...failure });
      }
    }
  }
  return outcome;
}

/** Judge a completed run after rendering its source turn records once. */
export async function judgeRun(options) {
  return judgeTranscript({
    ...options,
    transcript: buildTranscript(options.turnRecords),
  });
}
