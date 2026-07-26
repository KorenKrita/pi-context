// Long-run scenario: one task lifecycle long enough to cross the folding
// break-even point, so the evaluation can measure whether a fold was well
// timed instead of merely whether a tool was called.
//
// Why long: with real per-million prices an untouched prompt is billed at
// cacheRead while every fold re-bills the whole prompt at input price. Folding
// only pays off after enough follow-up requests (eval/cost-model.mjs computes
// where). The retired 15 showroom scenarios ran 1-3 turns, far left of that
// crossing, so they could only ever measure the overhead.
//
// Four phases over one continuous session against eval/fixtures/ledger-drift:
//
//   1 SURVEY   (turns 1-8)   Read 12 service logs, ~87K of raw text. This is
//                            the sediment: once its conclusions are extracted
//                            the raw lines change no later decision.
//   2 SETTLE   (turn 8)      Write the findings to ops/reconciliation-plan.md.
//                            This turn is the settling point S: from here the
//                            logs are recoverable from disk and the transcript
//                            copy is pure noise. S is an observable event
//                            (the file exists), identical for every model and
//                            both arms — not an author's guess.
//   3 APPLY    (turns 9-24)  Reconcile 12 service configs against
//                            ops/slo-targets.json, one small edit per turn, so
//                            context keeps growing while the survey material
//                            stays behind.
//   4 REGRESS  (turns 25-30) Re-derive facts that were only ever visible in
//                            the survey. A fold that dropped the waiver breaks
//                            here — and it breaks through the objective
//                            verify.mjs outcome, not through a memory quiz.
//
// The outcome gate is eval/fixtures/ledger-drift/verify.mjs: exit 0 only when
// all 12 configs match their tier with the single approved search waiver
// preserved. The fixture starts with 29 drifts and is provably solvable.

export const FIXTURE = "ledger-drift";

// Turn index (1-based) whose completion makes the survey material redundant.
// Phase APPLY starts immediately after it.
export const SETTLES_AT_TURN = 8;

// The artifact whose existence marks the settling point objectively.
export const SETTLING_ARTIFACT = "ops/reconciliation-plan.md";

const SERVICES = Object.freeze([
  "billing",
  "checkout",
  "inventory",
  "shipping",
  "auth",
  "search",
  "cart",
  "pricing",
  "webhook",
  "ledger",
  "notify",
  "report",
]);

// ---------------------------------------------------------------------------
// Phase 1 — SURVEY: read the logs. Grouped so each turn adds real token mass.

const SURVEY_GROUPS = Object.freeze([
  ["billing", "checkout"],
  ["inventory", "shipping"],
  ["auth", "search"],
  ["cart", "pricing"],
  ["webhook", "ledger"],
  ["notify", "report"],
]);

function surveyTurns() {
  const turns = SURVEY_GROUPS.map((group, index) => ({
    phase: "survey",
    prompt:
      `读 ops/logs/${group[0]}.log 和 ops/logs/${group[1]}.log，逐条看完整文件。` +
      `报告这两个服务的实际请求耗时分布、错误率，以及日志里 pool_in_use 达到的最大值。` +
      (index === 2
        ? `如果日志里出现过容量相关的故障，把发生时间和处置方式一并说明。`
        : `只报告日志里能读到的事实，不要推测。`),
  }));

  turns.push({
    phase: "survey",
    prompt:
      `读 ops/slo-targets.json 与 ops/incidents/ 下的全部文件。` +
      `对照你在日志里看到的行为，说明每个服务当前的 retryLimit / timeoutMs / poolSize ` +
      `与它所属层级的目标值差多少。指出哪些偏差有正式批准的豁免、哪些没有。`,
  });

  return turns;
}

// ---------------------------------------------------------------------------
// Phase 2 — SETTLE: extract conclusions to disk. This is turn SETTLES_AT_TURN.

const SETTLE_TURN = Object.freeze({
  phase: "settle",
  prompt:
    `把你的结论写成 ${SETTLING_ARTIFACT}。内容要求：一张表列出全部 12 个服务的 ` +
    `目标 retryLimit / timeoutMs / poolSize，以及一节 "Approved waivers" 记录经批准的偏差` +
    `（含批准来源和不得回退的理由）。写完之后，这份文件就是后续改动的唯一依据。`,
});

// ---------------------------------------------------------------------------
// Phase 3 — APPLY: 16 turns of small edits driven by the settled plan.

