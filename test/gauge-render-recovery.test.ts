import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAcmLifecycle } from "../src/runtime-lifecycle.js";
import { AcmSessionRuntime } from "../src/runtime.js";

/**
 * Transient host-read recovery on the gauge render path.
 *
 * The render path shares one branch/entries/label-map read across its three
 * consumers (save points, fold needles, ledger row). Sharing must not turn a
 * single transient read failure into every consumer failing together: each
 * consumer keeps its own fallback read, exactly as it did before the reads
 * were shared. These tests poison the Nth host read and assert recovery.
 */

beforeAll(() => {
  // The boundary ledger would otherwise write real rows for synthetic runs.
  process.env["ACM_LEDGER_DISABLED"] = "1";
});

interface PoisonPlan {
  branchFailures?: number;
  entriesFailures?: number;
}

function harness(poison: PoisonPlan = {}) {
  const runtime = new AcmSessionRuntime();
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = handler;
    },
  } as unknown as ExtensionAPI;
  registerAcmLifecycle(pi, runtime);

  const u0 = { type: "message", id: "u0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "first request", timestamp: 0 } };
  const a0 = { type: "message", id: "a0", parentId: "u0", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 1 } };
  const u1 = { type: "message", id: "u1", parentId: "a0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "second request", timestamp: 2 } };
  const a1 = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 3 } };
  const branch = [u0, a0, u1, a1];

  let branchReads = 0;
  let entriesReads = 0;
  const sessionManager = {
    getBranch: () => {
      branchReads += 1;
      if (branchReads <= (poison.branchFailures ?? 0)) throw new Error("transient branch failure");
      return [...branch];
    },
    getEntries: () => {
      entriesReads += 1;
      if (entriesReads <= (poison.entriesFailures ?? 0)) throw new Error("transient entries failure");
      return [...branch];
    },
    getLeafId: () => "a1",
  };
  const ctx = {
    sessionManager,
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
    model: { provider: "test", id: "model-1" },
  };
  const runToolResult = () => handlers["tool_result"]!(
    { toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
    ctx,
  );
  return { runtime, session: sessionManager as unknown as object, runToolResult, reads: () => ({ branchReads, entriesReads }) };
}

function patchText(patch: unknown): string {
  const content = (patch as { content: { type: string; text: string }[] }).content;
  return content.find((part) => part.type === "text")?.text ?? "";
}

describe("gauge render recovery", () => {
  test("a clean render counts the boundary and draws both needles", () => {
    const { runtime, session, runToolResult } = harness();
    const patch = runToolResult();
    expect(patch).toBeTruthy();
    const text = patchText(patch);
    expect(text).toContain("fold@turn");
    expect(runtime.ledgerState(session).boundaries).toBe(1);
  });

  test("a gate branch failure that the render path recovers from still counts the boundary", () => {
    // First getBranch() throws (gate scan gets null); the render-path branch
    // read succeeds. The ledger must scan that recovered branch itself —
    // receiving the stale null boundaryId must not drop the row.
    const { runtime, session, runToolResult } = harness({ branchFailures: 1 });
    const patch = runToolResult();
    expect(patch).toBeTruthy();
    expect(runtime.ledgerState(session).boundaries).toBe(1);
    // The odometer saw the gate's null boundary, not a phantom marker.
    expect(patchText(patch)).not.toContain("boundary");
  });

  test("a shared entries failure does not take the fold needles with it", () => {
    // The single shared getEntries() throws; the save-point count takes its
    // null, but the fold consumer must fall back to its own read and still
    // draw the needles.
    const { runToolResult } = harness({ entriesFailures: 1 });
    const patch = runToolResult();
    expect(patch).toBeTruthy();
    const text = patchText(patch);
    expect(text).toContain("fold@turn");
  });

  test("a branch failure that outlives the render path recovers inside the ledger", () => {
    // Gate read and render-path fallback both fail; the ledger's own read
    // (the third) succeeds and the boundary is still counted.
    const { runtime, session, runToolResult } = harness({ branchFailures: 2 });
    const patch = runToolResult();
    expect(patch).toBeTruthy();
    expect(runtime.ledgerState(session).boundaries).toBe(1);
  });
});
