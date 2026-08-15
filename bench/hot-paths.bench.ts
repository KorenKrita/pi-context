/**
 * Hot-path benchmarks for the ACM extension.
 *
 * Answers two standing questions the structural optimizations could not:
 *   1. What did the optimization batch actually buy (compare a checkout of
 *      the pre-optimization baseline with this script run on both)?
 *   2. Is a cross-event context packet cache worth its risk — i.e. how much
 *      of a context event's cost is protocol analysis (unskippable) versus
 *      work a cache could remove?
 *
 * Run: bun bench/hot-paths.bench.ts [--json]
 *
 * Numbers are machine-relative medians; never compare across machines. The
 * value is the ratio between scenarios (and between two checkouts).
 */
import { AcmSessionRuntime } from "../src/runtime.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerAcmLifecycle } from "../src/runtime-lifecycle.js";
import { ACM_CONTINUATION_MARKER, normalizeExistingAcmPacketForSession } from "../src/context-packet.js";
import { analyzeToolProtocol } from "../src/tool-protocol.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Synthetic session
// ---------------------------------------------------------------------------

interface BenchSession {
  entries: SessionEntry[];
  branch: SessionEntry[];
  messages: AgentMessage[];
  tree: SessionTreeNode[];
  counts: { getTree: number; getEntries: number; getBranch: number; getLeafId: number };
  context: unknown;
  sessionManager: unknown;
}

function buildChainEntries(count: number, labelEvery: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let timestamp = 1_700_000_000_000;
  for (let index = 0; index < count; index++) {
    const id = `entry-${index}`;
    const parentId = index === 0 ? null : `entry-${index - 1}`;
    const role = index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult";
    const message =
      role === "toolResult"
        ? {
            role,
            toolCallId: `call-${index}`,
            toolName: "read",
            content: [{ type: "text", text: `tool output ${index} ${"x".repeat(150)}` }],
            isError: false,
            timestamp,
          }
        : role === "assistant"
          ? {
              role,
              // The tool call rides the content array (the protocol's actual
              // shape) and pairs with the toolResult at index+1: a valid
              // protocol corpus - no orphan results, no repaired packets.
              content: [
                { type: "text", text: `assistant turn ${index} ${"y".repeat(180)}` },
                { type: "toolCall", id: `call-${index + 1}`, name: "read" },
              ],
              timestamp,
            }
          : { role, content: `user request ${index} ${"z".repeat(160)}`, timestamp };
    entries.push({
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      type: "message",
      message,
    } as SessionEntry);
    timestamp += 1_000;
    if (labelEvery > 0 && index > 0 && index % labelEvery === 0) {
      entries.push({
        id: `label-${index}`,
        parentId: id,
        timestamp: new Date(timestamp).toISOString(),
        type: "label",
        targetId: id,
        label: `checkpoint-${index}`,
      } as unknown as SessionEntry);
      timestamp += 1_000;
    }
  }
  return entries;
}

function withAcmTrace(entries: SessionEntry[]): SessionEntry[] {
  // One applied travel mid-chain: a marked branch summary plus its persisted
  // receipt details, the shape trustedContinuationQueues scans for.
  const anchor = Math.floor(entries.length / 2);
  const at = entries[anchor]!;
  return [
    ...entries.slice(0, anchor + 1),
    {
      id: "summary-acm",
      parentId: at.id,
      timestamp: new Date(Date.parse(at.timestamp) + 500).toISOString(),
      type: "branch_summary",
      fromId: at.id,
      summary: `${ACM_CONTINUATION_MARKER}\nGoal: g\nState: s\nEvidence: e\nExternal: x\nExclusions: c\nRecover: r\nNEXT: n`,
      details: { kind: "acm_travel", handoffVersion: 1, currentUserTurnOpen: false, target: "checkpoint-0" },
    } as SessionEntry,
    ...entries.slice(anchor + 1),
  ];
}

