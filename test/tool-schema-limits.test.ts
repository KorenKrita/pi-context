import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerTravelTool } from "../src/travel-tool.js";
import { validateToolArguments } from "@earendil-works/pi-ai";

interface CapturedTool {
  name: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  constrainedSampling?: unknown;
}

type SchemaObject = {
  additionalProperties?: unknown;
  description?: unknown;
  minimum?: unknown;
  minLength?: unknown;
  maximum?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  properties?: Record<string, SchemaObject>;
};

function captureTool(register: (pi: ExtensionAPI) => void): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(tool: CapturedTool) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  register(pi);
  if (!captured) throw new Error("tool was not registered");
  return captured;
}

function properties(tool: CapturedTool): Record<string, SchemaObject> {
  const schema = tool.parameters as SchemaObject;
  expect(schema.additionalProperties).toBe(false);
  if (!schema.properties) throw new Error(`${tool.name} parameters are missing properties`);
  return schema.properties;
}

const checkpoint = captureTool((pi) => registerCheckpointTool(pi, {} as never));
const timeline = captureTool((pi) => registerTimelineTool(pi, {} as never));
const travel = captureTool((pi) => registerTravelTool(pi, {} as never));

describe("ACM tool parameter schema limits", () => {
  test("allows long checkpoint names and targets while retaining meaningful-name validation", () => {
    const checkpointProperties = properties(checkpoint);
    const name = checkpointProperties.name!;
    const target = checkpointProperties.target!;

    expect(name).toMatchObject({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$" });
    expect(name).not.toHaveProperty("maxLength");
    expect(target).toMatchObject({ minLength: 1 });
    expect(target).not.toHaveProperty("maxLength");
  });

  test("keeps timeline's positive limit and default while removing arbitrary result and query ceilings", () => {
    const timelineProperties = properties(timeline);
    const limit = timelineProperties.limit!;
    const filter = timelineProperties.filter!;
    const query = timelineProperties.query!;
    const target = timelineProperties.target!;

    expect(limit).toMatchObject({ minimum: 1 });
    expect(limit.description).toContain("Default 50.");
    expect(limit).not.toHaveProperty("maximum");
    for (const value of [filter, query, target]) {
      expect(value).toMatchObject({ minLength: 1 });
      expect(value).not.toHaveProperty("maxLength");
    }

    const view = timelineProperties.view! as SchemaObject & { anyOf?: Array<{ const?: unknown }> };
    const viewLiterals = (view.anyOf ?? []).map((option) => option.const);
    expect(viewLiterals).toContain("node");
  });

  test("allows long travel references and archive aliases while retaining non-empty and alias-format constraints", () => {
    const travelProperties = properties(travel);
    const target = travelProperties.target!;
    const backup = travelProperties.backupCurrentHeadAs!;

    expect(target).toMatchObject({ minLength: 1 });
    expect(target).not.toHaveProperty("maxLength");
    const backupBranches = (backup as { anyOf?: SchemaObject[] }).anyOf ?? [];
    const backupString = backupBranches.find((branch) => (branch as { type?: string }).type === "string");
    expect(backupString).toMatchObject({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$" });
    expect(backupString).not.toHaveProperty("maxLength");
    expect(backupBranches.some((branch) => (branch as { type?: string }).type === "null")).toBe(true);
  });

  test("defines backupCurrentHeadAs as a new alias rather than an existing target", () => {
    const backup = properties(travel).backupCurrentHeadAs!;
    const description = String(backup.description ?? "");

    expect(description).toContain("automatic return ticket");
    expect(description).toContain("Omit");
  });
});

describe("acm_travel strict-mode compatibility", () => {
  test("declares json_schema constrained sampling as prefer, never require", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    expect(travel.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  test("prepareArguments fills omitted supporting fields with null for non-strict callers", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const prepared = travel.prepareArguments!({
      target: "probe",
      handoff: { goal: "g", state: "s", next: "n" },
    }) as { handoff: Record<string, unknown>; backupCurrentHeadAs: unknown };

    expect(prepared.handoff).toEqual({
      goal: "g", state: "s", next: "n",
      evidence: null, external: null, exclusions: null, recover: null,
    });
    expect(prepared.backupCurrentHeadAs).toBeNull();
  });

  test("prepareArguments decodes legacy JSON-string handoffs and rejects free-form text", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const full = { target: "t", backupCurrentHeadAs: "keep", handoff: { goal: "g", state: "s", next: "n", evidence: "e", external: "x", exclusions: "c", recover: "r" } };
    expect(travel.prepareArguments!(full)).toEqual(full);

    const stringHandoff = { target: "t", handoff: JSON.stringify({ goal: "g", state: "s", next: "n" }) };
    const prepared = travel.prepareArguments!(stringHandoff) as { handoff: unknown };
    expect(prepared.handoff).toEqual({ goal: "g", state: "s", next: "n", evidence: null, external: null, exclusions: null, recover: null });

    expect(() => travel.prepareArguments!({ target: "t", handoff: "continue the work" }))
      .toThrow(/handoff:invalid_json/);

    expect(travel.prepareArguments!("not-an-object")).toBe("not-an-object");
  });

  test("prepareArguments rejects wrong wire types before host coercion can legalize them", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    expect(() => travel.prepareArguments!({ target: "t", handoff: { goal: 42, state: "s", next: "n" } }))
      .toThrow(/goal:invalid_type \(expected string, got number\)/);
    expect(() => travel.prepareArguments!({ target: "t", handoff: { goal: "g", state: "s", next: "n", evidence: ["a.md"] } }))
      .toThrow(/evidence:invalid_type \(expected string \| null, got array\)/);
    expect(() => travel.prepareArguments!({ target: "t", handoff: { goal: "g", state: "s", next: "n", files: "x" } }))
      .toThrow(/handoff:unexpected_field \('files' is not a handoff field\)/);
    expect(() => travel.prepareArguments!({ target: "t", handoff: { goal: "g", state: "s", next: "n" }, backupCurrentHeadAs: 7 }))
      .toThrow(/backupCurrentHeadAs must be a string or null \(got number\)/);
  });

  test("the provider-visible schema rejects a plain string handoff", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const tool = travel as unknown as { parameters: unknown };
    expect(() => validateToolArguments(
      tool as never,
      { id: "probe", name: "acm_travel", arguments: { target: "root", handoff: "continue the work", backupCurrentHeadAs: null } },
    )).toThrow(/handoff/);
    const prepared = travel.prepareArguments!({ target: "root", handoff: { goal: "g", state: "s", next: "n" } });
    const valid = validateToolArguments(
      tool as never,
      { id: "probe", name: "acm_travel", arguments: prepared },
    );
    expect(valid.handoff).toEqual({ goal: "g", state: "s", next: "n", evidence: null, external: null, exclusions: null, recover: null });
  });

  test("prepareArguments rejects non-string targets before host coercion can resolve them", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    // On prefer-degraded channels Value.Convert would turn 42/null/true into
    // "42"/"null"/"true" and validation would pass — a checkpoint carrying one
    // of those legal alias names would then receive a real fold instead of a
    // wire-type rejection.
    for (const [raw, got] of [[42, "number"], [null, "null"], [true, "boolean"]] as const) {
      expect(() => travel.prepareArguments!({ target: raw, handoff: { goal: "g", state: "s", next: "n" } }))
        .toThrow(new RegExp(`target must be a string \\(got ${got}\\)`));
    }
  });

  test("a legacy JSON-string handoff is rescued by prepare and passes host validation", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const tool = travel as unknown as { parameters: unknown };
    const prepared = travel.prepareArguments!({
      target: "root",
      handoff: JSON.stringify({ goal: "g", state: "s", next: "n" }),
    });
    const valid = validateToolArguments(tool as never, { id: "probe", name: "acm_travel", arguments: prepared });
    expect(valid.handoff).toEqual({ goal: "g", state: "s", next: "n", evidence: null, external: null, exclusions: null, recover: null });
  });

  test("a well-formed call survives the full prepare → validate sequence unchanged", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const tool = travel as unknown as { parameters: unknown };
    const prepared = travel.prepareArguments!({ target: "root", handoff: { goal: "g", state: "s", next: "n" }, backupCurrentHeadAs: "keep" });
    const valid = validateToolArguments(tool as never, { id: "probe", name: "acm_travel", arguments: prepared });
    expect(valid.target).toBe("root");
    expect(valid.backupCurrentHeadAs).toBe("keep");
  });
});

