import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copySessionForWorkspace, parseArgs } from "./run-pair.mjs";
const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

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

  test("rebinds copied session cwd to the isolated arm workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "showroom-run-pair-"));
    roots.push(root);
    const source = join(root, "base.jsonl");
    const target = join(root, "arm.jsonl");
    const armWorkspace = join(root, "on", "workspace");
    const message = { type: "message", id: "m1", parentId: null };
    writeFileSync(source, [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: join(root, "base", "workspace") }),
      JSON.stringify(message),
      "",
    ].join("\n"));

    copySessionForWorkspace(source, target, armWorkspace);

    const copied = readFileSync(target, "utf8").trim().split("\n").map(JSON.parse);
    expect(copied[0]).toEqual({ type: "session", version: 3, id: "s1", cwd: resolve(armWorkspace) });
    expect(copied[1]).toEqual(message);
    expect(JSON.parse(readFileSync(source, "utf8").split("\n")[0]).cwd).toBe(join(root, "base", "workspace"));
  });
});
