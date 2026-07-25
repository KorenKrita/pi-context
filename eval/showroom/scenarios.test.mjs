import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./scenarios.mjs";

const roots = [];
const servicePaths = [
  "billing", "checkout", "inventory", "shipping", "auth", "search",
  "cart", "pricing", "webhook", "ledger", "notify", "report",
].map((service) => `services/${service}.ts`);

function build(id) {
  const root = mkdtempSync(join(tmpdir(), `showroom-${id.toLowerCase()}-`));
  roots.push(root);
  const workspace = join(root, "workspace");
  const builder = { user() {}, assistantText() {} };
  return { workspace, expected: SCENARIOS[id].build(builder, { workspace }) };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("showroom boundary-cue scenario sizing", () => {
  for (const id of ["P4", "P5"]) {
    test(`${id} requires an explicit 12-file read sweep`, () => {
      const { workspace, expected } = build(id);
      expect(readdirSync(join(workspace, "services")).length).toBe(12);
      const livePrompt = expected.resumePrompts[0];
      expect(livePrompt).toContain("用 read 打开");
      for (const path of servicePaths) expect(livePrompt).toContain(path);
    });
  }
});
