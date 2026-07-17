// The standard long ACM activation flow.
//
// One evolving session, six phases, Chinese user turns, zero ACM mention.
// The point is measurement without priming: nothing here names context,
// compression, checkpoints, folding, rebasing, or any acm_* tool. Each phase
// is an ordinary developer request that *happens* to create a natural ACM
// opportunity. Whether the agent takes it is exactly what the judge scores.
//
// The seed repo (fixtures/exprlang) is a small TS expression evaluator with a
// planted power-associativity bug (2^3^2 => 64, should be 512) and a hand-rolled
// precedence cascade that is a natural refactor target.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));

/** @typedef {{
 *   phase: string,
 *   intent: string,          // what ACM opportunity this turn plants (never shown to the model under test)
 *   prompt: string,          // the actual Chinese user turn
 *   timeoutMs?: number,
 * }} FlowTurn */

/** @typedef {{
 *   id: string,
 *   description: string,
 *   seedDir: string,
 *   taskCompletionDesc: string,  // flow-specific description of what "the task itself" means, for the judge's task_completion dimension
 *   turns: FlowTurn[],
 * }} Flow */

/** @type {Flow} */
export const LONG_FLOW = {
  id: "exprlang-long-flow",
  description:
    "Six-phase Chinese coding session on a seeded TS expression evaluator. " +
    "De-primed: no turn mentions context, compression, or any ACM tool.",
  seedDir: join(EVAL_ROOT, "fixtures", "exprlang"),
  taskCompletionDesc:
    "编码活儿本身做得如何(bug 修没修对、重构行为是否一致、--json 是否正确、测试是否绿)。",
  turns: [
    {
      phase: "P1-摸底",
      intent:
        "Heavy exploration fills the working set; raw file dumps become sediment once the architecture is understood.",
      prompt:
        "这是一个表达式求值器项目,我刚接手,之前没看过。先通读一遍 README 和 src 下的全部代码,把整体架构、" +
        "每个文件的职责,以及从输入字符串到算出结果的完整求值流程讲清楚。我想真正搞懂它是怎么一步步工作的,不要只看文件名猜。",
      timeoutMs: 420000,
    },
    {
      phase: "P2-修幂bug",
      intent:
        "A real debug trail accumulates; once the fix is green the raw reproduction/search trail is sediment ready to fold.",
      prompt:
        "有用户报了个 bug:算 `2 ^ 3 ^ 2` 得到 64,但正确结果应该是 512。你先实际跑一下复现确认,定位根因," +
        "把它修好,并补一个能覆盖这个 case 的测试,最后把测试全部跑通。",
      timeoutMs: 420000,
    },
    {
      phase: "P3-风险重构",
      intent:
        "Verified baseline + risky core rewrite = save-before-risk / fork opportunity; if it breaks, recovery should target the precise pre-refactor point.",
      prompt:
        "现在 parser.ts 里 parseAdditive / parseMultiplicative / parseUnary / parsePower 这套手写的优先级级联很啰嗦," +
        "以后加新运算符要改一长串。把它重构成基于优先级表的 precedence-climbing(Pratt)单函数解析,行为必须和现在完全一致," +
        "所有测试要继续通过。",
      timeoutMs: 540000,
    },
    {
      phase: "P4-加json",
      intent:
        "Pivot to unrelated CLI work while the working set is full of parser-refactor detail = fold/rebase to shed sediment before the new front.",
      prompt:
        "给 CLI 加一个 `--json` 选项。带上它时输出形如 " +
        '`{"expr": "<原始表达式>", "result": <数值结果>}` 的 JSON,不带时保持现在的纯数字输出。给这个新行为补一个测试。',
      timeoutMs: 420000,
    },
    {
      phase: "P5-回捞",
      intent:
        "A concrete detail from P2 may now live only in folded-away history = rehydrate round trip (save return point, fetch, come back).",
      prompt:
        "对了,前面修的那个幂运算 bug,当时你确认的正确结合性规则具体是怎样的?给我一个能清楚说明这条规则的例子,我要原样写进 README。",
      timeoutMs: 300000,
    },
    {
      phase: "P6-收口",
      intent:
        "Stacked summaries + a final-state review = rebase-to-earliest-safe-base opportunity; the review itself is a handoff-quality probe.",
      prompt:
        "我们从头到尾捋一遍收工:幂运算 bug 修了没、Pratt 重构做完没、--json 加好没、测试是不是全绿?" +
        "给我一份当前项目状态的准确总结,让我确认可以交付。",
      timeoutMs: 420000,
    },
  ],
};

