import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  CONTROLLED_MAX_TOKENS,
  CONTROLLED_WINDOWS,
  DEFAULT_FLOW_ID,
  acquireMatrixLock,
  assertCleanGitWorktree,
  assertMatrixWorktreeClean,
  assertPinnedProvenance,
  assertResumeSeed,
  buildSaffronPin,
  buildRunFlowArgs,
  bunRuntimeProvenance,
  createInitialMatrixState,
  createLongFlowMatrixManifest,
  finalMatrixStatus,
  hashContentTree,
  hashExternalCommandResourceTree,
  hashFullEnvLinkedResourceTree,
  hashRepoLocalPiRuntimeTree,
  normalizeGlobalCommandInventory,
  rehashContentTree,
  rehashGlobalCommandInventory,
  releaseMatrixLock,
  runAuditPreflight,
  runFlowChild,
  shouldSkipMatrixCell,
} from "./run-flow-matrix.mjs";

const LINKED_RESOURCE_ROOTS = ["git", "npm", "extensions", "skills", "themes", "agents", "bin"];

function writeFixtureFile(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function makeLinkedResourceAudit(output) {
  const sourceAgentDir = join(output, "source-agent");
  const harnessAgentDir = join(output, "harness-agent");
  const linkedDirectories = LINKED_RESOURCE_ROOTS.map((name) => {
    const source = join(sourceAgentDir, name);
    const target = join(harnessAgentDir, name);
    mkdirSync(source, { recursive: true });
    mkdirSync(harnessAgentDir, { recursive: true });
    symlinkSync(source, target, "dir");
    return { name, source, target };
  });
  writeFixtureFile(join(sourceAgentDir, "extensions", "hook-only.ts"), "export const hook = 'v1';\n");
  writeFixtureFile(join(sourceAgentDir, "extensions", "lib", "imported-module.ts"), "export const imported = 'v1';\n");
  writeFixtureFile(join(sourceAgentDir, "skills", "context-management", "SKILL.md"), "# Fixture skill\n");
  writeFixtureFile(join(sourceAgentDir, "skills", "context-management", "references", "deep.md"), "reference v1\n");
  writeFixtureFile(join(sourceAgentDir, "skills", "context-management", "scripts", "check.mjs"), "export default 'v1';\n");
  return { sourceAgentDir, harnessAgentDir, linkedDirectories };
}

describe("real Pi long-flow matrix declaration", () => {
  test("declares exactly the requested four model/effort pairs across two controlled windows", () => {
    const manifest = createLongFlowMatrixManifest({ matrixRunId: "matrix-a" });
    expect(manifest.cells).toHaveLength(8);
    expect(CONTROLLED_WINDOWS).toEqual([400_000, 1_000_000]);
    expect(new Set(manifest.cells.map((cell) => cell.contextWindow))).toEqual(new Set([400_000, 1_000_000]));
    expect(new Set(manifest.cells.map((cell) => cell.maxTokensCap))).toEqual(new Set([CONTROLLED_MAX_TOKENS]));
    expect(CONTROLLED_MAX_TOKENS).toBe(16_000);
    expect(manifest.cells.map((cell) => `${cell.model.provider}/${cell.model.modelId}:${cell.thinking}`)).toEqual([
      "local-responses/gpt-5.6-sol:medium",
      "local-responses/gpt-5.6-sol:medium",
      "local-responses/gpt-5.6-terra:high",
      "local-responses/gpt-5.6-terra:high",
      "local-claude/claude-opus-4-6:max",
      "local-claude/claude-opus-4-6:max",
      "local-claude/claude-opus-4-8:high",
      "local-claude/claude-opus-4-8:high",
    ]);
    expect(manifest.flowId).toBe(DEFAULT_FLOW_ID);
    expect(manifest.cells.every((cell) => cell.environmentMode === "full-env" && cell.flowId === DEFAULT_FLOW_ID)).toBe(true);
    expect(new Set(manifest.cells.map((cell) => cell.agentLabel)).size).toBe(8);
    expect(manifest.cells.every((cell) => cell.agentLabel.includes("matrix-a"))).toBe(true);
  });

  test("starts each cell resumable and skips only durable terminal evidence by default", () => {
    const manifest = createLongFlowMatrixManifest({ matrixRunId: "matrix-b" });
    const state = createInitialMatrixState({ manifest, outputDir: "/tmp/acm-flow-matrix", piProvenance: { exact: true } });
    expect(Object.values(state.cells).every((cell) => cell.status === "pending" && cell.attempts === 0)).toBe(true);
    expect(state.secretSeed).toBeUndefined();
    expect(shouldSkipMatrixCell({ classification: "certifying_run" })).toBe(true);
    expect(shouldSkipMatrixCell({ classification: "coverage_insufficient" })).toBe(true);
    expect(shouldSkipMatrixCell({ classification: "occupancy_miss" })).toBe(true);
    expect(shouldSkipMatrixCell({ classification: "task_failure" })).toBe(true);
    expect(shouldSkipMatrixCell({ classification: "infrastructure_invalid" })).toBe(true);
    expect(shouldSkipMatrixCell({ classification: "run_error" })).toBe(false);
    expect(shouldSkipMatrixCell({ status: "pending" })).toBe(false);
  });

  test("delegates every cell to run-flow with Saffron hooks, an exact Pi binary, and controlled caps", async () => {
    const cell = createLongFlowMatrixManifest({ matrixRunId: "matrix-c" }).cells[0];
    const args = buildRunFlowArgs(cell, {
      timeoutScale: 1.5,
      piBinary: "/checkout/node_modules/.bin/pi",
      judgeModel: "local-claude/claude-opus-4-8",
      judgeThinking: "high",
      secretSeed: "secret-seed-for-child",
    });
    expect(args).toEqual(expect.arrayContaining([
      "eval/run-flow.mjs",
      "--full-env",
      "--flow", DEFAULT_FLOW_ID,
      "--context-window", "400000",
      "--max-tokens-cap", "16000",
      "--pi-binary", "/checkout/node_modules/.bin/pi",
      "--agent-label", cell.agentLabel,
      "--variant", cell.id,
      "--matrix-id", "matrix-c",
      "--timeout-scale", "1.5",
      "--judge-model", "local-claude/claude-opus-4-8",
      "--judge-thinking", "high",
      "--flow-seed", "secret-seed-for-child",
    ]));

    const fakeSpawn = (_binary, childArgs, spawnOptions) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", "report: /tmp/saffron-stub/report.json\n");
        child.emit("close", 0, null);
      });
      expect(childArgs).toEqual(args);
      expect(spawnOptions.env.ACM_PI_BINARY).toBe("/checkout/node_modules/.bin/pi");
      expect(spawnOptions.env.ACM_JUDGE_LABEL).toBe(`${cell.agentLabel}-judge`);
      expect(spawnOptions.env.ACM_FLOW_SEED).toBeUndefined();
      expect(spawnOptions.env.PATH.startsWith("/checkout/node_modules/.bin")).toBe(true);
      return child;
    };
    const child = await runFlowChild({
      cell,
      options: {
        timeoutScale: 1.5,
        piBinary: "/checkout/node_modules/.bin/pi",
        judgeModel: "local-claude/claude-opus-4-8",
        judgeThinking: "high",
        secretSeed: "secret-seed-for-child",
      },
      spawnImpl: fakeSpawn,
      bunBinary: "/fake/bun",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout).toContain("report: /tmp/saffron-stub/report.json");
  });

  test("pins byte-identical Saffron prompts across arms from one secret seed", () => {
    const pin = buildSaffronPin("matrix-secret", {
      packetTokenTarget: 2_000,
      earlyDigestTokenTarget: 1_500,
      supplementTokenTarget: 1_500,
    });
    expect(pin.fixtureVersion).toBeTruthy();
    expect(pin.fixtureSha256).toBeTruthy();
    expect(pin.oracleSha256).toBeTruthy();
    expect(pin.promptHashes).toHaveLength(10);
    expect(pin.secretSeedSha256).toHaveLength(64);
  });

  test("audit preflight pins actual global command source files and detects later drift", async () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-preflight-"));
    try {
      const source = join(output, "global-extension.ts");
      const reportPath = join(output, "report.json");
      const fullEnvHarness = makeLinkedResourceAudit(output);
      writeFileSync(source, "export default 'v1';\n");
      writeFileSync(reportPath, `${JSON.stringify({
        status: "completed",
        resources: { fullEnvHarness },
        commands: [{
          name: "global:command",
          source: "extension",
          sourceInfo: { path: source, scope: "user", origin: "package", source: "npm:fixture" },
        }, {
          name: "inline:command",
          source: "skill",
          sourceInfo: { scope: "user", origin: "inline", source: "inline:fixture" },
        }],
      })}\n`);
      const fakeSpawn = (_binary, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.setEncoding = () => {};
        child.stderr.setEncoding = () => {};
        queueMicrotask(() => {
          child.stdout.emit("data", `report: ${reportPath}\n`);
          child.emit("close", 0, null);
        });
        expect(args).toContain("--audit-only");
        return child;
      };
      const preflight = await runAuditPreflight({
        manifest: createLongFlowMatrixManifest({ matrixRunId: "preflight-test" }),
        secretSeed: "preflight-secret",
        piBinary: "/fake/pi",
        spawnImpl: fakeSpawn,
        collectPiRuntimeTree: () => hashContentTree([{ name: "fake-pi-runtime", path: source, boundaryPath: output }]),
        collectBunRuntime: () => ({
          realpath: "/fake/bun",
          version: "1.3.14",
          binarySha256: "a".repeat(64),
          binaryTree: hashContentTree([]),
        }),
      });
      expect(preflight.reportPath).toBe(reportPath);
      expect(preflight.commandInventory.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "file" }),
        expect.objectContaining({ kind: "nonfile" }),
      ]));
      expect(preflight.globalResourceTree.sha256).toHaveLength(64);
      expect(preflight.globalResourceTree.roots.map((root) => root.name)).toEqual([...LINKED_RESOURCE_ROOTS].sort());
      expect(preflight.externalCommandResourceTree.sha256).toHaveLength(64);
      expect(preflight.externalCommandResourceTree.roots).toHaveLength(1);
      expect(preflight.piRuntimeTree.sha256).toHaveLength(64);
      expect(preflight.bunRuntime).toEqual(expect.objectContaining({
        realpath: expect.any(String),
        version: expect.any(String),
        binarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      const originalHash = preflight.commandInventory.sha256;
      writeFileSync(source, "export default 'v2';\n");
      expect(rehashGlobalCommandInventory(preflight.commandInventory).sha256).not.toBe(originalHash);
      expect(normalizeGlobalCommandInventory([]).commands).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("content-tree pin covers global hook-only extensions, imports, and Skill support files", () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-resource-tree-"));
    try {
      const audit = makeLinkedResourceAudit(output);
      const pinned = hashFullEnvLinkedResourceTree(audit);
      expect(rehashContentTree(pinned).sha256).toBe(pinned.sha256);

      writeFixtureFile(join(audit.sourceAgentDir, "extensions", "hook-only.ts"), "export const hook = 'v2';\n");
      expect(rehashContentTree(pinned).sha256).not.toBe(pinned.sha256);

      const repinned = hashFullEnvLinkedResourceTree(audit);
      writeFixtureFile(join(audit.sourceAgentDir, "extensions", "lib", "imported-module.ts"), "export const imported = 'v2';\n");
      expect(rehashContentTree(repinned).sha256).not.toBe(repinned.sha256);

      const skillPinned = hashFullEnvLinkedResourceTree(audit);
      writeFixtureFile(join(audit.sourceAgentDir, "skills", "context-management", "scripts", "check.mjs"), "export default 'v2';\n");
      expect(rehashContentTree(skillPinned).sha256).not.toBe(skillPinned.sha256);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("Pi runtime tree covers hoisted dependencies outside @earendil-works", () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-pi-runtime-tree-"));
    try {
      const nodeModules = join(output, "node_modules");
      const piCli = join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      const hoistedOpenAi = join(nodeModules, "openai", "index.mjs");
      writeFixtureFile(piCli, "export const pi = 'v1';\n");
      writeFixtureFile(hoistedOpenAi, "export const openai = 'v1';\n");
      mkdirSync(join(nodeModules, ".bin"), { recursive: true });
      symlinkSync("../@earendil-works/pi-coding-agent/dist/cli.js", join(nodeModules, ".bin", "pi"));
      const pinned = hashRepoLocalPiRuntimeTree({ nodeModules });
      expect(pinned.roots.map((root) => root.name)).toEqual(["node_modules", "pi-wrapper"]);
      expect(rehashContentTree(pinned).sha256).toBe(pinned.sha256);

      writeFixtureFile(hoistedOpenAi, "export const openai = 'v2';\n");
      expect(rehashContentTree(pinned).sha256).not.toBe(pinned.sha256);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("records the executing Bun binary and version as runtime provenance", () => {
    const bun = bunRuntimeProvenance();
    expect(bun.realpath).toBeTruthy();
    expect(bun.version).toBeTruthy();
    expect(bun.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bun.binaryTree.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("external advertised .agents/skills roots cover references and extension package bases", () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-external-resource-tree-"));
    try {
      const audit = makeLinkedResourceAudit(output);
      const externalAgentRoot = join(output, ".agents");
      const skillDir = join(externalAgentRoot, "skills", "external-skill");
      const skillPath = join(skillDir, "SKILL.md");
      const extensionBaseDir = join(output, "external-extension-package");
      const extensionPath = join(extensionBaseDir, "index.ts");
      const linkedSkillPath = join(audit.harnessAgentDir, "skills", "linked-skill", "SKILL.md");
      writeFixtureFile(skillPath, "# External Skill\n");
      writeFixtureFile(join(skillDir, "references", "live-reference.md"), "reference v1\n");
      writeFixtureFile(join(skillDir, "scripts", "run.mjs"), "export default 'v1';\n");
      writeFixtureFile(extensionPath, "export const command = 'v1';\n");
      writeFixtureFile(join(extensionBaseDir, "lib", "imported.ts"), "export const imported = 'v1';\n");
      writeFixtureFile(join(audit.sourceAgentDir, "skills", "linked-skill", "SKILL.md"), "# Linked Skill\n");
      const commands = [{
        name: "skill:external-skill",
        source: "skill",
        sourceInfo: { path: skillPath, baseDir: externalAgentRoot, scope: "user", source: "auto" },
      }, {
        // A duplicate command path must not produce an order-dependent root.
        name: "skill:external-skill-alias",
        source: "skill",
        sourceInfo: { path: skillPath, baseDir: externalAgentRoot, scope: "user", source: "auto" },
      }, {
        name: "external-extension-command",
        source: "extension",
        sourceInfo: { path: extensionPath, baseDir: extensionBaseDir, scope: "user", source: "package" },
      }, {
        name: "skill:linked-skill",
        source: "skill",
        sourceInfo: { path: linkedSkillPath, baseDir: audit.harnessAgentDir, scope: "user", source: "auto" },
      }, {
        name: "skill:temporary-external",
        source: "skill",
        sourceInfo: { path: skillPath, baseDir: externalAgentRoot, scope: "temporary", source: "local" },
      }];
      const pinned = hashExternalCommandResourceTree(commands, audit);
      expect(pinned.roots).toHaveLength(2);
      expect(rehashContentTree(pinned).sha256).toBe(pinned.sha256);

      writeFixtureFile(join(skillDir, "references", "live-reference.md"), "reference v2\n");
      expect(rehashContentTree(pinned).sha256).not.toBe(pinned.sha256);

      const repinned = hashExternalCommandResourceTree(commands, audit);
      writeFixtureFile(join(extensionBaseDir, "lib", "imported.ts"), "export const imported = 'v2';\n");
      expect(rehashContentTree(repinned).sha256).not.toBe(repinned.sha256);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("content-tree rejects symlinks that escape a pinned root", () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-resource-escape-"));
    try {
      const root = join(output, "root");
      const outside = join(output, "outside");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "mutable.mjs"), "export default 'outside';\n");
      symlinkSync(outside, join(root, "escape"), "dir");
      expect(() => hashContentTree([{ name: "fixture", path: root }])).toThrow("escaping its root");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("execution and resume require a clean worktree while preview bypasses the gate", () => {
    const calls = [];
    expect(() => assertCleanGitWorktree({
      cwd: "/fixture",
      execFileSyncImpl: (binary, args, options) => {
        calls.push({ binary, args, options });
        return "?? non-ignored-untracked.txt\n";
      },
    })).toThrow("including non-ignored untracked files");
    expect(calls).toEqual([{
      binary: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      options: { cwd: "/fixture", encoding: "utf8" },
    }]);

    let gateCalls = 0;
    const gate = () => { gateCalls += 1; };
    assertMatrixWorktreeClean({ execute: false, resume: false, assertClean: gate });
    assertMatrixWorktreeClean({ execute: true, resume: false, assertClean: gate });
    assertMatrixWorktreeClean({ execute: false, resume: true, assertClean: gate });
    expect(gateCalls).toBe(2);
  });

  test("resume rejects any pinned provenance drift", () => {
    const pinned = { headSha: "a".repeat(40), saffron: { fixtureSha256: "fixture" } };
    expect(() => assertPinnedProvenance(pinned, structuredClone(pinned))).not.toThrow();
    expect(() => assertPinnedProvenance(pinned, { ...pinned, headSha: "b".repeat(40) })).toThrow("resume provenance mismatch");
    expect(() => assertResumeSeed("bad-hash", undefined)).toThrow("resume requires");
    const seedHash = buildSaffronPin("resume-secret", {
      packetTokenTarget: 2_000,
      earlyDigestTokenTarget: 1_500,
      supplementTokenTarget: 1_500,
    }).secretSeedSha256;
    expect(() => assertResumeSeed(seedHash, "wrong-secret")).toThrow("does not match");
    expect(() => assertResumeSeed(seedHash, "resume-secret")).not.toThrow();
  });

  test("exclusive output lock rejects a concurrent matrix process", () => {
    const output = mkdtempSync(join(tmpdir(), "saffron-matrix-lock-"));
    try {
      const lock = acquireMatrixLock(output);
      expect(() => acquireMatrixLock(output)).toThrow("matrix output is locked");
      expect(() => acquireMatrixLock(output, { recoverStale: true, isPidAlive: () => true })).toThrow("live or unverifiable");
      releaseMatrixLock(lock);
      writeFileSync(join(output, ".matrix.lock"), `${JSON.stringify({ pid: 999_999_999, acquiredAt: "old" })}\n`);
      const recovered = acquireMatrixLock(output, { recoverStale: true, isPidAlive: () => false });
      releaseMatrixLock(recovered);
      const replacement = acquireMatrixLock(output);
      releaseMatrixLock(replacement);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("partial arm execution stays partial while another arm is pending", () => {
    const manifest = createLongFlowMatrixManifest({ matrixRunId: "matrix-partial" });
    const state = createInitialMatrixState({ manifest, outputDir: "/tmp/matrix", piProvenance: {} });
    for (const cell of Object.values(state.cells)) {
      if (cell.contextWindow === 400_000) cell.status = "completed";
    }
    expect(finalMatrixStatus(state)).toBe("partial");
    for (const cell of Object.values(state.cells)) cell.status = "completed";
    expect(finalMatrixStatus(state)).toBe("completed");
  });

  test("execute refuses to start without an explicit flow seed", () => {
    const result = spawnSync("bun", ["eval/run-flow-matrix.mjs", "--execute"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ACM_FLOW_SEED: "" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--execute requires --flow-seed or ACM_FLOW_SEED");
  });
});
