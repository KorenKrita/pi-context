import { Type, type Static } from "@earendil-works/pi-ai";

export const ACM_CONTINUATION_MARKER = "<!-- PI-CONTEXT:ACM-CONTINUATION:v1 -->";

// wire 上只有 goal/state/next 必填；四个辅助字段可省略，缺省按 "none" 处理。
// 持久化文本始终渲染完整七行——解析锚点与 continuation 投影依赖固定格式。
export const StructuredHandoffSchema = Type.Object({
  goal: Type.String({
    minLength: 1,
    description: "这项工作要完成什么，包括还欠用户的交付。",
  }),
  state: Type.String({
    minLength: 1,
    description: "已知什么、还有什么不确定，以及接下来要用的具体值、路径、名字。可以写多行。",
  }),
  next: Type.String({
    minLength: 1,
    description: "现在立刻要做的下一步，写成一个具体动作。",
  }),
  evidence: Type.Optional(Type.String({
    description: "可选：支撑 state 的文件路径、命令、ID。",
  })),
  external: Type.Optional(Type.String({
    description: "可选：对话之外的持久副作用——改过的文件、跑过的命令、动过的系统。",
  })),
  exclusions: Type.Optional(Type.String({
    description: "可选：试过并排除的方向，避免重踩。",
  })),
  recover: Type.Optional(Type.String({
    description: "可选：能找回被折叠历史的存档名或节点 ID。",
  })),
}); // 不校验多余字段：认识的按槽位放，不认识的原样并入 state——模型写什么，未来就拿到什么。

export const HandoffSchema = Type.Union([
  StructuredHandoffSchema,
  Type.String({
    minLength: 1,
    description: "兼容回退：把同一个交接单对象 JSON 序列化成字符串也可以，但不接受自由文本。",
  }),
], {
  description: "交接单对象（goal/state/next 必填，其余可选）；也接受同一对象的 JSON 字符串编码。",
});

/** 规范化后的完整七字段形态；可选字段缺省补 "none"。 */
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
  | { field: HandoffField; reason: "empty" | "none_not_allowed" | "invalid_type" }
  | { field: "handoff"; reason: "invalid_json" }
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
  facts: { rawArchiveAlias?: string; originEntryId?: string } = {},
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
      // 可选字段缺省补 "none"；必填字段缺失按类型缺陷报告。
      if (required) defects.push({ field, reason: "invalid_type" });
      else normalizedFields[field] = "none";
      continue;
    }
    if (typeof rawValue !== "string") {
      defects.push({ field, reason: "invalid_type" });
      continue;
    }
    const value = normalize(rawValue);
    if (value.length === 0) {
      // 可选字段传了空串等价于省略；必填字段空是缺陷。
      if (required) defects.push({ field, reason: "empty" });
      else normalizedFields[field] = "none";
      continue;
    }
    normalizedFields[field] = value;
    if (required && value.toLowerCase() === "none") {
      defects.push({ field, reason: "none_not_allowed" });
    }
  }
  // 不校验多余字段：模型写什么，交接单就带什么——原样并入 state 的续行。
  const knownFields = new Set<string>(FIELD_ORDER.map(({ field }) => field));
  const extraLines: string[] = [];
  for (const [name, rawValue] of Object.entries(inputRecord)) {
    if (knownFields.has(name)) continue;
    const value = typeof rawValue === "string" ? normalize(rawValue) : JSON.stringify(rawValue);
    if (value) extraLines.push(`${name}: ${value}`);
  }
  const rawArchiveAlias = facts.rawArchiveAlias === undefined
    ? undefined
    : normalize(facts.rawArchiveAlias);
  if (facts.rawArchiveAlias !== undefined && (!rawArchiveAlias || !/^[^\s\p{Cc}]+$/u.test(rawArchiveAlias))) {
    defects.push({ field: "rawArchiveAlias", reason: "invalid_archive_alias" });
  }
  if (defects.length > 0) return { ok: false, defects };

  const fields = normalizedFields as HandoffInput;
  if (extraLines.length > 0) {
    fields.state = `${fields.state}\n${extraLines.join("\n")}`;
  }

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
  // 自动回程票：折叠前的叶节点 ID 写进 Recover，不用先存档也能回去。
  const originEntryId = facts.originEntryId?.trim();
  if (originEntryId) {
    const originLine = `Origin: ${originEntryId}`;
    const lines = fields.recover.split("\n").map((line) => line.trim());
    if (!lines.includes(originLine) && !lines.includes(originEntryId) && !fields.recover.includes(originEntryId)) {
      fields.recover = fields.recover === "none" ? originLine : `${fields.recover}\n${originLine}`;
    }
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
