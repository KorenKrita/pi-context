// LLM-as-judge for the de-primed ACM activation flow.
//
// A fixed strong model reads the full transcript of a run and scores ACM
// behavior on six dimensions, with an attribution tag per dimension so that
// (a) the same model set can be compared across guidance/code versions, and
// (b) the same flow can rank different models by how well they self-manage
// context. Scoring is judgment, not a mechanical checklist — but the rubric
// is version-pinned so every comparison uses the same ruler.

import { PiRpcDriver } from "./driver.mjs";

export const JUDGE_MODEL = { provider: "local-claude", modelId: "claude-opus-4-8" };
// v3 is outcome-first. v2 treated any fold during an unfinished turn as a
// timing failure; v3 instead judges whether the handoff preserves that
// obligation and whether continuation actually degrades. v1/v2 scores are
// therefore not directly comparable with v3 scores.
export const RUBRIC_VERSION = "acm-outcome-v3";
export const RUBRIC_COMPARABILITY_NOTE = "v3 judges outcome rather than an unfinished-turn prohibition; v1/v2 scores are not directly comparable.";

const ACM_TOOLS = new Set(["acm_checkpoint", "acm_timeline", "acm_travel"]);

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
**只输出一个 JSON 代码块,不要调用任何工具,不要有多余文字。** 结构:
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

/** Pull the last JSON object out of the judge's reply. */
export function parseVerdict(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty judge reply" };
  }
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const candidates = fences.length
    ? fences.map((m) => m[1])
    : [text];
  // Also try the widest brace span as a fallback.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    try {
      return { ok: true, verdict: JSON.parse(candidate.trim()) };
    } catch {
      // try next candidate
    }
  }
  return { ok: false, error: "no parseable JSON in judge reply", raw: text.slice(0, 500) };
}

/**
 * Judge a completed run.
 *
 * @param {{
 *   turnRecords: Array<{ phase, prompt, toolCalls, assistantText }>,
 *   opportunities: Array<{ phase, intent }>,
 *   judgeAgentDir: string,
 *   sessionDir: string,
 *   cwd: string,
 *   model?: { provider: string, modelId: string },
 *   thinkingLevel?: string,
 *   timeoutMs?: number,
 * }} options
 */
export async function judgeRun(options) {
  const model = options.model ?? JUDGE_MODEL;
  const transcript = buildTranscript(options.turnRecords);
  const prompt = buildJudgePrompt({ opportunities: options.opportunities, transcript, taskCompletionDesc: options.taskCompletionDesc });

  const driver = new PiRpcDriver({
    cwd: options.cwd,
    agentDir: options.judgeAgentDir,
    sessionDir: options.sessionDir,
    // No extension: the judge must not load the ACM tools/prompt itself.
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: options.thinkingLevel ?? "high",
  });

  driver.start();
  try {
    const events = await driver.prompt(prompt, { timeoutMs: options.timeoutMs ?? 300000 });
    const texts = events
      .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
      .map((e) => (e.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""))
      .filter(Boolean);
    const raw = texts.at(-1) ?? "";
    const parsed = parseVerdict(raw);
    return { transcript, raw, ...parsed, judgeModel: model };
  } finally {
    await driver.stop();
  }
}
