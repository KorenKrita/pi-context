import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiRpcArgs,
  classifySkillAvailability,
  CONTEXT_MANAGEMENT_COMMAND,
  assertTurnCompleted,
  finalAssistantOutcome,
  FULL_ENV_DENIED_TOOLS,
  PiRpcDriver,
  sanitizePiChildEnvironment,
  SESSION_RECALL_TOOLS,
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
const LOCAL_PI_081 = join(process.cwd(), "node_modules", ".bin", "pi");
const expectedCommand = (path = EXPECTED_SKILL) => ({
  name: CONTEXT_MANAGEMENT_COMMAND,
  source: "skill",
  sourceInfo: { path, scope: "temporary", origin: "top-level", source: "cli" },
});

describe("Pi RPC eval environment composition", () => {
  test("raw-control disables discovery and injects no product resources", () => {
    expect(buildPiRpcArgs({ ...BASE, environmentMode: "raw-control", extensionPaths: [], skillPaths: [] }))
      .toEqual([
        "--mode", "rpc",
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--approve",
        "--session-dir", "/sessions", "--provider", "local-openai", "--model", "fixture",
      ]);
  });
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
    expect(args).toEqual(expect.arrayContaining(["--exclude-tools", FULL_ENV_DENIED_TOOLS.join(",")]));
    expect(FULL_ENV_DENIED_TOOLS).toEqual(expect.arrayContaining(SESSION_RECALL_TOOLS));
    expect(args).toEqual(expect.arrayContaining(["-e", "/checkout/src/index.ts", "--skill", EXPECTED_SKILL]));
  });
});

test("Pi child environment removes secrets and private flow seed while retaining runtime essentials", () => {
  const sanitized = sanitizePiChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/fixture",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    ACM_FLOW_SEED: "oracle-seed",
    ACM_MATRIX_ID: "matrix-1",
    ACM_INTEGRITY_AUDIT_PATH: "/outside/audit.jsonl",
  });

  expect(sanitized).toMatchObject({
    PATH: "/usr/bin",
    HOME: "/Users/fixture",
    LANG: "en_US.UTF-8",
    ACM_INTEGRITY_AUDIT_PATH: "/outside/audit.jsonl",
  });
  expect(sanitized.OPENAI_API_KEY).toBeUndefined();
  expect(sanitized.GITHUB_TOKEN).toBeUndefined();
  expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(sanitized.ACM_FLOW_SEED).toBeUndefined();
  expect(sanitized.ACM_MATRIX_ID).toBeUndefined();
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

  test("raw-control also requires the product Skill command to be absent", () => {
    expect(classifySkillAvailability({
      environmentMode: "raw-control",
      expectedSkillPath: EXPECTED_SKILL,
      commands: [],
      realpath,
    })).toMatchObject({ valid: true, status: "absent_as_expected" });
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

test("public RPC telemetry and host-perturbation helpers use their exact command names", async () => {
  const driver = new PiRpcDriver(BASE);
  const received = [];
  driver.request = async (command) => {
    received.push(command);
    switch (command.type) {
      case "get_state": return { success: true, data: { model: { id: "fixture" } } };
      case "get_available_models": return { success: true, data: { models: [{ id: "fixture" }] } };
      case "get_available_thinking_levels": return { success: true, data: { levels: ["medium", "high"] } };
      case "compact": return { success: true, data: { summary: "folded" } };
      case "get_entries": return { success: true, data: { entries: [], leafId: null } };
      case "get_messages": return { success: true, data: { messages: [] } };
      case "get_session_stats": return { success: true, data: { entries: 0 } };
      default: return { success: false, error: "unexpected" };
    }
  };

  await expect(driver.getState()).resolves.toEqual({ model: { id: "fixture" } });
  await expect(driver.getAvailableModels()).resolves.toEqual([{ id: "fixture" }]);
  await expect(driver.getThinkingLevels()).resolves.toEqual(["medium", "high"]);
  await expect(driver.compact("keep facts")).resolves.toEqual({ summary: "folded" });
  await expect(driver.getEntries("entry-1")).resolves.toEqual({ entries: [], leafId: null });
  await expect(driver.getMessages()).resolves.toEqual([]);
  await expect(driver.getSessionStats()).resolves.toEqual({ entries: 0 });
  expect(received).toEqual([
    { type: "get_state" },
    { type: "get_available_models" },
    { type: "get_available_thinking_levels" },
    { type: "compact", customInstructions: "keep facts" },
    { type: "get_entries", since: "entry-1" },
    { type: "get_messages" },
    { type: "get_session_stats" },
  ]);
});

test("runs public audit RPC helpers through the explicitly selected local Pi 0.81.1 binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-driver-081-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [],
    quietStartup: true,
    defaultProjectTrust: "always",
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:1",
        api: "openai-completions",
        models: [{
          id: "fixture",
          name: "Fixture",
          contextWindow: 400000,
          maxTokens: 16000,
          reasoning: true,
          thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
        }],
      },
    },
  }));
  const driver = new PiRpcDriver({
    cwd,
    agentDir,
    sessionDir,
    environmentMode: "core-only",
    extensionPaths: [],
    skillPaths: [],
    provider: "fixture",
    modelId: "fixture",
    thinkingLevel: "high",
    piBinary: LOCAL_PI_081,
  });

  driver.start();
  try {
    const [state, levels, stats] = await Promise.all([
      driver.getState(),
      driver.getThinkingLevels(),
      driver.getSessionStats(),
    ]);
    expect(state.model.contextWindow).toBe(400000);
    expect(state.model.maxTokens).toBe(16000);
    expect(state.thinkingLevel).toBe("high");
    expect(levels).toContain("high");
    expect(stats.contextUsage.contextWindow).toBe(400000);
    await expect(driver.getEntries()).resolves.toMatchObject({
      entries: expect.any(Array),
      leafId: expect.any(String),
    });
    await expect(driver.getMessages()).resolves.toEqual([]);
  } finally {
    await driver.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

describe("assistant turn completion", () => {
  test("accepts a terminal successful assistant message", () => {
    const events = [{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } }];
    expect(finalAssistantOutcome(events)).toEqual({ stopReason: "stop", errorMessage: null });
    expect(() => assertTurnCompleted(events)).not.toThrow();
  });

  test("rejects provider-error and aborted terminal assistant messages", () => {
    for (const stopReason of ["error", "aborted"]) {
      const events = [{
        type: "message_end",
        message: { role: "assistant", stopReason, errorMessage: `terminal ${stopReason}`, content: [] },
      }];
      expect(() => assertTurnCompleted(events)).toThrow(`assistant turn failed: terminal ${stopReason}`);
    }
  });

  test("rejects a settled turn with no terminal assistant message", () => {
    expect(() => assertTurnCompleted([{ type: "agent_settled" }])).toThrow("assistant turn failed: no terminal assistant message");
  });
});
