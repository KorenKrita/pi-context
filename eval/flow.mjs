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
 *   turns: FlowTurn[],
 * }} Flow */

/** @type {Flow} */
export const LONG_FLOW = {
  id: "exprlang-long-flow",
  description:
    "Six-phase Chinese coding session on a seeded TS expression evaluator. " +
    "De-primed: no turn mentions context, compression, or any ACM tool.",
  seedDir: join(EVAL_ROOT, "fixtures", "exprlang"),
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

export const FLOWS = [LONG_FLOW];

export function listFlows() {
  return FLOWS;
}
