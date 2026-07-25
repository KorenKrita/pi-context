import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseArgs } from "./run-pair.mjs";

describe("showroom paired runner arguments", () => {
  test("normalizes a relative output root before arm cwd changes", () => {
    const args = parseArgs([
      "node",
      "run-pair.mjs",
      "--scenario", "P1",
      "--model", "local-claude/claude-opus-4-8",
      "--out", "eval/.runs/showroom/formal",
    ]);

    expect(args.out).toBe(resolve("eval/.runs/showroom/formal"));
  });
});