// Guards against a real incident: a packaging commit once replaced AGENTS.md
// wholesale with TypeScript source (an errant write target), and the whole
// verify gate stayed green because nothing looks at markdown. These are
// cheap structural checks on the files the extension ships.
describe("documentation file integrity", () => {
  test("AGENTS.md is markdown and never source code", async () => {
    const file = Bun.file("AGENTS.md");
    expect(file.size).toBeGreaterThan(1000);
    const text = await file.text();
    expect(text.startsWith("# AGENTS.md")).toBe(true);
    expect(text).not.toMatch(/^import .* from "node:/m);
  });

  test("no shipped markdown file embeds node imports", async () => {
    // Enumerate from the package manifest, not a hand list: whatever the
    // extension ships as markdown must be markdown.
    const pkg = await Bun.file("package.json").json();
    const shipped: string[] = [];
    const walk = async (entry: string) => {
      if (entry.endsWith(".md")) {
        shipped.push(entry);
        return;
      }
      // Manifest entries name directories without trailing slashes (src,
      // guidance) as well as globs: enumerate what each actually covers.
      const directory = entry.replace(/\*+$/, "").replace(/\/$/, "");
      for (const path of new Bun.Glob(`${directory}/**/*.md`).scanSync(".")) shipped.push(path);
    };
    for (const entry of [...(pkg.files ?? []), "AGENTS.md", "README.md"]) await walk(entry);
    expect(shipped).toContain("AGENTS.md");
    expect(shipped).toContain("guidance/CORE.md"); // canonical docs must be covered
    for (const path of new Set(shipped)) {
      const file = Bun.file(path);
      if (!(await file.exists())) continue; // globs may match nothing under a path
      const text = await file.text();
      expect(text).not.toMatch(/^import .* from "node:/m);
    }
  });
});
