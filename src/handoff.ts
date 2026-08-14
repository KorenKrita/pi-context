import { Type, type Static } from "@earendil-works/pi-ai";

export const ACM_CONTINUATION_MARKER = "<!-- PI-CONTEXT:ACM-CONTINUATION:v1 -->";

// Wire shape: goal/state/next take strings; the four supporting fields accept
// null for "nothing to carry" and default to "none". Every property is listed
// in `required` so the schema satisfies strict JSON-schema tool mode
// (constrained decoding); acm_travel's prepareArguments fills omitted
// supporting fields with null, so callers on non-strict channels may still
// omit them. The persisted durable text always renders all seven labeled
// lines — parsing anchors and continuation projection depend on the fixed
// format.
export const StructuredHandoffSchema = Type.Object({
  goal: Type.String({
    minLength: 1,
    description: "What this work is trying to accomplish, including any result still owed to the user and any constraint the work must keep intact.",
  }),
  state: Type.String({
    minLength: 1,
    description: "What is settled, what stays uncertain, and the exact values, paths, and names the next steps will use. Name any question that awaits the user's decision. Multiline text is allowed.",
  }),
  next: Type.String({
    minLength: 1,
    description: "The next step to take right now, written as one concrete action. When that step waits on the user's decision, write it as the question to ask.",
  }),
  evidence: Type.Union([Type.String(), Type.Null()], {
    description: "Verifiable pointers supporting state — file paths, commands, IDs — as one string (newline-separated when several), never an array. Null when there is nothing to carry.",
  }),
  external: Type.Union([Type.String(), Type.Null()], {
    description: "Lasting side effects outside the conversation — files changed, commands run, systems touched. Null when there are none.",
  }),
  exclusions: Type.Union([Type.String(), Type.Null()], {
    description: "Directions tried and ruled out, so they are not retried. Null when there are none.",
  }),
  recover: Type.Union([Type.String(), Type.Null()], {
    description: "Save point names or node IDs that recover folded history, as one string (newline-separated when several), never an array. The automatic return ticket is appended here either way. Null when there are none.",
  }),
}, { additionalProperties: false });

export const HandoffSchema = Type.Union([
  StructuredHandoffSchema,
  Type.String({
    minLength: 1,
    description: "Compatibility fallback: a JSON encoding of the same handoff object. Free-form summary text is not accepted.",
  }),
], {
  description: "The handoff object — goal/state/next required; evidence/external/exclusions/recover optional. A JSON-encoded string of the same object is accepted.",
});

/** Canonical seven-field shape after normalization; omitted optional fields become "none". */
export interface HandoffInput {
  goal: string;
  state: string;
  evidence: string;
  external: string;
  exclusions: string;
  recover: string;
  next: string;
}

export type HandoffWireInput = Static<typeof HandoffSchema>;
export type HandoffField = keyof HandoffInput;

export type HandoffDefect =
  | { field: HandoffField; reason: "empty" | "none_not_allowed" }
  | { field: HandoffField; reason: "invalid_type"; expected: "string"; got: string }
  | { field: "handoff"; reason: "invalid_json" }
  | { field: "handoff"; reason: "unexpected_field"; name: string }
  | { field: "rawArchiveAlias"; reason: "invalid_archive_alias" };

