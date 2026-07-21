/**
 * Accept delivery events once. The fixture intentionally starts with a bug:
 * transport receipt timestamps are not identity, so a delayed duplicate must
 * not be accepted just because its receivedAt differs.
 */
export function acceptEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    // Intentional defect for the evaluation's repair phase.
    const identity = event.receivedAt;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
