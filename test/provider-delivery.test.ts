import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ProviderDelivery } from "../src/provider-delivery.js";
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
