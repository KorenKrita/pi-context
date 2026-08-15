import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ProviderDelivery, stableMessageMatch } from "../src/provider-delivery.js";
import { AcmSessionRuntime } from "../src/runtime.js";
import type { LiveAgentSessionAdapter } from "../src/live-agent-session-adapter.js";

const SKIPPED = { status: "skipped", reason: "stub", message: "stub adapter" } as const;
const APPLIED = { status: "applied", reason: "settled", message: "stub adapter" } as const;

function stubAdapter(overrides: Partial<LiveAgentSessionAdapter> = {}): LiveAgentSessionAdapter {
  return {
    installation: { installed: false, reason: "stub" },
    schedule: () => SKIPPED,
    apply: () => APPLIED,
    getStatus: () => SKIPPED,
    clear() {},
    pruneNonContinuableTail: () => undefined,
    ...overrides,
  } as unknown as LiveAgentSessionAdapter;
}

function messages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: "user", content: `m${index}`, timestamp: index })) as AgentMessage[];
}

describe("ProviderDelivery", () => {
  test("the happy chain: defer → markCutoverReady → activatePacket → settle", () => {
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};

    expect(delivery.getPendingTravelToolCallId(session)).toBeUndefined();
    delivery.defer(session, "call-1");
    expect(delivery.getPendingTravelToolCallId(session)).toBe("call-1");
    expect(delivery.getContextDeliveryPhase(session)).toBe("pending_tool_result");

    expect(delivery.markCutoverReady(session, "wrong-id")).toBe(false);
    expect(delivery.markCutoverReady(session, "call-1")).toBe(true);
    expect(delivery.getPendingTravelToolCallId(session)).toBeUndefined();
    expect(delivery.getContextDeliveryPhase(session)).toBe("ready");

    const packet = messages(3);
    expect(delivery.activatePacket(session, packet, "leaf-9")).toBe(true);
    expect(delivery.getCachedPacket(session)).toEqual(packet);
    expect(delivery.shouldRebuildProviderContext(session)).toBe(true);
    expect(delivery.isDeliveryActive(session)).toBe(true);

    expect(delivery.settle(session)).toEqual(APPLIED);
    expect(delivery.nativeReplacementApplied(session)).toBe(true);
  });

  test("a rejected receipt cancels cutover and reports skipped native sync", () => {
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};
    delivery.defer(session, "call-2");

    expect(delivery.rejectTicket(session, "call-2")).toBe(true);
    expect(delivery.getProviderDeliveryStatus(session).phase).toBe("receipt_rejected");
    expect(delivery.getProviderDeliveryStatus(session).persistentMutationApplied).toBe(false);
    expect(delivery.getContextDeliveryPhase(session)).toBe("receipt_rejected");
    expect(delivery.isDeliveryActive(session)).toBe(true);
    // A second rejection is a no-op.
    expect(delivery.rejectTicket(session, "call-2")).toBe(false);
  });

  test("mergeCachedPacket only accepts a verified post-cutover tail", () => {
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};
    delivery.defer(session, "call-3");
    delivery.markCutoverReady(session, "call-3");
    const source = messages(3);
    delivery.activatePacket(session, source.slice(0, 2), "leaf-3", source);
    // The packet's sourceMessages are [m0, m1, m2]; an incoming array with
    // that prefix appends its tail to the cached packet.
    const tail = { role: "user", content: "new", timestamp: 9 } as AgentMessage;
    const merged = delivery.mergeCachedPacket(session, [...source, tail]);
    expect(merged).toHaveLength(3);
    expect(merged?.at(-1)).toEqual(tail);
    // An unrelated array shares no prefix and merges nothing.
    expect(delivery.mergeCachedPacket(session, [tail])).toBeUndefined();
  });

  test("stableMessageMatch agrees with the JSON.stringify oracle on a message-shaped corpus", () => {
    // The matcher replaced serialization with structural comparison; on every
    // JSON-safe shape the two verdicts must be identical, including the
    // stringify quirks (NaN/Infinity both render "null", -0 renders "0",
    // holes and dropped keys vanish).
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }, { type: "toolCall", id: "t1", name: "bash" }],
      timestamp: 5,
      usage: { tokens: 1, costUsd: 0.5 },
    };
    const corpus: Array<[unknown, unknown, boolean]> = [
      [assistant, structuredClone(assistant), true],
      // Key order is part of stringify output; permuting keys must reject.
      [{ role: "user", content: "x", timestamp: 1 }, { timestamp: 1, role: "user", content: "x" }, false],
      // Same length, different characters — the bug a length check would miss.
      [{ role: "user", content: "abc", timestamp: 1 }, { role: "user", content: "abd", timestamp: 1 }, false],
      // One drifted nested field anywhere rejects the whole message.
      [structuredClone(assistant), { ...structuredClone(assistant), timestamp: 6 }, false],
      [structuredClone(assistant), { ...structuredClone(assistant), usage: { tokens: 1, costUsd: 0.6 } }, false],
      [structuredClone(assistant), { ...structuredClone(assistant), content: [{ type: "text", text: "hellp" }] }, false],
      // JSON renders NaN and Infinity identically as null.
      [{ role: "user", content: "x", ts: Number.NaN }, { role: "user", content: "x", ts: Number.POSITIVE_INFINITY }, true],
      // -0 and 0 render the same.
      [{ role: "user", content: "x", ts: -0 }, { role: "user", content: "x", ts: 0 }, true],
      // Holes and explicit nulls are indistinguishable after serialization.
      [{ v: [1, , 3] }, { v: [1, null, 3] }, true],
      // Undefined- and function-valued keys are skipped by stringify.
      [{ a: 1, b: undefined }, { a: 1 }, true],
      [{ a: 1, b: () => 2 }, { a: 1 }, true],
    ];
    for (const [left, right, expected] of corpus) {
      let oracle: boolean;
      try {
        oracle = JSON.stringify(left) === JSON.stringify(right);
      } catch {
        oracle = false;
      }
      expect(oracle).toBe(expected);
      expect(stableMessageMatch(left as AgentMessage, right as AgentMessage)).toBe(expected);
    }
  });

  test("stableMessageMatch fails closed on shapes serialization could not honor", () => {
    // Cycles and BigInt threw under the old serializer; toJSON objects were
    // honored there but are deliberately declined here rather than guessed.
    const cyclic: Record<string, unknown> = { role: "user", content: "x" };
    cyclic.self = cyclic;
    expect(stableMessageMatch(cyclic as unknown as AgentMessage, structuredClone(cyclic) as unknown as AgentMessage)).toBe(false);
    expect(stableMessageMatch({ role: "user", content: "x", n: 1n } as unknown as AgentMessage, { role: "user", content: "x", n: 1n } as unknown as AgentMessage)).toBe(false);
    expect(stableMessageMatch(new Date(0) as unknown as AgentMessage, new Date(0) as unknown as AgentMessage)).toBe(false);
    // A shared non-cyclic reference is still equal, like stringify output.
    const shared = { deep: true };
    expect(stableMessageMatch({ a: shared } as unknown as AgentMessage, { a: shared } as unknown as AgentMessage)).toBe(true);
  });

  test("mergeCachedPacket grafts through structurally equal, non-identical message objects", () => {
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};
    delivery.defer(session, "call-7");
    delivery.markCutoverReady(session, "call-7");
    const source = messages(3);
    delivery.activatePacket(session, source.slice(0, 2), "leaf-7", source);
    // The incoming prefix is a deep copy: no shared references, equal content.
    const incoming = structuredClone(source);
    const tail = { role: "user", content: "deep tail", timestamp: 9 } as AgentMessage;
    const merged = delivery.mergeCachedPacket(session, [...incoming, tail]);
    expect(merged).toHaveLength(3);
    expect(merged?.at(-1)).toEqual(tail);
    // A permuted-key prefix is structurally different and must not graft.
    const permuted = source.map((message) => ({ timestamp: (message as { timestamp: number }).timestamp, content: (message as { content: string }).content, role: "user" })) as AgentMessage[];
    expect(delivery.mergeCachedPacket(session, [...permuted, tail])).toBeUndefined();
  });

  test("rejection converges even when the adapter's clear misbehaves", () => {
    const explodingClear = stubAdapter({
      clear() { throw new Error("adapter clear exploded"); },
    });
    const delivery = new ProviderDelivery(explodingClear);
    const session = {};
    delivery.defer(session, "call-5");

    expect(delivery.rejectTicket(session, "call-5")).toBe(true);
    expect(delivery.getProviderDeliveryStatus(session).phase).toBe("receipt_rejected");
    expect(delivery.getPendingTravelToolCallId(session)).toBeUndefined();
    expect(delivery.getContextDeliveryPhase(session)).toBe("receipt_rejected");
  });

  test("runtime rejection still clears cross-store state when the adapter clear throws", () => {
    const runtime = new AcmSessionRuntime(stubAdapter({
      clear() { throw new Error("adapter clear exploded"); },
    }));
    const session = {};
    runtime.scheduleRefresh(session, "leaf-target");
    runtime.deferPostTravelRefresh(session, "call-6");

    expect(runtime.rejectProviderCutover(session, "call-6")).toBe(true);
    expect(runtime.contextRefresh.isPending(session)).toBe(false);
    expect(runtime.getRefreshTarget(session)).toBeUndefined();
    expect(runtime.getPendingTravelToolCallId(session)).toBeUndefined();
    expect(runtime.getContextDeliveryPhase(session)).toBe("receipt_rejected");
  });

  test("clearUsageObserved only flips a previously observed ticket", () => {
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};
    delivery.defer(session, "call-4");
    delivery.markCutoverReady(session, "call-4");
    delivery.activatePacket(session, messages(1), null);
    delivery.markUsageObserved(session);
    expect(delivery.getProviderDeliveryStatus(session).usageObserved).toBe(true);

    delivery.clearUsageObserved(session);
    expect(delivery.getProviderDeliveryStatus(session).usageObserved).toBe(false);

    // Sessions without a ticket stay untouched (no throw).
    delivery.clearUsageObserved({});
  });
});