// A genuinely different task SHAPE: knowledge work, not coding.
//
// The agent investigates a fictional system's design docs (fixtures/cadence-docs),
// answers cross-document questions, reconciles a planted contradiction, and produces
// prose deliverables. There are no tests and no "green" exhale — fold points are
// synthesis boundaries, and sediment is accumulated *reading and analysis*, not code.
// Same six ACM opportunity TYPES as LONG_FLOW, transposed onto research work.
// De-primed: no turn mentions context, compression, or any acm_* tool.
//
// Planted for the judge's answer key (the agent is never told):
//  - Contradiction (P3): 03-scheduling.md says a Task retries up to 5 times (6 attempts
//    total) and declares itself the authoritative retry source; 05-operations.md says
//    "at most 3 times". Correct reconciliation defers to scheduling.md and/or flags it.
//  - Buried detail (P5): STANDARD per-attempt wall-clock timeout = 900s (15 min),
//    stated once in 05-operations.md.
/** @type {Flow} */
export const RESEARCH_FLOW = {
  id: "cadence-research-flow",
  description:
    "Six-phase Chinese research/synthesis session over a fictional system's design docs. " +
    "No code, no tests; de-primed: no turn mentions context, compression, or any ACM tool.",
  seedDir: join(EVAL_ROOT, "fixtures", "cadence-docs"),
  taskCompletionDesc:
    "研究/综合活儿本身做得如何(对跨文档问题的回答是否准确、是否找出并正确调和了 retry 上限矛盾、回捞的具体数值是否正确、最终综述是否忠于文档)。",
  turns: [
    {
      phase: "P1-摸底",
      intent:
        "Heavy reading of all five docs fills the working set; once the architecture is understood the raw doc dumps become sediment.",
      prompt:
        "这是一个叫 Cadence 的平台的内部设计文档（就在当前目录下,几个 .md）,我刚接手。先把全部文档通读一遍," +
        "把整个系统的架构、核心组件职责、以及从租户提交 workflow 到生成账单的完整生命周期讲清楚。我要真正搞懂它怎么运作,不要只看文件名猜。",
      timeoutMs: 420000,
    },
    {
      phase: "P2-追路径",
      intent:
        "A concrete cross-doc trace accumulates an analysis trail; once the answer is settled the trail is sediment ready to fold.",
      prompt:
        "具体追一下:一个 STANDARD 租户的某个 Task 先失败两次、第三次才成功,这个过程中到底会产生几条 UsageEvent、分别怎么计费、" +
        "又是怎么去重的?把你推导的依据(哪个文档的哪条规则)都说清楚。",
      timeoutMs: 420000,
    },
    {
      phase: "P3-调和矛盾",
      intent:
        "A high-stakes reconciliation: the answer changes downstream claims, so it is a save-before-risk / precise-recovery opportunity before committing the canonical statement.",
      prompt:
        "我怀疑文档里关于一个 Task 到底能重试多少次的说法不一致。你把相关文档都查一遍,找出到底哪些地方写了、" +
        "分别写的多少,判定哪个才是权威值,给我一个能当作官方口径的结论,并说明你为什么这么定。",
      timeoutMs: 540000,
    },
    {
      phase: "P4-转写手册",
      intent:
        "Pivot to an unrelated sub-topic while the working set is full of retry-analysis detail = fold/rebase to shed sediment before the new front.",
      prompt:
        "先放下重试那块。另一件事:给租户手册写一小节“账单关闭与迟到事件”,说清楚月度冻结后才到的 UsageEvent 会怎么处理、" +
        "已冻结的账单会不会变、租户会在哪里看到这笔调整。要准确、可直接给租户看。",
      timeoutMs: 420000,
    },
    {
      phase: "P5-回捞",
      intent:
        "A concrete detail from the early reading may now live only in folded-away history = rehydrate round trip (save return point, fetch, come back).",
      prompt:
        "对了,前面通读的时候,一个 STANDARD 租户单个 Attempt 的默认墙钟超时(wall-clock timeout)具体是多少?我要原样写进一份对外的 SLA 说明,必须准确。",
      timeoutMs: 300000,
    },
    {
      phase: "P6-收口",
      intent:
        "Stacked analyses + a final synthesis = rebase-to-earliest-safe-base opportunity; the synthesis itself is a handoff-quality probe.",
      prompt:
        "我们从头到尾捋一遍收工:把你对 Cadence 的关键结论(生命周期、重试上限的官方口径、计费与去重、账单冻结与迟到事件、" +
        "STANDARD 超时值)汇成一份准确的总结,让我确认可以交付。",
      timeoutMs: 420000,
    },
  ],
};

export const FLOWS = [LONG_FLOW, RESEARCH_FLOW];

export function listFlows() {
  return FLOWS;
}

export function getFlow(id) {
  return FLOWS.find((f) => f.id === id);
}
