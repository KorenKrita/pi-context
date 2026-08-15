import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcmSessionRuntime } from "../src/runtime.js";
import {
  ACM_CORE_HASH,
  acmLedgerPath,
  appendLedgerRow,
  buildBoundaryRow,
  buildFoldRow,
  createLedgerState,
  flushLedgerQueue,
  isLedgerDisabled,
  ledgerQueueStats,
  markBoundaryCounted,
  markFoldCounted,
  modelDiscriminator,
  shouldCountBoundary,
} from "../src/boundary-ledger.js";
import { enqueueLedgerLine, flushLedgerQueue, LEDGER_QUEUE_MAX_ITEMS, ledgerQueueStats } from "../src/ledger-writer.js";

/**
 * The ledger exists because a fold missed at a request boundary is otherwise
 * unobservable. Its two hard properties are therefore: it must record, and it
 * must never be able to break a tool result.
 */

function tempEnv(): Record<string, string | undefined> {
  return { PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "acm-ledger-")) };
}

describe("boundary ledger", () => {
  test("appends one row per call under a fixed schema", async () => {
    const env = tempEnv();
    const state = createLedgerState("s1");
    expect(appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 23.9, windowPercent: 9.4,
      foldTurnPercent: 16.7, foldTaskPercent: 16.2, entries: 42, savePoints: 2,
      model: "openai/gpt-5",
    }), env)).toBe(true);
    await flushLedgerQueue();

    const rows = readFileSync(acmLedgerPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    // Percentages are floored so a row matches what the gauge rendered.
    expect(rows[0]).toMatchObject({
      kind: "boundary", gauge: "v2", session: "s1", boundary: 1,
      budget: 23, window: 9, foldTurn: 16, foldTask: 16, foldsSoFar: 0, entries: 42,
      savePoints: 2, model: "openai/gpt-5",
    });
    // Provenance: the row must be attributable to the exact CORE wording and
    // model that produced it — the two confounds qualitative review hit.
    expect(rows[0].core).toBe(ACM_CORE_HASH);
    expect(ACM_CORE_HASH).toMatch(/^[0-9a-f]{12}$/);
  });

  test("records only counts and percentages, never message content", async () => {
    const env = tempEnv();
    const state = createLedgerState("s2");
    appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 10, windowPercent: 5,
      foldTurnPercent: null, foldTaskPercent: null, entries: 3, savePoints: null,
      model: null,
    }), env);
    appendLedgerRow("fold", buildFoldRow({
      state, budgetBefore: 80, budgetAfter: 20, messageDelta: 120, summaryDepth: 1,
      savePoints: 1, model: "anthropic/claude-sonnet-4",
    }), env);
    await flushLedgerQueue();

    const raw = readFileSync(acmLedgerPath(env), "utf8");
    for (const row of raw.trim().split("\n")) {
      const parsed = JSON.parse(row);
      const keys = Object.keys(parsed);
      // An allowlist, not a denylist: a future field carrying text must fail here.
      expect(keys.every((k) => [
        "kind", "gauge", "core", "model", "ts", "session", "boundary", "budget", "window", "foldTurn",
        "foldTask", "foldsSoFar", "entries", "afterBoundary", "budgetBefore",
        "budgetAfter", "messageDelta", "summaryDepth", "direction", "savePoints",
      ].includes(k))).toBe(true);
      // The cohort field is a static enum, never free text: both row kinds
      // carry the same constant, and legacy rows simply lack the key.
      expect(parsed.gauge).toBe("v2");
    }
  });

  test("a missing or unusable value is null, never zero", async () => {
    const env = tempEnv();
    const state = createLedgerState("s3");
    appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: undefined, windowPercent: Number.NaN,
      foldTurnPercent: null, foldTaskPercent: undefined, entries: 1, model: null,
    }), env);
    await flushLedgerQueue();
    const row = JSON.parse(readFileSync(acmLedgerPath(env), "utf8").trim());
    expect(row.budget).toBeNull();
    expect(row.window).toBeNull();
    expect(row.foldTurn).toBeNull();
    expect(row.foldTask).toBeNull();
    expect(row.model).toBeNull();
  });

  test("normalizes the host model into provider/id and never guesses", () => {
    expect(modelDiscriminator({ provider: "openai", id: "gpt-5" })).toBe("openai/gpt-5");
    // A model record without a provider still identifies the model.
    expect(modelDiscriminator({ id: "local-model" })).toBe("local-model");
    // No model, no id, or non-string junk → null, never a placeholder string.
    expect(modelDiscriminator(undefined)).toBeNull();
    expect(modelDiscriminator(null)).toBeNull();
    expect(modelDiscriminator({ provider: "openai" })).toBeNull();
    expect(modelDiscriminator({ provider: 3, id: 7 } as never)).toBeNull();
  });

  test("counts a boundary once per distinct entry, not once per tool result", () => {
    // The same boundary is observed on every tool result of that turn; counting
    // observations would report tool activity instead of request structure.
    const state = createLedgerState("s4");
    expect(shouldCountBoundary(state, "u1")).toBe(true);
    markBoundaryCounted(state, "u1");
    expect(shouldCountBoundary(state, "u1")).toBe(false);
    expect(shouldCountBoundary(state, "u2")).toBe(true);
    expect(markBoundaryCounted(state, "u2")).toBe(2);
    expect(shouldCountBoundary(state, null)).toBe(false);
    expect(markFoldCounted(state)).toBe(1);
    // A fold can re-expose an earlier user entry as the branch's last
    // boundary. It was already counted — writing it again would inflate n
    // with a phantom row for a request that is not new.
    expect(shouldCountBoundary(state, "u1")).toBe(false);
  });

  test("an unwritable target fails silently instead of throwing", async () => {
    // Hard requirement: the ledger is not allowed to become a failure surface.
    // The base sits under an existing regular file so the async mkdir fails
    // with ENOTDIR on every platform ("/dev/null/..." is creatable on Windows).
    const blocker = join(mkdtempSync(join(tmpdir(), "ledger-blocker-")), "file");
    writeFileSync(blocker, "x");
    const env = { PI_CODING_AGENT_DIR: join(blocker, "child") };
    const state = createLedgerState("s5");
    const failuresBefore = ledgerQueueStats().writeFailures;
    expect(() => appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 1, windowPercent: 1,
      foldTurnPercent: 1, foldTaskPercent: 1, entries: 1, model: null,
    }), env)).not.toThrow();
    // Enqueueing succeeds — the failure surfaces on the async drain, silently.
    expect(appendLedgerRow("fold", buildFoldRow({
      state, budgetBefore: 1, budgetAfter: 1, messageDelta: 1, summaryDepth: 1, model: null,
    }), env)).toBe(true);
    await flushLedgerQueue();
    expect(ledgerQueueStats().writeFailures).toBeGreaterThanOrEqual(failuresBefore + 2);
    expect(existsSync(join(blocker, "child"))).toBe(false);
  });

  test("the kill switch silences writing entirely", () => {
    const env = { ...tempEnv(), ACM_LEDGER_DISABLED: "1" };
    expect(isLedgerDisabled(env)).toBe(true);
    const state = createLedgerState("s6");
    expect(appendLedgerRow("boundary", buildBoundaryRow({
      state, boundary: 1, budgetPercent: 1, windowPercent: 1,
      foldTurnPercent: 1, foldTaskPercent: 1, entries: 1, model: null,
    }), env)).toBe(false);
    expect(existsSync(acmLedgerPath(env))).toBe(false);
  });

  test("fold rows and boundary rows from one session share a discriminator and joinable counters", () => {
    // The headline metric — sessions crossing high pressure with at least one
    // fold — requires joining fold rows to boundary rows per session. One
    // LedgerState per SessionManager is the contract that makes that possible.
    const runtime = new AcmSessionRuntime();
    const sessionA = {};
    const sessionB = {};
    const stateA = runtime.ledgerState(sessionA);
    expect(runtime.ledgerState(sessionA)).toBe(stateA);
    expect(runtime.ledgerState(sessionB).session).not.toBe(stateA.session);

    // Boundary, then fold, then the next boundary: the fold row carries the
    // boundary ordinal, and the later boundary row sees the fold count.
    markBoundaryCounted(stateA, "u1");
    const fold = buildFoldRow({ state: stateA, budgetBefore: 50, budgetAfter: 20, messageDelta: 10, summaryDepth: 1, model: null });
    expect(fold.session).toBe(stateA.session);
    expect(fold.afterBoundary).toBe(1);
    markFoldCounted(stateA);
    const boundary = buildBoundaryRow({
      state: stateA, boundary: markBoundaryCounted(stateA, "u2"),
      budgetPercent: 21, windowPercent: 8, foldTurnPercent: null, foldTaskPercent: null, entries: 5, model: null,
    });
    expect(boundary.session).toBe(stateA.session);
    expect(boundary.foldsSoFar).toBe(1);
  });

  test("the hot path performs no synchronous file I/O and the writer is append-only", () => {
    // The enqueue path must stay purely synchronous-in-memory; the writer owns
    // the file, append-only, with no content-read or query surface.
    const hotPath = readFileSync(new URL("../src/boundary-ledger.ts", import.meta.url), "utf8");
    for (const syncApi of ["appendFileSync", "statSync", "mkdirSync", "writeFileSync"]) {
      expect(hotPath).not.toContain(syncApi);
    }
    const writer = readFileSync(new URL("../src/ledger-writer.ts", import.meta.url), "utf8");
    expect(writer).toContain("appendFile");
    for (const readApi of ["readFile", "createReadStream", "readdir", "watch"]) {
      expect(writer).not.toContain(readApi);
    }
  });

  test("enqueue is bounded, FIFO, and reports its drops honestly", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "ledger-queue-")), "rows.jsonl");
    const dropsBefore = ledgerQueueStats().droppedQueueFull;
    // One synchronous burst larger than the queue: the drain cannot run
    // mid-burst, so items beyond the bound are rejected, never buffered.
    const outcomes: string[] = [];
    for (let index = 0; index < LEDGER_QUEUE_MAX_ITEMS + 5; index++) {
      outcomes.push(enqueueLedgerLine(target, { kind: "boundary", seq: index }));
    }
    expect(outcomes.filter((outcome) => outcome === "queue_full")).toHaveLength(5);
    expect(ledgerQueueStats().droppedQueueFull).toBe(dropsBefore + 5);
    await flushLedgerQueue();
    const lines = readFileSync(target, "utf8").trim().split("\n");
    expect(lines).toHaveLength(LEDGER_QUEUE_MAX_ITEMS);
    // FIFO: the first 256 enqueued rows land on disk in order.
    const seqs = lines.map((line) => JSON.parse(line).seq as number);
    expect(seqs).toEqual(Array.from({ length: LEDGER_QUEUE_MAX_ITEMS }, (_, index) => index));

    // An oversized serialized row is refused before buffering.
    const oversizeBefore = ledgerQueueStats().oversizeDrops;
    expect(enqueueLedgerLine(target, { pad: "x".repeat(20 * 1024) })).toBe("oversize");
    expect(ledgerQueueStats().oversizeDrops).toBe(oversizeBefore + 1);
    await flushLedgerQueue();
  });

  test("the prospective size check keeps the file under its injected cap", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "ledger-cap-")), "rows.jsonl");
    const cap = 300;
    for (let index = 0; index < 40; index++) {
      enqueueLedgerLine(target, { kind: "boundary", seq: index, pad: "y".repeat(30) }, cap);
    }
    await flushLedgerQueue();
    // Every row is ~60 bytes: roughly five fit under 300, the rest are
    // dropped by the in-lock size check, and the file never crosses the cap.
    expect(statSync(target).size).toBeLessThanOrEqual(cap);
    const lines = readFileSync(target, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(40);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("concurrent processes never interleave lines or cross the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-concurrent-"));
    const target = join(dir, "shared.jsonl");
    const script = join(dir, "child.ts");
    const writerUrl = new URL("../src/ledger-writer.ts", import.meta.url).href;
    writeFileSync(script, [
      `import { enqueueLedgerLine, flushLedgerQueue } from ${JSON.stringify(writerUrl)};`,
      "const [target, cap] = process.argv.slice(2);",
      "for (let index = 0; index < 80; index++) {",
      "  enqueueLedgerLine(target, { proc: process.pid, seq: index, pad: \"z\".repeat(24) }, Number(cap));",
      "}",
      "await flushLedgerQueue();",
      "",
    ].join("\n"));
    const cap = 8 * 1024;
    const children = [0, 1].map(() =>
      Bun.spawn(["bun", script, target, String(cap)], { stdout: "ignore", stderr: "ignore" })
    );
    for (const child of children) await child.exited;

    const raw = readFileSync(target, "utf8");
    expect(raw.length).toBeGreaterThan(0);
    expect(statSync(target).size).toBeLessThanOrEqual(cap);
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as { proc: number; seq: number });
    // Every line is intact JSON — no interleaving, no torn rows.
    expect(rows.length).toBeGreaterThan(0);
    const writers = new Set(rows.map((row) => row.proc));
    expect(writers.size).toBe(2);
    // Rows from each process keep their own FIFO order.
    for (const pid of writers) {
      const seqs = rows.filter((row) => row.proc === pid).map((row) => row.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });
});