function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) nodes.set(entry.id, { entry, children: [] });
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent = entry.parentId !== null ? nodes.get(entry.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function makeSession(
  count: number,
  options: { labelEvery?: number; traced?: boolean } = {},
): BenchSession {
  let entries = buildChainEntries(count, options.labelEvery ?? 0);
  if (options.traced) entries = withAcmTrace(entries);
  // The branch is the leaf's full ancestry — with a trace, the marked
  // summary sits on it, so the traced corpus actually exercises the
  // trace path (projection + receipt normalization) instead of a
  // trace-free branch that merely carries extra off-path entries.
  const branch = options.traced
    ? entries.filter((entry) => entry.type === "message" || entry.id === "summary-acm")
    : entries.filter((entry) => entry.type === "message");
  const leafId = branch.at(-1)?.id ?? null;
  const tree = buildTree(entries);
  const counts = { getTree: 0, getEntries: 0, getBranch: 0, getLeafId: 0 };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sessionManager = {
    getTree: () => {
      counts.getTree++;
      return tree;
    },
    getEntries: () => {
      counts.getEntries++;
      return [...entries];
    },
    getBranch: (fromId?: string) => {
      counts.getBranch++;
      if (fromId === undefined || fromId === leafId) return [...branch];
      const path: SessionEntry[] = [];
      let current = byId.get(fromId);
      while (current) {
        path.unshift(current);
        current = current.parentId !== null ? byId.get(current.parentId) : undefined;
      }
      return path;
    },
    getLeafId: () => {
      counts.getLeafId++;
      return leafId;
    },
  };
  return {
    entries,
    branch,
    messages: [],
    tree,
    counts,
    sessionManager,
    context: {
      sessionManager,
      getContextUsage: () => ({ tokens: 60_000, contextWindow: 200_000, percent: 30 }),
      ui: { notify() {} },
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface Sample {
  name: string;
  /** Median wall ms, or null when the scenario does not time this dimension. */
  ms: number | null;
  /** user+system CPU per run, or null when unmeasured. */
  cpuMs: number | null;
  /** Heap retained after the scenario settles (forced GC before and after);
   * null when unmeasured. Never read as an allocation count. */
  retainedKb: number | null;
  counts?: BenchSession["counts"];
}

function forceGc(): void {
  // Synchronous full GC where available (Bun); a no-op elsewhere, where the
  // retained reading just includes normal garbage and reads high.
  const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  gc?.(true);
}

function heapUsedKb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

function timeIt(name: string, runs: number, body: () => void | Promise<void>): Sample {
  body(); // warmup: JIT, caches — this benchmark measures warm-path cost deliberately
  const times: number[] = [];
  const cpuStart = process.cpuUsage();
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    body();
    times.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuStart);
  forceGc();
  const before = heapUsedKb();
  for (let run = 0; run < Math.min(runs, 10); run++) body();
  forceGc();
  const retainedKb = Math.max(0, heapUsedKb() - before);
  return { name, ms: median(times), cpuMs: (cpu.user + cpu.system) / 1000 / runs, retainedKb };
}

function captureTimeline(runtime: AcmSessionRuntime) {
  let tool: {
    execute: (toolCallId: string, args: unknown, onAbort?: unknown, ctx?: unknown) => Promise<unknown>;
  } | undefined;
  const pi = {
    registerTool(registered: { name: string; execute: unknown }) {
      if (registered.name === "acm_timeline") tool = registered as never;
    },
    registerPrompt() {},
  };
  registerTimelineTool(pi as never, runtime);
  if (!tool) throw new Error("acm_timeline was not registered");
  return tool!;
}

async function benchTimelineView(
  samples: Sample[],
  name: string,
  view: string,
  extra: Record<string, unknown>,
  session: BenchSession,
): Promise<void> {
  const tool = captureTimeline(new AcmSessionRuntime());
  const run = async () => {
    for (const key of Object.keys(session.counts)) (session.counts as Record<string, number>)[key] = 0;
    await tool.execute("bench", { view, limit: 50, ...extra }, undefined, undefined, session.context);
  };
  await run();
  const times: number[] = [];
  const cpuStart = process.cpuUsage();
  for (let index = 0; index < 5; index++) {
    for (const key of Object.keys(session.counts)) (session.counts as Record<string, number>)[key] = 0;
    const start = performance.now();
    await tool.execute("bench", { view, limit: 50, ...extra }, undefined, undefined, session.context);
    times.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuStart);
  const counts = { ...session.counts }; // snapshot before the retained probe re-runs the tool
  forceGc();
  const before = heapUsedKb();
  await tool.execute("bench", { view, limit: 50, ...extra }, undefined, undefined, session.context);
  forceGc();
  const retainedKb = Math.max(0, heapUsedKb() - before);
  samples.push({ name, ms: median(times), cpuMs: (cpu.user + cpu.system) / 1000 / 5, retainedKb, counts });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function main() {
  const samples: Sample[] = [];
  const labelSession = (count: number): BenchSession => makeSession(count, { labelEvery: Math.floor(count / 50) });

  // --- Function level: the context-event hot path -------------------------
  // What every `context` event pays through normalizeExistingAcmPacketForSession.
  for (const size of [1_000, 10_000]) {
    const clean = makeSession(size);
    const cleanMessages = clean.branch
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: AgentMessage }).message);
    samples.push(
      timeIt(`normalize context [notrace ${size} entries]`, 30, () => {
        normalizeExistingAcmPacketForSession(cleanMessages, clean.sessionManager as never);
      }),
    );

    const traced = makeSession(size, { traced: true });
    const tracedMessages = traced.branch.map((entry) =>
      entry.type === "message"
        ? (entry as { message: AgentMessage }).message
        : { role: "branchSummary", summary: (entry as { summary: string }).summary, fromId: (entry as { fromId: string }).fromId, timestamp: Date.parse(entry.timestamp) } as AgentMessage);
    samples.push(
      timeIt(`normalize context [traced ${size} entries]`, 30, () => {
        normalizeExistingAcmPacketForSession(tracedMessages, traced.sessionManager as never);
      }),
    );
  }

  // The unskippable floor: protocol analysis alone on a 10k-message packet.
  {
    const clean = makeSession(10_000);
    const messages = clean.branch
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: AgentMessage }).message);
    samples.push(
      timeIt("analyzeToolProtocol alone [10k messages]", 30, () => {
        analyzeToolProtocol(messages);
      }),
    );
  }

  // --- Tool level: timeline views ------------------------------------------
  for (const size of [100, 1_000, 10_000]) {
    const session = makeSession(size);
    await benchTimelineView(samples, `timeline active [${size}]`, "active", {}, session);
  }
  {
    const session = labelSession(10_000);
    await benchTimelineView(samples, "timeline checkpoints [10k, 50 labels]", "checkpoints", {}, session);
  }
  {
    const session = makeSession(10_000);
    await benchTimelineView(samples, "timeline search no-match [10k]", "search", { query: "zzz-not-present-anywhere" }, session);
    await benchTimelineView(samples, "timeline tree [10k]", "tree", {}, session);
  }

  // --- Aggregate cache behavior --------------------------------------------
  // Same-session warm renders: the gauge/HUD/checkpoint shared cache at work.
  {
    const session = labelSession(10_000);
    const tool = captureTimeline(new AcmSessionRuntime());
    await tool.execute("warm", { view: "checkpoints", limit: 50 }, undefined, undefined, session.context);
    for (const key of Object.keys(session.counts)) (session.counts as Record<string, number>)[key] = 0;
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    for (const key of Object.keys(session.counts)) (session.counts as Record<string, number>)[key] = 0;
    await tool.execute("warm2", { view: "checkpoints", limit: 50 }, undefined, undefined, session.context);
    const ms = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    samples.push({
      name: "timeline checkpoints warm render [10k]",
      ms,
      cpuMs: (cpu.user + cpu.system) / 1000,
      retainedKb: null,
      counts: { ...session.counts },
    });
  }

  // --- Gauge render path: every non-ACM tool_result passes here ------------
  // Two shapes: the silenced reading (same boundary, unchanged integer
  // pressure - the odometer declines to render, the common case) and the
  // rendered reading with warm aggregates (pressure crosses an integer, no
  // new entry, so the fold projection reads only caches).
  {
    process.env.ACM_LEDGER_DISABLED = "1";
    const emitToolResult = (() => {
      const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
      const pi = {
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          if (name === "tool_result") handlers.push(handler);
        },
      };
      registerAcmLifecycle(pi as never, new AcmSessionRuntime());
      return async (ctx: unknown) => {
        for (const handler of handlers) {
          await handler({ toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] }, ctx);
        }
      };
    })();

    // Silenced: same boundary, fixed usage. First call renders (new boundary),
    // the rest are the odometer's decline path. Labels give the renderer real
    // fold references so the projection path is exercised, not short-cut.
    {
      const session = makeSession(10_000, { labelEvery: 200 });
      await emitToolResult(session.context);
      const times: number[] = [];
      const cpuStart = process.cpuUsage();
      for (let index = 0; index < 5; index++) {
        const start = performance.now();
        await emitToolResult(session.context);
        times.push(performance.now() - start);
      }
      const cpu = process.cpuUsage(cpuStart);
      samples.push({ name: "gauge silenced tool_result [10k]", ms: median(times), cpuMs: (cpu.user + cpu.system) / 1000 / 5, retainedKb: null });
    }

    // Rendered with warm aggregates: no new entries, but the integer pressure
    // climbs each call, so the odometer renders and every projection hits.
    {
      const session = makeSession(10_000, { labelEvery: 200 });
      let percent = 30;
      const context = {
        sessionManager: session.sessionManager,
        getContextUsage: () => ({ tokens: 60_000 + percent * 2_000, contextWindow: 200_000, percent: percent++ }), // +2k tokens = +1%: every call crosses an integer, so every timed call renders
        ui: { notify() {} },
      };
      await emitToolResult(context); // cold: builds aggregates, renders once
      const times: number[] = [];
      const cpuStart = process.cpuUsage();
      for (let index = 0; index < 5; index++) {
        const start = performance.now();
        await emitToolResult(context);
        times.push(performance.now() - start);
      }
      const cpu = process.cpuUsage(cpuStart);
      samples.push({ name: "gauge rendered warm [10k]", ms: median(times), cpuMs: (cpu.user + cpu.system) / 1000 / 5, retainedKb: null });
    }
    process.env.ACM_LEDGER_DISABLED = undefined;
  }

  // --- Cold-cache retention: what one cold checkpoints call leaves behind ---
  // Retention above measures per-call residue; this measures the caches a
  // cold call builds (packet LRU, aggregates, label maps) and keeps.
  {
    // Single before/after deltas are too noisy to quote (GC timing swings
    // whole megabytes); five fresh cold runs, median retained.
    const retained: number[] = [];
    for (let run = 0; run < 5; run++) {
      const session = labelSession(10_000);
      const tool = captureTimeline(new AcmSessionRuntime());
      forceGc();
      const before = heapUsedKb();
      await tool.execute(`cold-${run}`, { view: "checkpoints", limit: 50 }, undefined, undefined, session.context);
      forceGc();
      retained.push(Math.max(0, heapUsedKb() - before));
    }
    samples.push({
      name: "timeline checkpoints cold-cache retention [10k, median of 5]",
      ms: null,
      cpuMs: null,
      retainedKb: median(retained),
    });
  }

  // --- Output ---------------------------------------------------------------
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(samples, null, 2));
    return;
  }
  const nameWidth = Math.max(...samples.map((sample) => sample.name.length));
  console.log(`\n${"scenario".padEnd(nameWidth)}  median ms   cpu ms/run   retained KB   host reads (tree/entries/branch/leaf)`);
  console.log("-".repeat(nameWidth + 76));
  for (const sample of samples) {
    const counts = sample.counts
      ? `${sample.counts.getTree}/${sample.counts.getEntries}/${sample.counts.getBranch}/${sample.counts.getLeafId}`
      : "-";
    const ms = sample.ms === null ? "-" : sample.ms.toFixed(3).padStart(9);
    const cpu = sample.cpuMs === null ? "-" : sample.cpuMs.toFixed(1).padStart(7);
    const retained = sample.retainedKb === null ? "-" : String(sample.retainedKb).padStart(11);
    console.log(
      `${sample.name.padEnd(nameWidth)}  ${ms.padStart(9)}  ${cpu.padStart(7)}  ${retained.padStart(11)}   ${counts}`,
    );
  }
  console.log("");
}

await main();
