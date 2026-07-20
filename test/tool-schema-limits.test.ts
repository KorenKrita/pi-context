import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { registerTimelineTool } from "../src/timeline-tool.js";
import { registerTravelTool } from "../src/travel-tool.js";

interface CapturedTool {
  name: string;
  parameters: unknown;
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

const checkpoint = captureTool(registerCheckpointTool);
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

    expect(limit).toMatchObject({ minimum: 1 });
    expect(limit.description).toContain("Default 50.");
    expect(limit).not.toHaveProperty("maximum");
    for (const value of [filter, query]) {
      expect(value).toMatchObject({ minLength: 1 });
      expect(value).not.toHaveProperty("maxLength");
    }
  });

  test("allows long travel references and archive aliases while retaining non-empty and alias-format constraints", () => {
    const travelProperties = properties(travel);
    const target = travelProperties.target!;
    const backup = travelProperties.backupCurrentHeadAs!;

    expect(target).toMatchObject({ minLength: 1 });
    expect(target).not.toHaveProperty("maxLength");
    expect(backup).toMatchObject({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$" });
    expect(backup).not.toHaveProperty("maxLength");
  });
});