/** Name the wire type of a rejected value the way the caller would (array, not object). */
function wireTypeOf(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Render one defect for the tool error message, carrying enough detail that
 * the caller can correct the call without guessing: invalid_type names the
 * expected and actual types, unexpected_field names the offending field.
 */
export function formatHandoffDefect(defect: HandoffDefect): string {
  switch (defect.reason) {
    case "invalid_type":
      return `${defect.field}:invalid_type (expected ${defect.expected}, got ${defect.got})`;
    case "unexpected_field":
      return `handoff:unexpected_field ('${defect.name}' is not a handoff field)`;
    default:
      return `${defect.field}:${defect.reason}`;
  }
}

export interface CanonicalHandoff {
  fields: HandoffInput;
  text: string;
}

export type HandoffBuildResult =
  | { ok: true; value: CanonicalHandoff }
  | { ok: false; defects: HandoffDefect[] };

const FIELD_ORDER: Array<{ field: HandoffField; label: string }> = [
  { field: "goal", label: "Goal" },
  { field: "state", label: "State" },
  { field: "evidence", label: "Evidence" },
  { field: "external", label: "External" },
  { field: "exclusions", label: "Exclusions" },
  { field: "recover", label: "Recover" },
  { field: "next", label: "NEXT" },
];

const REQUIRED_FIELDS = new Set<HandoffField>(["goal", "state", "next"]);

function normalize(value: string): string {
  return value.replace(/\r\n?|\u2028|\u2029/g, "\n").trim();
}

function renderField(label: string, value: string): string {
  const [first = "", ...continuation] = value.split("\n");
  return [`${label}: ${first}`, ...continuation.map((line) => line.length > 0 ? `  ${line}` : "")].join("\n");
}

export function buildCanonicalHandoff(
  input: HandoffWireInput,
  facts: { rawArchiveAlias?: string } = {},
): HandoffBuildResult {
  const defects: HandoffDefect[] = [];
  let decodedInput: unknown = input;
  if (typeof input === "string") {
    try {
      decodedInput = JSON.parse(input);
    } catch {
      return { ok: false, defects: [{ field: "handoff", reason: "invalid_json" }] };
    }
  }
  const inputRecord = typeof decodedInput === "object" && decodedInput !== null && !Array.isArray(decodedInput)
    ? decodedInput as Record<string, unknown>
    : {};
  const normalizedFields: Partial<Record<HandoffField, string>> = {};
  for (const { field } of FIELD_ORDER) {
    const rawValue = inputRecord[field];
    const required = REQUIRED_FIELDS.has(field);
    if (rawValue === undefined || rawValue === null) {
      // Optional fields default to "none"; missing required fields are defects.
      if (required) defects.push({ field, reason: "invalid_type", expected: "string", got: wireTypeOf(rawValue) });
      else normalizedFields[field] = "none";
      continue;
    }
    if (typeof rawValue !== "string") {
      defects.push({ field, reason: "invalid_type", expected: "string", got: wireTypeOf(rawValue) });
      continue;
    }
    const value = normalize(rawValue);
    if (value.length === 0) {
      // An explicitly empty optional field means "nothing to carry".
      if (required) defects.push({ field, reason: "empty" });
      else normalizedFields[field] = "none";
      continue;
    }
    normalizedFields[field] = value;
    if (required && value.toLowerCase() === "none") {
      defects.push({ field, reason: "none_not_allowed" });
    }
  }
  const knownFields = new Set<string>(FIELD_ORDER.map(({ field }) => field));
  for (const name of Object.keys(inputRecord)) {
    if (!knownFields.has(name)) defects.push({ field: "handoff", reason: "unexpected_field", name });
  }
  const rawArchiveAlias = facts.rawArchiveAlias === undefined
    ? undefined
    : normalize(facts.rawArchiveAlias);
  if (facts.rawArchiveAlias !== undefined && (!rawArchiveAlias || !/^[A-Za-z0-9._-]+$/.test(rawArchiveAlias))) {
    defects.push({ field: "rawArchiveAlias", reason: "invalid_archive_alias" });
  }
  if (defects.length > 0) return { ok: false, defects };

  const fields = normalizedFields as HandoffInput;

  for (const field of ["evidence", "external", "exclusions", "recover"] as const) {
    if (fields[field].toLowerCase() === "none") fields[field] = "none";
  }

  const rawArchiveLine = rawArchiveAlias ? `Raw archive: ${rawArchiveAlias}` : undefined;
  const recoverLines = fields.recover.split("\n").map((line) => line.trim());
  if (rawArchiveLine && !recoverLines.includes(rawArchiveLine) && !recoverLines.includes(rawArchiveAlias!)) {
    fields.recover = fields.recover === "none"
      ? rawArchiveLine
      : `${fields.recover}\n${rawArchiveLine}`;
  }

  return {
    ok: true,
    value: {
      fields,
      text: [
        ACM_CONTINUATION_MARKER,
        ...FIELD_ORDER.map(({ field, label }) => renderField(label, fields[field])),
      ].join("\n"),
    },
  };
}

/**
 * Derive a return-ticket name from the handoff goal: the first few
 * significant words as a slug, suffixed to stay unique among existing names.
 * Alias charset must satisfy the checkpoint name pattern ^[A-Za-z0-9._-]+$.
 */
export function deriveReturnTicketName(goal: string, taken: (name: string) => boolean): string {
  // Dedupe surviving tokens: a mostly non-Latin goal often leaves the same
  // tool identifier several times, and "acm-acm_checkpoint-acm_timeline-..."
  // is not a name anyone can pick from the checkpoints view.
  const seen = new Set<string>();
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !seen.has(word) && (seen.add(word), true))
    .slice(0, 4);
  // A slug with no alphanumeric signal (non-Latin goals collapse entirely,
  // punctuation-only goals leave residue like "----...") is not a name a
  // human can pick from the checkpoints view; fall back to the plain stem.
  const slug = words.join("-").slice(0, 48).replace(/-+$/, "");
  const base = /[a-z0-9]/.test(slug) ? `${slug}-raw` : "fold-raw";
  if (!taken(base) && base !== "root") return base;
  for (let ordinal = 2; ordinal < 1000; ordinal++) {
    const candidate = `${base}-${ordinal}`;
    if (!taken(candidate)) return candidate;
  }
  // Timestamp fallback goes through the same collision check: a taken
  // timestamp candidate (same-millisecond callers, imported labels) walks
  // forward until a free name is found.
  const stamp = Date.now().toString(36);
  for (let ordinal = 0; ordinal < 1000; ordinal++) {
    const candidate = ordinal === 0 ? `${base}-${stamp}` : `${base}-${stamp}-${ordinal}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}
