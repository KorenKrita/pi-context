import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  scanProtocolAnchor,
  type AnchorRebuildResult,
  type AnchorScanOptions,
} from "../src/anchor-scan.js";

function entry(id: string): SessionEntry {
  return { id } as unknown as SessionEntry;
}

type Candidate =
  | { ok: false; message: string }
  | { ok: true; messages: number; status: "complete" | "repaired" | "invalid" };

function rebuildFrom(scenario: Record<string, Candidate>, calls: string[] = []) {
  return (entryId: string): AnchorRebuildResult => {
    calls.push(entryId);
    const candidate = scenario[entryId];
    if (candidate === undefined) throw new Error(`unexpected rebuild for ${entryId}`);
    if (!candidate.ok) {
      return {
        ok: false,
        error: "host_operation_failed",
        message: candidate.message,
        details: { leafId: entryId, cause: "stub" },
      } as AnchorRebuildResult;
    }
    return {
      ok: true,
      value: {
        messages: Array.from({ length: candidate.messages }, () => ({ role: "user" })),
        protocol: { status: candidate.status, normalizations: [], repairs: [], defects: [] },
        continuation: { status: "not_present" },
      },
    } as unknown as AnchorRebuildResult;
  };
}

function options(
  branch: readonly SessionEntry[],
  rebuild: AnchorScanOptions["rebuild"],
  extra: Partial<AnchorScanOptions> = {},
): AnchorScanOptions {
  return {
    branch,
    startIndex: branch.length - 1,
    window: 200,
    rebuild,
    ...extra,
  };
}

describe("scanProtocolAnchor", () => {
  test("a complete candidate wins over newer repaired ones", () => {
    const scan = scanProtocolAnchor(
      options(
        [entry("e1"), entry("e2"), entry("e3")],
        rebuildFrom({
          e1: { ok: true, messages: 2, status: "complete" },
          e2: { ok: true, messages: 2, status: "repaired" },
          e3: { ok: true, messages: 2, status: "repaired" },
        }),
      ),
    );
    expect(scan.entryId).toBe("e1");
    expect(scan.protocolStatus).toBe("complete");
    expect(scan.skipped.map((skip) => skip.id)).toEqual(["e3", "e2"]);
    expect(scan.skipped.every((skip) => skip.reason === "protocol_repaired")).toBe(true);
    expect(scan.aborted).toBe(false);
    expect(scan.searchExhausted).toBe(false);
  });

  test("all-repaired falls back to the newest rebuildable repaired candidate and drops its own skip", () => {
    const scan = scanProtocolAnchor(
      options(
        [entry("e1"), entry("e2")],
        rebuildFrom({
          e1: { ok: true, messages: 2, status: "repaired" },
          e2: { ok: true, messages: 2, status: "repaired" },
        }),
      ),
    );
    expect(scan.entryId).toBe("e2");
    expect(scan.protocolStatus).toBe("repaired");
    expect(scan.skipped.map((skip) => skip.id)).toEqual(["e1"]);
  });

  test("build failures, empty packets, and invalid packets are skipped with their own reasons", () => {
    const scan = scanProtocolAnchor(
      options(
        [entry("good"), entry("broken"), entry("empty"), entry("invalid")],
        rebuildFrom({
          good: { ok: true, messages: 2, status: "complete" },
          broken: { ok: false, message: "host exploded" },
          empty: { ok: true, messages: 0, status: "complete" },
          invalid: { ok: true, messages: 2, status: "invalid" },
        }),
      ),
    );
    expect(scan.entryId).toBe("good");
    expect(scan.skipped).toEqual([
      { id: "invalid", reason: "protocol_invalid", defects: [] },
      { id: "empty", reason: "empty_context_packet" },
      { id: "broken", reason: "context_build_failed", message: "host exploded" },
    ]);
  });

  test("acceptRepairedDirectly takes the newest repaired candidate immediately", () => {
    const scan = scanProtocolAnchor(
      options(
        [entry("e1"), entry("e2")],
        rebuildFrom({
          e1: { ok: true, messages: 2, status: "complete" },
          e2: { ok: true, messages: 2, status: "repaired" },
        }),
        { acceptRepairedDirectly: true },
      ),
    );
    expect(scan.entryId).toBe("e2");
    expect(scan.protocolStatus).toBe("repaired");
    expect(scan.skipped).toEqual([]);
  });

  test("lowestIndex stops the scan above the floor", () => {
    const calls: string[] = [];
    const scan = scanProtocolAnchor(
      options(
        [entry("below"), entry("above")],
        rebuildFrom(
          {
            below: { ok: true, messages: 2, status: "complete" },
            above: { ok: false, message: "no" },
          },
          calls,
        ),
        { lowestIndex: 1 },
      ),
    );
    expect(scan.entryId).toBeNull();
    expect(calls).toEqual(["above"]);
    expect(scan.searchExhausted).toBe(false);
  });

  test("window exhaustion is flagged only when unscanned candidates remain", () => {
    const five = ["e0", "e1", "e2", "e3", "e4"].map(entry);
    const scenario: Record<string, Candidate> = {};
    for (const node of five) scenario[node.id] = { ok: false, message: "x" };
    const scan = scanProtocolAnchor(options(five, rebuildFrom(scenario), { window: 2 }));
    expect(scan.entryId).toBeNull();
    expect(scan.inspected).toBe(2);
    expect(scan.searchExhausted).toBe(true);

    const two = ["e0", "e1"].map(entry);
    const smallScenario: Record<string, Candidate> = {};
    for (const node of two) smallScenario[node.id] = { ok: false, message: "x" };
    const exhaustedBranch = scanProtocolAnchor(options(two, rebuildFrom(smallScenario), { window: 2 }));
    expect(exhaustedBranch.searchExhausted).toBe(false);
  });

  test("a pre-aborted signal aborts before any rebuild", () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const scan = scanProtocolAnchor(
      options([entry("e1")], rebuildFrom({ e1: { ok: true, messages: 2, status: "complete" } }, calls), {
        signal: controller.signal,
      }),
    );
    expect(scan.aborted).toBe(true);
    expect(scan.entryId).toBeNull();
    expect(calls).toEqual([]);
  });
});
