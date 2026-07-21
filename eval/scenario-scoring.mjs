// Shared pure scoring primitives.  Scenario families import this module
// directly so the aggregate scenario registry never becomes their dependency.

const HANDOFF_FIELDS = ["goal", "state", "evidence", "external", "exclusions", "recover", "next"];

/**
 * A tool event can transport a domain failure in result.details without being
 * marked as an RPC-level error. Treat both channels as the observable success
 * contract, so a rejected travel is never credited as a completed fold.
 */
export function toolSucceeded(call) {
  return Boolean(call) && call.completed === true && call.isError !== true && !call.details?.error;
}

export function scoreHandoff(handoff) {
  let decoded = handoff;
  if (typeof handoff === "string") {
    try {
      decoded = JSON.parse(handoff);
    } catch {
      return { ok: false, missing: [...HANDOFF_FIELDS], detail: "invalid JSON-encoded structured handoff" };
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, missing: [...HANDOFF_FIELDS], detail: "missing structured handoff" };
  }
  const missing = HANDOFF_FIELDS.filter((field) => typeof decoded[field] !== "string" || decoded[field].trim().length === 0);
  const invalidAuthoritative = ["goal", "state", "next"].filter((field) =>
    typeof decoded[field] === "string" && decoded[field].trim().toLowerCase() === "none");
  const extra = Object.keys(decoded).filter((field) => !HANDOFF_FIELDS.includes(field));
  const ok = missing.length === 0 && invalidAuthoritative.length === 0 && extra.length === 0;
  return {
    ok,
    missing,
    invalidAuthoritative,
    extra,
    ...(ok ? { fields: decoded } : {}),
    detail: missing.length > 0
      ? `missing: ${missing.join(", ")}`
      : invalidAuthoritative.length > 0
        ? `none not allowed: ${invalidAuthoritative.join(", ")}`
        : extra.length > 0
          ? `unexpected fields: ${extra.join(", ")}`
          : "all seven structured fields present",
  };
}