function applyTurns() {
  const turns = SERVICES.map((service) => ({
    phase: "apply",
    prompt:
      `按 ${SETTLING_ARTIFACT} 修改 src/services/${service}.mjs 的 ${service}Config，` +
      `使 retryLimit / timeoutMs / poolSize 与计划一致。只改这一个文件，改完说明改了哪三个值。`,
  }));

  // Four consolidation turns keep the phase at 16 requests without inventing
  // work that a real reconciliation would not do.
  turns.push({
    phase: "apply",
    prompt: `运行 node verify.mjs，报告输出与退出码。若仍有失败项，逐条列出。`,
  });
  turns.push({
    phase: "apply",
    prompt:
      `再次运行 node verify.mjs 确认结果稳定，并检查 src/lib/pool.mjs 会不会因为新的 ` +
      `poolSize 抛出 pool exhausted —— 说明依据。`,
  });
  turns.push({
    phase: "apply",
    prompt:
      `检查 12 个 src/services/*.mjs 里是否还残留任何与 ${SETTLING_ARTIFACT} 不一致的常量，` +
      `包括注释里写死的旧值。列出你检查过的文件。`,
  });
  turns.push({
    phase: "apply",
    prompt: `汇总这一轮改动：哪些服务的哪些字段变了，从什么值变成什么值。`,
  });

  return turns;
}

// ---------------------------------------------------------------------------
// Phase 4 — REGRESS: needs survey-era facts. A fold that dropped them fails
// the objective outcome, not a recall test.

function regressTurns() {
  return [
    {
      phase: "regress",
      prompt:
        `有人提议把所有 standard 层服务的 poolSize 统一改成层级目标值，理由是"配置越一致越好"。` +
        `判断这个提议能不能直接执行；如果不能，指出哪个服务会因此出问题、依据是什么。`,
    },
    {
      phase: "regress",
      prompt:
        `把上一题的判断落实到代码与文档：确保受影响的服务保持正确取值，` +
        `并在 ${SETTLING_ARTIFACT} 里让这条约束显式可见。`,
    },
    {
      phase: "regress",
      prompt:
        `运行 node verify.mjs。如果失败，修到通过；如果通过，说明它现在校验了哪些约束。`,
    },
    {
      phase: "regress",
      prompt:
        `ops/logs/ 下的日志还有保留价值吗？给出保留或删除的建议，并说明判断依据 ` +
        `——依据必须能被现在仓库里的文件支持。`,
    },
    {
      phase: "regress",
      prompt:
        `写 ops/handover.md：接手的人需要知道的全部内容 —— 当前配置状态、` +
        `不得回退的约束及其来源、验证方式。`,
    },
    {
      phase: "regress",
      prompt:
        `最后确认：运行 node verify.mjs 并报告退出码，然后一句话总结这次任务交付了什么。`,
    },
  ];
}

// ---------------------------------------------------------------------------

/**
 * The full scripted turn list. Order is fixed and identical for every model,
 * every commit, and both arms — the run is scored on its final coordinates,
 * not on how it chose to get there.
 * @returns {Array<{ phase: "survey"|"settle"|"apply"|"regress", prompt: string }>}
 */
export function buildTurns() {
  return [...surveyTurns(), SETTLE_TURN, ...applyTurns(), ...regressTurns()];
}

/** Phase boundaries as 1-based inclusive turn ranges. */
export function phaseRanges() {
  const turns = buildTurns();
  const ranges = {};
  turns.forEach((turn, index) => {
    const oneBased = index + 1;
    const range = ranges[turn.phase];
    if (!range) ranges[turn.phase] = { from: oneBased, to: oneBased };
    else range.to = oneBased;
  });
  return ranges;
}

/**
 * Truncate the script to a shorter run. The scenario is designed so that
 * cutting at 20 turns lands left of the folding break-even point and the full
 * 30 turns lands right of it, giving both experimental conditions one fixture.
 */
export function buildTurnsTruncated(turnCount) {
  if (!Number.isInteger(turnCount) || turnCount < 1) {
    throw new TypeError(`turnCount must be a positive integer, received ${String(turnCount)}`);
  }
  const turns = buildTurns();
  if (turnCount > turns.length) {
    throw new RangeError(`turnCount ${turnCount} exceeds the scripted ${turns.length} turns`);
  }
  return turns.slice(0, turnCount);
}

export const SCENARIO = Object.freeze({
  id: "ledger-drift-30",
  fixture: FIXTURE,
  settlesAtTurn: SETTLES_AT_TURN,
  settlingArtifact: SETTLING_ARTIFACT,
  outcomeCommand: ["node", "verify.mjs"],
  services: SERVICES,
});
