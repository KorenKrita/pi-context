import { acceptEvents } from "./src/event-gate.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const accepted = acceptEvents([
  { eventId: "evt-a", receivedAt: "2026-07-22T10:00:00Z" },
  { eventId: "evt-a", receivedAt: "2026-07-22T10:04:00Z" },
  { eventId: "evt-b", receivedAt: "2026-07-22T10:00:00Z" },
]);
assert(accepted.map((event) => event.eventId).join(",") === "evt-a,evt-b", "event gate must deduplicate by eventId, not receivedAt");
process.stdout.write("saffron fixture verification passed\n");
