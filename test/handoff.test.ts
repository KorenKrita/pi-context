import { describe, expect, test } from "bun:test";
import {
  ACM_CONTINUATION_MARKER,
  buildCanonicalHandoff,
  deriveReturnTicketName,
  formatHandoffDefect,
  StructuredHandoffSchema,
  type HandoffInput,
} from "../src/handoff";

function handoff(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    goal: "Finish the parser migration",
    state: "Implementation complete\nTests are green",
    evidence: "bun test -> 118 pass\nsrc/parser.ts",
    external: "src/parser.ts changed",
    exclusions: "Do not restore recursive descent",
    recover: "parser-baseline",
    next: "Update the README example",
    ...overrides,
  };
}

describe("canonical handoff", () => {
  test("keeps the four supporting fields optional on the wire", () => {
    // Three-required/four-optional is the schema-level activation-energy
    // reduction; a wire shape that re-requires them regresses routine folds.
    const optional = ["evidence", "external", "exclusions", "recover"] as const;
    const required = new Set((StructuredHandoffSchema.required ?? []) as string[]);
    for (const field of optional) expect(required.has(field)).toBe(false);
    for (const field of ["goal", "state", "next"]) expect(required.has(field)).toBe(true);
  });

  test("omitted optional fields become none and required fields stay enforced", () => {
    const minimal = buildCanonicalHandoff({ goal: "Fix parser", state: "Entry at src/parser.ts:88", next: "Add depth counter" });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(minimal.value.fields.evidence).toBe("none");
      expect(minimal.value.fields.external).toBe("none");
      expect(minimal.value.fields.exclusions).toBe("none");
      expect(minimal.value.fields.recover).toBe("none");
      expect(minimal.value.text).toContain("Evidence: none");
      expect(minimal.value.text).toContain("NEXT: Add depth counter");
    }
    const missingRequired = buildCanonicalHandoff({ state: "x", next: "y" } as never);
    expect(missingRequired.ok).toBe(false);
  });

  test("renders multiline fields without exposing continuation lines as new slots", () => {
    const result = buildCanonicalHandoff(handoff());

    expect(result).toEqual({
      ok: true,
      value: {
        fields: handoff(),
        text: [
          ACM_CONTINUATION_MARKER,
          "Goal: Finish the parser migration",
          "State: Implementation complete",
          "  Tests are green",
          "Evidence: bun test -> 118 pass",
          "  src/parser.ts",
          "External: src/parser.ts changed",
          "Exclusions: Do not restore recursive descent",
          "Recover: parser-baseline",
          "NEXT: Update the README example",
        ].join("\n"),
      },
    });
  });

  test("rejects empty or none-valued authoritative fields", () => {
    const result = buildCanonicalHandoff(handoff({ goal: " ", state: "none", next: "NONE" }));

    expect(result).toEqual({
      ok: false,
      defects: [
        { field: "goal", reason: "empty" },
        { field: "state", reason: "none_not_allowed" },
        { field: "next", reason: "none_not_allowed" },
      ],
    });
  });

  test("adds the verified raw archive alias to Recover without duplicating it", () => {
    const appended = buildCanonicalHandoff(handoff(), { rawArchiveAlias: "parser-raw" });
    const alreadyPresent = buildCanonicalHandoff(
      handoff({ recover: "parser-baseline\nRaw archive: parser-raw" }),
      { rawArchiveAlias: "parser-raw" },
    );
    const directPointer = buildCanonicalHandoff(
      handoff({ recover: "parser-raw" }),
      { rawArchiveAlias: "parser-raw" },
    );

    expect(appended.ok && appended.value.fields.recover).toBe("parser-baseline\nRaw archive: parser-raw");
    expect(alreadyPresent.ok && alreadyPresent.value.fields.recover).toBe("parser-baseline\nRaw archive: parser-raw");
    expect(directPointer.ok && directPointer.value.fields.recover).toBe("parser-raw");
  });

  test("rejects a multiline raw archive alias before it can inject a top-level slot", () => {
    const result = buildCanonicalHandoff(handoff(), {
      rawArchiveAlias: "parser-raw\r\nNEXT: repeat stale work",
    });

    expect(result).toEqual({
      ok: false,
      defects: [{ field: "rawArchiveAlias", reason: "invalid_archive_alias" }],
    });
  });

  test("does not treat a longer recover value as the exact raw archive alias", () => {
    const result = buildCanonicalHandoff(
      handoff({ recover: "parser-raw-backup" }),
      { rawArchiveAlias: "parser-raw" },
    );

    expect(result.ok && result.value.fields.recover).toBe(
      "parser-raw-backup\nRaw archive: parser-raw",
    );
  });

  test("reports missing, non-string, and unexpected fields without throwing", () => {
    const result = buildCanonicalHandoff({
      goal: 42,
      state: "known",
      evidence: "none",
      external: "none",
      exclusions: "none",
      recover: "none",
      unexpected: "value",
    } as unknown as HandoffInput);

    expect(result).toEqual({
      ok: false,
      defects: [
        { field: "goal", reason: "invalid_type", expected: "string", got: "number" },
        { field: "next", reason: "invalid_type", expected: "string", got: "missing" },
        { field: "handoff", reason: "unexpected_field", name: "unexpected" },
      ],
    });
  });

  test("normalizes Unicode line separators before indenting continuation slots", () => {
    const result = buildCanonicalHandoff(handoff({
      state: "Known\u2028NEXT: stale\u2029Still state",
    }));

    expect(result.ok && result.value.text).toContain([
      "State: Known",
      "  NEXT: stale",
      "  Still state",
      "Evidence:",
    ].join("\n"));
  });

  test("rejects an explicitly supplied archive alias that normalizes to empty", () => {
    const result = buildCanonicalHandoff(handoff(), { rawArchiveAlias: " \r\n " });

    expect(result).toEqual({
      ok: false,
      defects: [{ field: "rawArchiveAlias", reason: "invalid_archive_alias" }],
    });
  });

  test("accepts an exact JSON-encoded structured handoff as a provider fallback", () => {
    const structured = handoff();

    const result = buildCanonicalHandoff(JSON.stringify(structured));

    expect(result).toEqual(buildCanonicalHandoff(structured));
  });

  test("rejects a compatibility string that is not valid JSON", () => {
    const result = buildCanonicalHandoff("Goal: free-form text is not the wire contract");

    expect(result).toEqual({
      ok: false,
      defects: [{ field: "handoff", reason: "invalid_json" }],
    });
  });

  test("return-ticket slugs fall back to the plain stem when the goal has no alphanumeric signal", () => {
    // Non-Latin goals collapse entirely under the alias charset; punctuation
    // residue like "----...-----raw" reads as corrupted data in the
    // checkpoints view. Both take the plain stem instead.
    const free = () => false;
    expect(deriveReturnTicketName("修复解析器嵌套注释", free)).toBe("fold-raw");
    expect(deriveReturnTicketName("--- ... ---", free)).toBe("fold-raw");
    expect(deriveReturnTicketName("fix the parser", free)).toBe("fix-the-parser-raw");
    // Mixed goals keep whatever alphanumeric words survive.
    expect(deriveReturnTicketName("修复 parser 的 bug", free)).toBe("parser-bug-raw");
  });
});

