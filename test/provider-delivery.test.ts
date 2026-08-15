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
      // JSON renders NaN, Infinity and null identically as null.
      [{ role: "user", content: "x", ts: Number.NaN }, { role: "user", content: "x", ts: Number.POSITIVE_INFINITY }, true],
      [{ role: "user", content: "x", ts: Number.NaN }, { role: "user", content: "x", ts: null }, true],
      [{ role: "user", content: "x", v: [Number.NaN] }, { role: "user", content: "x", v: [null] }, true],
      // Boxed primitives serialize as their primitive value.
      [{ v: new Number(5) }, { v: new Number(5) }, true],
      [{ v: new String("ab") }, { v: new String("ab") }, true],
      [{ v: new Number(5) }, { v: {} }, false],
      [{ v: new Number(5) }, { v: 5 }, true],
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
    // Two distinct messages sharing ONE cyclic sub-object: serialization
    // throws on either, so this must decline too — no identity shortcut may
    // accept a sub-object serialization could not even walk.
    const shared: Record<string, unknown> = { role: "user", content: "x" };
    shared.self = shared;
    expect(stableMessageMatch({ m: shared } as unknown as AgentMessage, { n: shared } as unknown as AgentMessage)).toBe(false);
    expect(stableMessageMatch({ role: "user", content: "x", n: 1n } as unknown as AgentMessage, { role: "user", content: "x", n: 1n } as unknown as AgentMessage)).toBe(false);
    // Boxed BigInt threw under the old serializer as surely as the primitive.
    expect(stableMessageMatch({ v: Object(1n) } as unknown as AgentMessage, { v: Object(1n) } as unknown as AgentMessage)).toBe(false);
    // A throwing getter must decline, never throw into the caller.
    const exploding: Record<string, unknown> = { role: "user", content: "x" };
    Object.defineProperty(exploding, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => stableMessageMatch(exploding as unknown as AgentMessage, structuredClone({ role: "user", content: "x" }) as unknown as AgentMessage)).not.toThrow();
    expect(stableMessageMatch(exploding as unknown as AgentMessage, structuredClone({ role: "user", content: "x" }) as unknown as AgentMessage)).toBe(false);
    // toJSON is honored by the serializer, so Date identity follows the
    // oracle: equal renderings match, and the walker's old blanket decline
    // is gone with the walker.
    expect(stableMessageMatch(new Date(0) as unknown as AgentMessage, new Date(0) as unknown as AgentMessage)).toBe(true);
    expect(stableMessageMatch(new Date(0) as unknown as AgentMessage, new Date(1) as unknown as AgentMessage)).toBe(false);
    // A shared non-cyclic reference is still equal, like stringify output.
    const sharedPlain = { deep: true };
    expect(stableMessageMatch({ a: sharedPlain } as unknown as AgentMessage, { a: sharedPlain } as unknown as AgentMessage)).toBe(true);
    // The SAME reference passed as both arguments: the old top-level identity
    // shortcut accepted it (true) while serialization would have thrown
    // (false). The walk must decline it through the same gates.
    expect(stableMessageMatch(cyclic as unknown as AgentMessage, cyclic as unknown as AgentMessage)).toBe(false);
    expect(stableMessageMatch({ v: 1n } as unknown as AgentMessage, { v: 1n } as unknown as AgentMessage)).toBe(false);
    // With the serializer as the oracle, accessors participate exactly as
    // serialization renders them: a stable getter matches its plain twin, and
    // the exotic-mutation shapes the walker kept losing to (cross-object
    // writes, keys added mid-walk, forged toString tags, proxies) are simply
    // the serializer's own semantics now - consistent by construction.
    const withAccessor: Record<string, unknown> = {};
    Object.defineProperty(withAccessor, "v", {
      enumerable: true,
      configurable: true,
      get() {
        return "a";
      },
    });
    const plainTwin: Record<string, unknown> = { v: "a" };
    expect(stableMessageMatch(withAccessor as unknown as AgentMessage, plainTwin as unknown as AgentMessage)).toBe(true);

    // A getter that adds a key to the other side mid-serialization: the
    // oracle renders each side fully before comparing, so the added key
    // appears in the right side's output and the pair declines.
    const addingLeft: Record<string, unknown> = { keep: 1 };
    const addingRight: Record<string, unknown> = { keep: 1 };
    Object.defineProperty(addingLeft, "trigger", {
      enumerable: true,
      configurable: true,
      get() {
        addingRight.added = 2;
        return 1;
      },
    });
    let addingOracle = false;
    try {
      addingOracle = JSON.stringify(addingLeft) === JSON.stringify(addingRight);
    } catch {
      addingOracle = false;
    }
    expect(stableMessageMatch(addingLeft as unknown as AgentMessage, addingRight as unknown as AgentMessage)).toBe(addingOracle);

    // A forged Symbol.toStringTag renders as a plain object; the serializer
    // never unwraps it, so it cannot equal the number it forged a tag for.
    const forged: Record<string, unknown> = { marker: "x" };
    Object.defineProperty(forged, Symbol.toStringTag, { value: "Number" });
    expect(stableMessageMatch({ v: forged } as unknown as AgentMessage, { v: 5 } as unknown as AgentMessage)).toBe(false);
    // A nested getter that mutates a LATER sibling: stringify serializes the
    // sibling after the getter ran (mutated value), so the oracle rejects;
    // the walk must process keys in the same depth-first order and read the
    // sibling only when it reaches it - never pre-read the level.
    const nestedLeft: Record<string, unknown> = { sibling: "left", nested: {} };
    Object.defineProperty(nestedLeft.nested, "trigger", {
      enumerable: true,
      get() {
        nestedLeft.sibling = "mutated";
        return 1;
      },
    });
    const nestedRight: Record<string, unknown> = { sibling: "right", nested: { trigger: 1 } };
    let nestedOracle = false;
    try {
      nestedOracle = JSON.stringify(nestedLeft) === JSON.stringify(nestedRight);
    } catch {
      nestedOracle = false;
    }
    expect(nestedOracle).toBe(false);
    expect(stableMessageMatch(nestedLeft as unknown as AgentMessage, nestedRight as unknown as AgentMessage)).toBe(false);
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

  test("a packet activated in place omits the source array yet still merges tails", () => {
    // activatePacket with no explicit sourceMessages builds the packet from
    // the live provider array itself; the duplicate container is omitted, and
    // the merge must still recognize that array as its own prefix.
    const delivery = new ProviderDelivery(stubAdapter());
    const session = {};
    delivery.defer(session, "call-1");
    delivery.markCutoverReady(session, "call-1");
    const packet = messages(3);
    expect(delivery.activatePacket(session, packet, "leaf-1")).toBe(true);

    const tail = messages(2);
    expect(delivery.mergeCachedPacket(session, [...packet, ...tail])).toEqual([...packet, ...tail]);
    // An array that does not extend the cached packet is declined, not grafted.
    expect(delivery.mergeCachedPacket(session, tail)).toBeUndefined();
  });
});
