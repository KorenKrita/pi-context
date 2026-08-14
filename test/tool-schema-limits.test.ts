import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerTravelTool } from "../src/travel-tool.js";

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

  test("prepareArguments leaves supplied values and string handoffs untouched", () => {
    const travel = captureTool(registerTravelTool as unknown as (pi: ExtensionAPI) => void);
    const full = { target: "t", backupCurrentHeadAs: "keep", handoff: { goal: "g", state: "s", next: "n", evidence: "e", external: "x", exclusions: "c", recover: "r" } };
    expect(travel.prepareArguments!(full)).toEqual(full);

    const stringHandoff = { target: "t", handoff: "{\"goal\":\"g\"}" };
    const prepared = travel.prepareArguments!(stringHandoff) as { handoff: unknown };
    expect(prepared.handoff).toBe(stringHandoff.handoff);

    expect(travel.prepareArguments!("not-an-object")).toBe("not-an-object");
  });
});
