import { describe, expect, test } from "bun:test";
import {
  ACM_CONTINUATION_MARKER,
  buildCanonicalHandoff,
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
  test("keeps Evidence optional and non-blocking for NEXT", () => {
    expect(StructuredHandoffSchema.properties.evidence.description).toContain("never a verification checklist or a prerequisite to NEXT");
    expect(StructuredHandoffSchema.properties.evidence.description).toContain("do not point back to folded material merely to reread it");
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
        { field: "goal", reason: "invalid_type" },
        { field: "next", reason: "invalid_type" },
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
});
