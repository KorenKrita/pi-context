import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..");

function writeFakePi(root) {
  const path = join(root, "fake-pi.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("0.81.1\\n");
  process.exit(0);
}
const valueAfter = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const provider = valueAfter("--provider");
const modelId = valueAfter("--model");
const thinkingLevel = valueAfter("--thinking");
const skillPath = valueAfter("--skill");
const extensions = process.argv.flatMap((value, index) => value === "-e" ? [process.argv[index + 1]] : []);
const contextPath = extensions.find((value) => value.endsWith("/src/context.ts"));
const auditPath = process.env.ACM_INTEGRITY_AUDIT_PATH;
const commandLog = process.env.FAKE_PI_COMMAND_LOG;
const auditMode = process.env.FAKE_PI_AUDIT_MODE;
const append = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + "\\n");
};
try {
  readFileSync(process.env.FAKE_PI_DENIED_PROBE);
  append(commandLog, { type: "sandbox_probe", denied: false, tmpdir: process.env.TMPDIR, toolProfile: process.env.ACM_INTEGRITY_TOOL_SANDBOX_PROFILE });
} catch (error) {
  append(commandLog, { type: "sandbox_probe", denied: error?.code === "EPERM", code: error?.code ?? null, tmpdir: process.env.TMPDIR, toolProfile: process.env.ACM_INTEGRITY_TOOL_SANDBOX_PROFILE });
}
append(auditPath, { type: "extension_loaded", workspaceSha256: "fixture" });
append(auditPath, {
  type: "session_start",
  activeTools: ["read", "bash", "edit", "write", "acm_checkpoint", "acm_timeline", "acm_travel"],
  allTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "acm_checkpoint", "acm_timeline", "acm_travel"]
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  append(commandLog, command);
  if (auditMode === "blocked-after-state-error" && command.type === "get_state") {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: false, error: "fixture state failure" }) + "\\n");
    return;
  }
  let data = null;
  if (command.type === "get_commands") data = { commands: [
    { name: "context", source: "extension", sourceInfo: { path: contextPath, scope: "temporary", origin: "top-level" } },
    { name: "skill:context-management", source: "skill", sourceInfo: { path: skillPath, scope: "temporary", origin: "top-level" } }
  ] };
  else if (command.type === "get_state") data = { model: { provider, id: modelId, contextWindow: 400000, maxTokens: 16000 }, thinkingLevel };
  else if (command.type === "get_available_models") data = { models: [{ provider, id: modelId }] };
  else if (command.type === "get_available_thinking_levels") data = { levels: [thinkingLevel] };
  else if (command.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: false, error: "audit-only must not prompt" }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data }) + "\\n");
});
input.on("close", () => {
  if (auditMode === "blocked-on-close" || auditMode === "blocked-after-state-error") {
    append(auditPath, { type: "tool_blocked", toolName: "read", code: "path_outside_allowed_roots" });
  }
  process.exit(0);
});
`);
  chmodSync(path, 0o755);
  return path;
}

function runAuditOnly(mode) {
  const root = mkdtempSync(join(tmpdir(), "pi-context-agents-audit-"));
  const sourceAgentDir = join(root, "source-agent");
  const harnessDir = join(root, "harness");
  const runsDir = join(root, "runs");
  const commandLog = join(root, "fake-commands.jsonl");
  mkdirSync(sourceAgentDir, { recursive: true });
  writeFileSync(join(sourceAgentDir, "auth.json"), "{}\n");
  writeFileSync(join(sourceAgentDir, "AGENTS.md"), "# Global fixture instructions\n");
  writeFileSync(join(sourceAgentDir, "settings.json"), JSON.stringify({ packages: [] }));
  writeFileSync(join(sourceAgentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        models: [{
          id: "fixture",
          name: "Fixture",
          contextWindow: 400000,
          maxTokens: 16000,
          reasoning: true,
          thinkingLevelMap: { high: "high" },
        }],
      },
    },
  }));
  const fakePi = writeFakePi(root);
  const result = spawnSync("bun", [
    "eval/run-flow.mjs",
    "--flow", "exprlang-long-flow",
    "--model", "fixture/fixture",
    "--thinking", "high",
    "--variant", `agents-audit-${mode}`,
    "--context-window", "400000",
    "--max-tokens-cap", "16000",
    "--pi-binary", fakePi,
    "--agent-label", `agents-audit-${mode}`,
    "--environment-mode", "agents-only",
    "--source-agent-dir", sourceAgentDir,
    "--harness-dir", harnessDir,
    "--runs-dir", runsDir,
    "--audit-only",
    "--no-judge",
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FAKE_PI_AUDIT_MODE: mode,
      FAKE_PI_COMMAND_LOG: commandLog,
      FAKE_PI_DENIED_PROBE: join(REPO_ROOT, "eval", "fixtures", "exprlang", "package.json"),
    },
    encoding: "utf8",
    timeout: 15000,
  });
  const reportPath = `${result.stdout}\n${result.stderr}`.match(/^report:\s*(.+)$/m)?.[1]?.trim();
  return {
    root,
    result,
    report: reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
    commands: existsSync(commandLog)
      ? readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [],
  };
}

describe("agents-only audit-only integration", () => {
  test("loads one measurement guard without sending a task or judge prompt", () => {
    const execution = runAuditOnly("valid");
    try {
      if (process.platform !== "darwin") {
        expect(execution.result.status).toBe(1);
        expect(execution.report).not.toBeNull();
        expect(execution.report).toMatchObject({
          status: "infrastructure_invalid",
          sandbox: { formalEvidenceEligible: false, enforcement: "unsupported" },
          infrastructureInvalid: { status: "agents_only_sandbox_unsupported" },
        });
        return;
      }
      expect(execution.result.signal).toBeNull();
      expect({ status: execution.result.status, stdout: execution.result.stdout, stderr: execution.result.stderr }).toMatchObject({ status: 0 });
      expect(execution.report).toMatchObject({ status: "completed", infrastructureInvalid: null, turns: [] });
      expect(execution.report.productExtensionPaths).toHaveLength(2);
      expect(execution.report.measurementExtensionPaths).toHaveLength(1);
      expect(execution.report.measurementExtensionPaths[0].endsWith("/eval/integrity-guard.mjs")).toBe(true);
      expect(execution.report.integrity.measurementGuard).toMatchObject({ exists: true, sha256: expect.any(String) });
      expect(execution.report.integrity.records.find((record) => record.type === "session_start")?.activeTools)
        .toEqual(expect.arrayContaining(["acm_checkpoint", "acm_timeline", "acm_travel"]));
      expect(execution.report.resources.promptMarkers.map((marker) => marker.id))
        .toEqual(expect.arrayContaining(["acm_core_marker", "global_agents_heading"]));
      expect(execution.report.runtimeAudit.commandInventory).toEqual({ globalExtensions: [], globalSkills: [] });
      expect(execution.report.resources.agentsOnlyHarness.sessionRecall).toEqual({ packagePresent: false, configPresent: false });
      expect(execution.report.sandbox).toMatchObject({ required: true, enabled: true, profileSha256: expect.any(String) });
      expect(execution.report.sandbox).toMatchObject({ formalEvidenceEligible: true, enforcement: "kernel_enforced" });
      expect(execution.report.sandbox.outerProfile).toMatchObject({ path: expect.any(String), sha256: expect.any(String) });
      expect(execution.report.sandbox.toolProfile).toMatchObject({ path: expect.any(String), sha256: expect.any(String) });
      expect(execution.report.sandbox.deniedRoots.some((entry) => entry.source === "private_eval_root")).toBe(true);
      expect(execution.report.sandbox.deniedRoots.some((entry) => entry.source === "task_fixture_source")).toBe(true);
      expect(execution.report.sandbox.currentRoots).toContain(execution.report.workspace);
      expect(execution.report.sandbox.allowedRoots).toBeUndefined();
      expect(execution.report.lock).toMatchObject({ acquired: true, released: true, path: expect.any(String) });
      expect(execution.commands).toContainEqual({
        type: "sandbox_probe",
        denied: true,
        code: "EPERM",
        tmpdir: expect.any(String),
        toolProfile: execution.report.sandbox.toolProfile.path,
      });
      expect(execution.commands.find((command) => command.type === "sandbox_probe").tmpdir.startsWith(execution.report.workspace)).toBe(true);
      expect(execution.commands.some((command) => command.type === "prompt")).toBe(false);
      expect(execution.report.judge).toEqual({ skipped: true, reason: "audit_only" });
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  }, 20000);

  const darwinTest = process.platform === "darwin" ? test : test.skip;
  darwinTest("classifies an audit violation written during shutdown ahead of any secondary run error", () => {
    const execution = runAuditOnly("blocked-after-state-error");
    try {
      expect({ status: execution.result.status, stdout: execution.result.stdout, stderr: execution.result.stderr }).toMatchObject({ status: 1 });
      expect(execution.report).toMatchObject({
        status: "infrastructure_invalid",
        infrastructureInvalid: { status: "integrity_guard_tool_blocked" },
      });
      expect(execution.report.runError).toContain("get_state rejected: fixture state failure");
      expect(execution.report.integrity.records.at(-1)).toMatchObject({ type: "tool_blocked" });
    } finally {
      rmSync(execution.root, { recursive: true, force: true });
    }
  }, 20000);
});
