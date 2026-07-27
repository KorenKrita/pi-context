import { Type, type Static } from "@earendil-works/pi-ai";

export const ACM_CONTINUATION_MARKER = "<!-- PI-CONTEXT:ACM-CONTINUATION:v1 -->";

// 草根版 handoff schema - 描述简化，核心三个字段必填，其他四个可以写 none
export const StructuredHandoffSchema = Type.Object({
  goal: Type.String({
    minLength: 1,
    description: "当前目标是什么",
  }),
  state: Type.String({
    minLength: 1,
    description: "现在进展到哪了，知道了什么，还不确定什么",
  }),
  evidence: Type.String({
    minLength: 1,
    description: "相关的文件路径、命令等证据。没有就写 none",
  }),
  external: Type.String({
    minLength: 1,
    description: "改过哪些文件、运行过什么命令。没有就写 none",
  }),
  exclusions: Type.String({
    minLength: 1,
    description: "试过但行不通的方向。没有就写 none",
  }),
  recover: Type.String({
    minLength: 1,
    description: "可以回退的存档点。没有就写 none",
  }),
  next: Type.String({
    minLength: 1,
    description: "下一步要做什么",
  }),
}, { additionalProperties: false });

export const HandoffSchema = Type.Union([
  StructuredHandoffSchema,
  Type.String({
    minLength: 1,
    description: "也可以传 JSON 字符串格式的 handoff 对象",
  }),
], {
  description: "交接单。核心三个字段: goal(目标), state(现状), next(下一步)。其他字段没有就写 none。",
});

export type HandoffInput = Static<typeof StructuredHandoffSchema>;
export type HandoffWireInput = Static<typeof HandoffSchema>;
export type HandoffField = keyof HandoffInput;

export type HandoffDefect =
  | { field: HandoffField; reason: "empty" | "none_not_allowed" | "invalid_type" }
  | { field: "handoff"; reason: "invalid_json" }
  | { field: "handoff"; reason: "unexpected_field"; name: string }
  | { field: "rawArchiveAlias"; reason: "invalid_archive_alias" };

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

const AUTHORITATIVE_FIELDS = new Set<HandoffField>(["goal", "state", "next"]);

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
    if (typeof rawValue !== "string") {
      defects.push({ field, reason: "invalid_type" });
      continue;
    }
    const value = normalize(rawValue);
    normalizedFields[field] = value;
    if (value.length === 0) {
      defects.push({ field, reason: "empty" });
    } else if (AUTHORITATIVE_FIELDS.has(field) && value.toLowerCase() === "none") {
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
