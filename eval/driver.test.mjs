import { describe, expect, test } from "bun:test";
import {
  buildPiRpcArgs,
  classifySkillAvailability,
  CONTEXT_MANAGEMENT_COMMAND,
  PiRpcDriver,
} from "./driver.mjs";

const BASE = {
  cwd: "/workspace",
  agentDir: "/agent",
  sessionDir: "/sessions",
  provider: "local-openai",
  modelId: "fixture",
};

const EXPECTED_SKILL = "/checkout/skills/context-management/SKILL.md";
const OTHER_SKILL = "/another/skills/context-management/SKILL.md";
const realpath = (path) => path;
const expectedCommand = (path = EXPECTED_SKILL) => ({
  name: CONTEXT_MANAGEMENT_COMMAND,
  source: "skill",
  sourceInfo: { path, scope: "temporary", origin: "top-level", source: "cli" },
});

describe("Pi RPC eval environment composition", () => {
  test("core-only keeps discovery disabled while loading only its explicit extension", () => {
    expect(buildPiRpcArgs({ ...BASE, environmentMode: "core-only", extensionPaths: ["/checkout/src/index.ts"] }))
      .toEqual([
        "--mode", "rpc",
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--approve",
        "-e", "/checkout/src/index.ts",
        "--session-dir", "/sessions", "--provider", "local-openai", "--model", "fixture",
      ]);
  });

  test("product-isolated keeps discovery disabled but explicitly injects both extensions and the checked-out Skill", () => {
    const args = buildPiRpcArgs({
      ...BASE,
      environmentMode: "product-isolated",
      extensionPaths: ["/checkout/src/index.ts", "/checkout/src/context.ts"],
      skillPaths: [EXPECTED_SKILL],
      thinkingLevel: "high",
    });

    expect(args).toContain("--no-skills");
    expect(args).toEqual(expect.arrayContaining([
      "-e", "/checkout/src/index.ts",
      "-e", "/checkout/src/context.ts",
      "--skill", EXPECTED_SKILL,
      "--thinking", "high",
    ]));
  });

  test("full-env omits discovery guards and accepts legacy fullEnv as an alias", () => {
    const args = buildPiRpcArgs({
      ...BASE,
      fullEnv: true,
      extensionPath: "/checkout/src/index.ts",
      skillPath: EXPECTED_SKILL,
    });

    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--no-skills");
    expect(args).toEqual(expect.arrayContaining(["-e", "/checkout/src/index.ts", "--skill", EXPECTED_SKILL]));
  });
});

describe("context-management Skill availability gate", () => {
  test("core-only requires the Skill command to be absent", () => {
    expect(classifySkillAvailability({
      environmentMode: "core-only",
      expectedSkillPath: EXPECTED_SKILL,
      commands: [],
      realpath,
    })).toMatchObject({ valid: true, status: "absent_as_expected" });

    expect(classifySkillAvailability({
      environmentMode: "core-only",
      expectedSkillPath: EXPECTED_SKILL,
      commands: [expectedCommand()],
      realpath,
    })).toMatchObject({ valid: false, status: "unexpected_skill" });
  });

  test("product modes reject missing, duplicate, and mismatched provenance", () => {
    const common = { environmentMode: "product-isolated", expectedSkillPath: EXPECTED_SKILL, realpath };

    expect(classifySkillAvailability({ ...common, commands: [] }))
      .toMatchObject({ valid: false, status: "missing" });
    expect(classifySkillAvailability({ ...common, commands: [expectedCommand(), expectedCommand()] }))
      .toMatchObject({ valid: false, status: "duplicate" });
    expect(classifySkillAvailability({ ...common, commands: [expectedCommand(OTHER_SKILL)] }))
      .toMatchObject({ valid: false, status: "path_mismatch", expectedSkillPath: EXPECTED_SKILL, discoveredSkillPath: OTHER_SKILL });
  });

  test("accepts exactly one checked-out Skill and preserves its provenance", () => {
    expect(classifySkillAvailability({
      environmentMode: "full-env",
      expectedSkillPath: EXPECTED_SKILL,
      commands: [expectedCommand()],
      realpath,
    })).toMatchObject({
      valid: true,
      status: "available_from_expected_checkout",
      expectedSkillPath: EXPECTED_SKILL,
      discoveredSkillPath: EXPECTED_SKILL,
      matches: [{ name: CONTEXT_MANAGEMENT_COMMAND, source: "skill" }],
    });
  });

  test("marks RPC failure as infrastructure-invalid evidence", () => {
    expect(classifySkillAvailability({
      environmentMode: "product-isolated",
      expectedSkillPath: EXPECTED_SKILL,
      rpcError: "RPC response timeout for get_commands after 30000ms",
      realpath,
    })).toMatchObject({ valid: false, status: "rpc_failure" });
  });
});

test("getCommands propagates a rejected RPC response without running a prompt", async () => {
  const driver = new PiRpcDriver(BASE);
  driver.request = async () => ({ success: false, error: "unavailable" });
  await expect(driver.getCommands()).rejects.toThrow("get_commands rejected: unavailable");
});
