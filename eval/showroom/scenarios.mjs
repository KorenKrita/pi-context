// Showroom scenario definitions: 15 questions across four classes.
// Positive (should act), Hard positive (multi-move), Negative/trap (should NOT act), Knob-sensitivity.
//
// Mechanism facts the designs obey:
// - Trigger runtime state is volatile: a resumed session starts with fresh
//   burst/run counters. Burst and boundary-cue scenarios therefore make the
//   LIVE run produce the trigger condition; the prefix only plants task
//   context, the hot set, and real token mass.
// - Pressure tiers/gauge use real context size against the runner-pinned
//   --context-window (40000 for all scenarios): 30% = 12K, 50% = 20K, 70% = 28K.
// - Task narratives are ordinary coding work on a fictional "orderflow"
//   service repo. No ACM vocabulary anywhere in task content.
//
// Each scenario returns the expected.json ground-truth payload:
//   window            pinned context window
//   resumePrompts     scripted user turns the runner sends in order
//   expect            fact-checkable verdict spec for the judge
//     requiredMoves   [{ tool, afterReads?, withinToolCalls?, inTurn? }]
//     forbiddenMoves  [{ tool, betweenReadsAndWrites?, beforeProbeAnswer? }]
//     probe           { mustContain: [...] } checked on final assistant text
//     workspace       { files: [...], mustContain: [...] } checked on each arm's final workspace
//     handoffMustContain  strings that must appear in any travel summary
//     diagnosticsOnly    true → no verdict, record facts only

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------- standardized ordinary-coding content ----------

const SERVICES = ["billing", "checkout", "inventory", "shipping", "auth", "search", "cart", "pricing", "webhook", "ledger", "notify", "report"];

function serviceNameAt(index) {
  return SERVICES[index % SERVICES.length] + (index >= SERVICES.length ? String(index) : "");
}

function serviceFileList(start, count) {
  return Array.from({ length: count }, (_, offset) => `services/${serviceNameAt(start + offset)}.ts`).join("、");
}

const SERVICE_FILE_LIST = serviceFileList(0, SERVICES.length);

function logChunk(service, i, marker = "", lineCount = 30) {
  const lines = [];
  for (let n = 0; n < lineCount; n++) {
    lines.push(`2026-06-30T0${n % 10}:1${n % 6}:2${n % 10}Z ${service}-worker[${1000 + n}] INFO request rid=r-${i}-${n} route=/api/${service} status=200 dur=${40 + ((i * n) % 300)}ms`);
  }
  if (marker) lines.splice(Math.min(15, lines.length), 0, marker);
  return lines.join("\n");
}

function tsModule(service, i) {
  return [
    `import { Pool } from "../lib/pool.js";`,
    `import { metrics } from "../lib/metrics.js";`,
    ``,
    `export const ${service}Config = {`,
    `  retryLimit: ${2 + (i % 3)},`,
    `  timeoutMs: ${1000 + i * 250},`,
    `  poolSize: ${10 + (i % 5) * 5},`,
    `};`,
    ``,
    `export async function handle${service[0].toUpperCase()}${service.slice(1)}(req) {`,
    `  const started = Date.now();`,
    `  try {`,
    `    const conn = await Pool.acquire("${service}", ${service}Config.timeoutMs);`,
    `    const result = await conn.run(req.payload);`,
    `    metrics.observe("${service}.dur", Date.now() - started);`,
    `    return { ok: true, result };`,
    `  } catch (error) {`,
    `    metrics.count("${service}.err");`,
    `    throw error;`,
    `  }`,
    `}`,
  ].join("\n");
}

function writeWorkspaceServices(workspace, count, { markerFile, markerLine } = {}) {
  const dir = join(workspace, "services");
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const service = serviceNameAt(i);
    const path = join(dir, `${service}.ts`);
    let body = tsModule(service, i);
    if (markerFile === i && markerLine) body += `\n// ${markerLine}\n`;
    writeFileSync(path, body);
    files.push(path);
  }
  return files;
}

// Prefix helper: N scripted read tool-calls whose results carry log mass.
function scriptedReadBurst(builder, n, { tokensPerRead = 450, startUsage = 6000, marker = null, markerAt = -1, linesPerRead = 30 } = {}) {
  let usage = startUsage;
  for (let i = 0; i < n; i++) {
    usage += tokensPerRead;
    builder.toolCall(
      "read",
      { path: `/var/log/orderflow/app-${String(i).padStart(2, "0")}.log` },
      logChunk(SERVICES[i % SERVICES.length], i, i === markerAt ? marker : "", linesPerRead),
      usage,
    );
  }
  return usage;
}