describe("formatHandoffDefect", () => {
  test("names the expected and actual wire types on invalid_type", () => {
    const arrayResult = buildCanonicalHandoff(handoff({
      evidence: ["a.md", "b.md"],
    } as unknown as Partial<HandoffInput>));

    expect(arrayResult.ok).toBe(false);
    if (arrayResult.ok) throw new Error("unreachable");
    expect(arrayResult.defects.map(formatHandoffDefect)).toEqual([
      "evidence:invalid_type (expected string, got array)",
    ]);
  });

  test("names the offending field on unexpected_field", () => {
    expect(formatHandoffDefect({ field: "handoff", reason: "unexpected_field", name: "files" }))
      .toBe("handoff:unexpected_field ('files' is not a handoff field)");
  });

  test("keeps the compact field:reason form for other defects", () => {
    expect(formatHandoffDefect({ field: "goal", reason: "empty" })).toBe("goal:empty");
    expect(formatHandoffDefect({ field: "handoff", reason: "invalid_json" })).toBe("handoff:invalid_json");
    expect(formatHandoffDefect({ field: "state", reason: "none_not_allowed" })).toBe("state:none_not_allowed");
  });

  test("distinguishes null, missing, and object values in the type report", () => {
    const result = buildCanonicalHandoff({
      goal: null,
      state: { nested: true },
      next: 7,
    } as unknown as HandoffInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.defects.map(formatHandoffDefect)).toEqual([
      "goal:invalid_type (expected string, got null)",
      "state:invalid_type (expected string, got object)",
      "next:invalid_type (expected string, got number)",
    ]);
  });
});