const PROBE_ROOT_CAUSE = "ledger-writer holds the billing pool connection across the fsync barrier";

// ---------- scenarios ----------

export const SCENARIOS = {
  // ============ POSITIVE: should act ============

  // P1 — 35-read log hunt (real-session max), conclusion extracted, next phase queued.
  // Correct move: fold the read sediment before starting the fix phase.
  P1: {
    title: "35-read log hunt, conclusion extracted — fold before the fix phase",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 4);
      builder.user("orderflow 生产环境 checkout p99 从昨晚开始翻倍了，日志在 /var/log/orderflow/，你排查一下根因");
      builder.assistantText("我先逐个扫日志分段定位。", 5200);
      const usage = scriptedReadBurst(builder, 35, {
        tokensPerRead: 420,
        startUsage: 5200,
        marker: `2026-06-30T03:14:00Z billing-worker[1099] WARN pool exhausted waiters=41 holder=ledger-writer fsync_barrier=1`,
        markerAt: 31,
      });
      builder.assistantText(
        `根因定位：${PROBE_ROOT_CAUSE}。证据在 app-31.log 的 pool exhausted 行（waiters=41, holder=ledger-writer）。修复方向：ledger-writer 在 fsync 前先释放 billing pool 连接。`,
        usage + 400,
      );
      return {
        window: 40000,
        resumePrompts: [
          "根因确认了，现在开始修：把 ledger-writer 的连接持有问题修掉，改动前先把你的排查现场收拾好",
        ],
        expect: {
          requiredMoves: [{ tool: "acm_travel", withinToolCalls: 6 }],
          probe: { mustContain: ["ledger-writer", "fsync"] },
          handoffMustContain: ["ledger-writer"],
        },
      };
    },
  },

  // P2 — live burst: locate a setting across 12 service files, then report.
  // Correct: after the 8th read the burst cue fires; a save/fold before the
  // report phase is the expected reaction (checkpoint acceptable, travel ideal).
  P2: {
    title: "live 12-file config sweep — react to the burst boundary",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("orderflow 各服务的重试和超时配置漂移得厉害，我想统一治理");
      builder.assistantText("可以，先盘点现状再定统一值。你说开始我就扫。", 5600);
      return {
        window: 40000,
        resumePrompts: [
          "开始吧：services/ 下每个服务一个 .ts 文件（共 12 个，如 services/cart.ts），把每个文件的 retryLimit 和 timeoutMs 逐个读出来列成表，然后给出统一建议值",
        ],
        expect: {
          requiredMoves: [{ tool: "acm_checkpoint|acm_travel", afterReads: 8, withinToolCalls: 8 }],
          probe: { mustContain: ["retryLimit", "timeoutMs"] },
        },
      };
    },
  },

  // P3 — pressure climb: prefix ~34%, live reads push past Δ8pp gauge.
  // Correct: gauge → orient/fold rather than plowing on.
  P3: {
    title: "pressure climbing through gauge emissions — orient or fold",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 10);
      builder.user("webhook 服务隔三差五丢事件，帮我查一遍投递链路");
      builder.assistantText("先看投递链路的日志和配置。", 5400);
      const usage = scriptedReadBurst(builder, 18, { tokensPerRead: 460, startUsage: 5400, linesPerRead: 6 });
      builder.assistantText("投递链路日志扫完，没有发现丢弃点；下一步查各服务配置里的队列参数。", usage + 300);
      return {
        window: 40000,
        resumePrompts: [
          `继续：必须分别用 read 打开这 10 个服务模块（${serviceFileList(0, 10)}），把每个文件的 poolSize 逐个核对并汇总，找出和队列参数不匹配的服务`,
        ],
        expect: {
          requiredMoves: [{ tool: "acm_timeline|acm_travel|acm_checkpoint", withinToolCalls: 14 }],
          probe: { mustContain: ["poolSize"] },
        },
      };
    },
  },

  // P4 — new request over a busy unsaved run (two-turn live flow).
  // Turn 1 explicitly audits all 12 service modules, inducing ≥10 live tool calls
  // with no save point; turn 2 is an unrelated new request. Correct: protect the
  // old hot set first.
  P4: {
    title: "new request lands on a busy unsaved run — save before switching",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12, { markerFile: 6, markerLine: "TODO(orderflow-1841): cart drains pool when search is cold" });
      builder.user("cart 服务偶发 502，你先摸一下");
      builder.assistantText("好，我从 cart 和它的依赖开始扫。", 5300);
      return {
        window: 40000,
        resumePrompts: [
          `第一轮只做排查：必须分别用 read 打开这 12 个文件（${SERVICE_FILE_LIST}），逐个核对 timeoutMs、poolSize 和调用依赖，找出 cart 502 的候选原因；先别改代码，最后汇总你实际读到的证据`,
          "先放一下，线上有个急事：auth 服务的 timeoutMs 现在是多少？顺便说下它和别的服务比是否偏小",
        ],
        expect: {
          requiredMoves: [{ tool: "acm_checkpoint|acm_travel", inTurn: 2, withinToolCalls: 4 }],
          probe: { mustContain: ["timeoutMs"] },
        },
      };
    },
  },

  // P5 — phase completion: a busy run ends cleanly, next phase is independent.
  // The end-of-run cue arrives as follow-up. Correct: fold/save at the boundary.
  P5: {
    title: "phase completes after a busy run — act on the boundary cue",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("给 orderflow 做个配置健康度报告");
      builder.assistantText("我扫完所有服务配置后输出报告。", 5200);
      return {
        window: 40000,
        resumePrompts: [
          `开始：必须分别用 read 打开以下 12 个配置模块（${SERVICE_FILE_LIST}），每个服务在报告里单列一行，写出 retryLimit、timeoutMs、poolSize；12 个都读完再给统一健康度报告，报告给完这轮就算收尾`,
        ],
        expect: {
          requiredMoves: [{ tool: "acm_checkpoint|acm_travel", withinToolCalls: 30 }],
          probe: { mustContain: ["poolSize", "retryLimit"] },
        },
      };
    },
  },

  // ============ NEGATIVE / TRAP: should NOT act ============

  // N1 — 12 reads whose contents are ALL live hot set (each file gets edited next).
  // Folding after the burst cue would destroy the working material.
  N1: {
    title: "12-file read-then-rewrite — the burst is hot set, do not fold",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("把 orderflow 所有服务的 retryLimit 统一改成 3");
      builder.assistantText("我需要逐个读出当前值再逐个改，马上开始。", 5400);
      return {
        window: 40000,
        resumePrompts: [
          `开始：必须分别用 read 打开这 12 个文件（${SERVICE_FILE_LIST}），逐个修改 retryLimit 为 3，最后确认 12 个服务全部完成`,
        ],
        expect: {
          forbiddenMoves: [{ tool: "acm_travel", betweenReadsAndWrites: true }],
          probe: { mustContain: ["12"] },
          workspace: {
            files: SERVICES.map((service) => `services/${service}.ts`),
            mustContain: ["retryLimit: 3,"],
          },
        },
      };
    },
  },

  // N2 — 72% pressure but the task is 2 steps from done.
  // The 70% tier reminder must not preempt task completion.
  N2: {
    title: "70% tier hits two steps before completion — finish first",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 3);
      builder.user("billing 池子泄漏那个问题，你查到什么程度了？");
      builder.assistantText("我已经扫完了大部分链路日志，正在收口。", 6000);
      const usage = scriptedReadBurst(builder, 42, { tokensPerRead: 500, startUsage: 6000, marker: `2026-06-30T04:02:11Z billing-worker[1121] ERROR leak suspect conn=c-88 acquired_at=03:14 released=never`, markerAt: 39 });
      builder.assistantText("泄漏点已锁定：conn c-88 acquired 后未释放，在 app-39.log。只差最后两步：确认 billing.ts 里的 finally 分支，然后给出修复 diff。", usage + 300);
      return {
        window: 40000,
        resumePrompts: [
          "就差那两步了，收尾吧",
        ],
        expect: {
          forbiddenMoves: [{ tool: "acm_travel", beforeProbeAnswer: true }],
          probe: { mustContain: ["finally"] },
        },
      };
    },
  },

  // N3 — an owed answer is pending; the user explicitly invites cleanup.
  // Travel is acceptable ONLY if the handoff carries the owed answer forward.
  N3: {
    title: "owed answer pending, user invites cleanup — folding must not break the promise",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 5);
      builder.user("shipping 的超时到底应该设多少？给我一个有依据的数");
      builder.assistantText("我查一下上游依赖的实际延迟分布再回答。", 5600);
      const usage = scriptedReadBurst(builder, 20, { tokensPerRead: 470, startUsage: 5600, marker: `2026-06-30T05:00:00Z shipping-worker[1200] INFO upstream p99=1840ms carrier=zt`, markerAt: 17 });
      return {
        window: 40000,
        resumePrompts: [
          "上下文是不是堆了很多了，你可以清一下，别影响接下来干活",
        ],
        expect: {
          requiredMoves: [],
          handoffMustContain: ["shipping"],
          probe: { mustContain: ["1840", "shipping"] },
        },
      };
    },
  },

  // N4 — hypothesis A just died; hypothesis B's evidence sits in the freshest reads.
  // Folding now would archive unextracted evidence. Checkpoint OK, travel not.
  N4: {
    title: "hypothesis flipped, evidence unextracted — do not fold yet",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 9);
      builder.user("search 服务冷启动慢，我怀疑是索引预热的问题，你验证下");
      builder.assistantText("我读预热相关代码和日志验证这个假设。", 5500);
      return {
        window: 40000,
        resumePrompts: [
          `必须分别用 read 打开这 9 个服务模块（${serviceFileList(0, 9)}），验证 search 的预热假设；如果预热没问题，先从 poolSize 等已读配置提取真正嫌疑人并报告`,
        ],
        expect: {
          forbiddenMoves: [{ tool: "acm_travel", beforeProbeAnswer: true }],
          probe: { mustContain: ["poolSize"] },
        },
      };
    },
  },

  // N5 — calm cruise control anchor: small context, short task, zero ACM expected.
  N5: {
    title: "calm cruise — zero ACM action is the correct behavior",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 11);
      builder.user("notify 服务现在超时配的多少？");
      builder.assistantText("我看一眼配置。", 4800);
      return {
        window: 40000,
        resumePrompts: ["只读 services/notify.ts，然后告诉我 notifyConfig.timeoutMs 的当前值就行"],
        expect: {
          forbiddenMoves: [{ tool: "acm_travel" }, { tool: "acm_checkpoint" }, { tool: "acm_timeline" }],
          probe: { mustContain: ["timeoutMs"] },
        },
      };
    },
  },

  // ============ HARD POSITIVE: multi-move ACM (should act, and act well) ============
  //
  // The bank saturated at 10/10 on Opus 4.8, which left positive product
  // changes nowhere to show up. These three need more than one correct move,
  // and their probes gate on information that only survives if the moves were
  // done well — so the outcome gate itself has headroom again.
  //
  // Note on `inTurn`: it is a placement DIAGNOSTIC, not a gate (see judge.mjs).
  // These scenarios therefore never rely on turn placement for their verdict;
  // the gate is always the probe/handoff content that a mistimed or careless
  // move would destroy.

  // D1 — two interleaved fronts: the user parks the log hunt and switches to a
  // config task, then comes back. A single fold cannot serve both; the correct
  // shape is save the parked front before switching so it survives the second
  // front's mass, and keep the parked conclusion answerable at the end.
  D1: {
    title: "two interleaved fronts — park one front without losing it",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("webhook 丢事件的事查得怎么样了？日志在 /var/log/orderflow/");
      builder.assistantText("正在逐段看投递日志。", 5400);
      const usage = scriptedReadBurst(builder, 22, {
        tokensPerRead: 430,
        startUsage: 5400,
        marker: "2026-06-30T04:20:00Z webhook-worker[1301] WARN delivery dropped rid=r-17-9 reason=ack_timeout retry_budget=0",
        markerAt: 17,
      });
      builder.assistantText(
        "投递链路看完了：丢事件集中在 ack_timeout 且 retry_budget=0 的请求上，还没定结论。",
        usage + 300,
      );
      return {
        window: 40000,
        resumePrompts: [
          `webhook 先放一放，换个活：必须分别用 read 打开这 12 个文件（${SERVICE_FILE_LIST}），把每个文件的 timeoutMs 列成表`,
          "回到 webhook 那个事：你当时看到的丢事件特征是什么？直接告诉我结论",
        ],
        expect: {
          // Parking a live front before a second front's mass lands is the move.
          requiredMoves: [{ tool: "acm_checkpoint|acm_travel", inTurn: 1, withinToolCalls: 14 }],
          // The parked conclusion must survive whatever was done to the context.
          probe: { mustContain: ["ack_timeout", "retry_budget"] },
        },
      };
    },
  },

  // D2 — stacked summaries: the live run is told to fold twice across two
  // phases, so by phase three the correct move is a rebase to the earliest
  // base rather than a third stacked layer. Judged on the final handoff still
  // carrying both phases' conclusions.
  D2: {
    title: "summaries stacking across three phases — rebase instead of layering",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("orderflow 全链路体检，分三阶段做：日志、配置、结论");
      builder.assistantText("收到，第一阶段先把日志跑完。", 5300);
      const usage = scriptedReadBurst(builder, 24, {
        tokensPerRead: 440,
        startUsage: 5300,
        marker: "2026-06-30T03:14:00Z billing-worker[1099] WARN pool exhausted waiters=41 holder=ledger-writer fsync_barrier=1",
        markerAt: 19,
      });
      builder.assistantText(
        `第一阶段结论：${PROBE_ROOT_CAUSE}。证据是 app-19.log 的 pool exhausted（waiters=41）。`,
        usage + 350,
      );
      return {
        window: 40000,
        resumePrompts: [
          "第一阶段完了，收抾一下现场再进第二阶段",
          `第二阶段：必须分别用 read 打开这 12 个文件（${SERVICE_FILE_LIST}），找出 poolSize 最小的服务，完了再收抾一次现场`,
          "第三阶段：把两个阶段的结论合成一份体检结论告诉我，并把现场整理到最简洁的状态",
        ],
        expect: {
          requiredMoves: [{ tool: "acm_travel", inTurn: 3 }],
          // Both phases must survive the final consolidation.
          probe: { mustContain: ["ledger-writer", "poolSize"] },
          handoffMustContain: ["ledger-writer"],
        },
      };
    },
  },

  // D3 — rehydrate round trip: the exact value the user finally asks for was
  // folded away by the model's own earlier cleanup. Recovering one detail and
  // coming back is the designed move; guessing or re-deriving it is not.
  D3: {
    title: "an exact value was folded away — recover the detail, then continue",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 12);
      builder.user("shipping 上游到底有多慢？日志在 /var/log/orderflow/");
      builder.assistantText("我把上游延迟分布扫一遍。", 5500);
      const usage = scriptedReadBurst(builder, 26, {
        tokensPerRead: 450,
        startUsage: 5500,
        marker: "2026-06-30T05:00:00Z shipping-worker[1200] INFO upstream p99=1840ms carrier=zt route=/api/shipping",
        markerAt: 21,
      });
      builder.assistantText("上游延迟扫完了，具体数字在 app-21.log 里。", usage + 300);
      return {
        window: 40000,
        resumePrompts: [
          "先把排查现场收抾干净，接下来要改代码了",
          "改之前先确认：你刚才看到的 shipping 上游 p99 具体是多少 ms？承载它的 carrier 是哪个？要准确数字，不要估",
        ],
        expect: {
          requiredMoves: [{ tool: "acm_travel", inTurn: 1 }],
          // The exact folded value must come back, not a re-derived guess.
          probe: { mustContain: ["1840", "zt"] },
        },
      };
    },
  },

  // ============ KNOB SENSITIVITY (diagnostics only) ============

  // K1 — burst threshold neighborhood: 9 live reads against the 8 threshold.
  // (K1-7 retired: no arm acted at 7, so it measured nothing.)
  "K1-9": knobBurst(9),

  // K2 (gauge delta) and K3 (arming threshold) were retired after the
  // 2026-07-25 calibration: K2 saw both arms act at high AND low load, so it
  // could not distinguish the treatment at all, and K3 saw no arm act at 7
  // tools and both arms act at 24 — neither bracketed a boundary. Threshold
  // evidence comes from eval/skeleton/skeleton-params.json instead, which is a
  // real-session distribution (burst P95 = 8) at near-zero cost. K1-7 was
  // retired for the same reason: no arm acted, so it measured nothing.

  // K4 — dormancy semantics: second burst in the same cycle gets no cue.
  K4: {
    title: "second burst after cue dormancy — does the model still act unprompted?",
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, 20);
      builder.user("orderflow 配置全面盘点，分两批做");
      builder.assistantText("好，第一批先扫前 10 个服务。", 5400);
      return {
        window: 40000,
        resumePrompts: [
          `第一批：必须分别用 read 打开这 10 个文件（${serviceFileList(0, 10)}），读完小结`,
          `第二批：必须分别用 read 打开剩下 10 个文件（${serviceFileList(10, 10)}），读完小结并与第一批合并成总表`,
        ],
        expect: { diagnosticsOnly: true },
      };
    },
  },
};

function knobBurst(n) {
  return {
    title: `burst threshold neighborhood: ${n} live reads`,
    build(builder, { workspace }) {
      writeWorkspaceServices(workspace, n);
      builder.user("盘点一下这批服务的超时配置");
      builder.assistantText("收到，我逐个读。", 5300);
      return {
        window: 40000,
        resumePrompts: [`必须分别用 read 打开这 ${n} 个文件（${serviceFileList(0, n)}），把每个文件的 timeoutMs 读出来列个表`],
        expect: { diagnosticsOnly: true },
      };
    },
  };
}
