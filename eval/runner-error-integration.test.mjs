import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..");

function writeFakePi(root) {
  const path = join(root, "fake-pi.mjs");
  writeFileSync(path, `#!/usr/bin/env node
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
const contextWindow = Number(process.env.FAKE_PI_CONTEXT_WINDOW ?? 400000);
const maxTokens = Number(process.env.FAKE_PI_MAX_TOKENS ?? 16000);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_commands") {
    emit({ type: "response", id: command.id, success: true, data: { commands: [
      { name: "context", source: "extension", sourceInfo: { path: contextPath, scope: "temporary", origin: "top-level" } },
      { name: "skill:context-management", source: "skill", sourceInfo: { path: skillPath, scope: "temporary", origin: "top-level" } },
    ] } });
    return;
  }
  if (command.type === "get_state") {
    emit({ type: "response", id: command.id, success: true, data: {
      model: { provider, id: modelId, contextWindow, maxTokens },
      thinkingLevel,
    } });
    return;
  }
  if (command.type === "get_available_models") {
    emit({ type: "response", id: command.id, success: true, data: { models: [{ provider, id: modelId }] } });
    return;
  }
  if (command.type === "get_available_thinking_levels") {
    emit({ type: "response", id: command.id, success: true, data: { levels: [thinkingLevel] } });
    return;
  }
  if (command.type === "get_session_stats") {
    emit({ type: "response", id: command.id, success: true, data: { inputTokens: 100, outputTokens: 20 } });
    return;
  }
  if (command.type === "prompt") {
    emit({ type: "response", id: command.id, success: true });
    emit({ type: "tool_execution_start", toolCallId: "checkpoint-1", toolName: "acm_checkpoint", args: {
      name: "baseline-before-refactor",
      target: "fixture-user",
    } });
    emit({ type: "tool_execution_end", toolCallId: "checkpoint-1", toolName: "acm_checkpoint", isError: false, result: {
      content: [{ type: "text", text: "Created checkpoint baseline-before-refactor" }],
      details: { status: "created" },
    } });
    emit({ type: "message_end", message: {
      role: "assistant",
      provider,
      model: modelId,
      responseId: "resp-empty-length-after-tool",
      stopReason: "length",
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
    } });
    emit({ type: "agent_settled" });
    return;
  }
  emit({ type: "response", id: command.id, success: false, error: "unsupported fake command: " + command.type });
});
input.on("close", () => process.exit(0));
`);
  chmodSync(path, 0o755);
  return path;
}

function writeSourceAgentDir(root) {
  const path = join(root, "source-agent");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "auth.json"), "{}\n");
  writeFileSync(join(path, "models.json"), JSON.stringify({
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
  return path;
}

function reportPathFrom(output) {
  return output.match(/^report:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

function runShortScenario(root, fakePi) {
  const execution = spawnSync("bun", [
    "eval/run.mjs",
    "--id", "directed-checkpoint",
    "--model", "fixture/fixture",
    "--thinking", "high",
    "--context-window", "400000",
    "--environment-mode", "product-isolated",
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, ACM_PI_BINARY: fakePi },
    encoding: "utf8",
    timeout: 15000,
  });
  const output = `${execution.stdout}\n${execution.stderr}`;
  const reportPath = reportPathFrom(output);
  return {
    execution,
    output,
    reportPath,
    report: reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
  };
}

function runLongFlow(root, fakePi, sourceAgentDir) {
  const runsDir = join(root, "runs");
  const execution = spawnSync("bun", [
    "eval/run-flow.mjs",
    "--flow", "exprlang-long-flow",
    "--model", "fixture/fixture",
    "--thinking", "high",
    "--variant", "failed-turn-evidence",
    "--context-window", "400000",
    "--max-tokens-cap", "16000",
    "--pi-binary", fakePi,
    "--agent-label", "failed-turn-evidence",
    "--environment-mode", "product-isolated",
    "--source-agent-dir", sourceAgentDir,
    "--runs-dir", runsDir,
    "--no-judge",
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FAKE_PI_CONTEXT_WINDOW: "400000",
      FAKE_PI_MAX_TOKENS: "16000",
    },
    encoding: "utf8",
    timeout: 20000,
  });
  const output = `${execution.stdout}\n${execution.stderr}`;
  const reportPath = reportPathFrom(output);
  return {
    execution,
    output,
    reportPath,
    report: reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
    transcript: reportPath && existsSync(join(dirname(reportPath), "transcript.txt"))
      ? readFileSync(join(dirname(reportPath), "transcript.txt"), "utf8")
      : null,
  };
}

function cleanupExecution(execution) {
  const workspace = execution.report?.workspace;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (execution.reportPath) rmSync(dirname(execution.reportPath), { recursive: true, force: true });
}

describe("provider empty-length runner evidence", () => {
  test("short scenarios retain successful partial tools and classify the provider failure as run_error", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-short-run-error-"));
    const fakePi = writeFakePi(root);
    const execution = runShortScenario(root, fakePi);
    try {
      expect({ status: execution.execution.status, output: execution.output }).toMatchObject({ status: 1 });
      expect(execution.report).not.toBeNull();
      expect(execution.report).toMatchObject({
        status: "run_error",
        passed: 0,
        failed: 0,
        runErrorCount: 1,
      });
      expect(execution.report.results[0]).toMatchObject({
        pass: false,
        runErrorCode: "provider_empty_length_response",
        error: expect.stringContaining("provider_empty_length_response"),
        toolCalls: [{
          name: "acm_checkpoint",
          completed: true,
          isError: false,
          args: { name: "baseline-before-refactor", target: "fixture-user" },
        }],
      });
      expect(execution.report.results[0].failedTurnEvidence).toMatchObject({
        turnIndex: 0,
        eventCount: 5,
        assistantTexts: [],
        toolCalls: [{ name: "acm_checkpoint", completed: true, isError: false }],
      });
    } finally {
      cleanupExecution(execution);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  test("long flows persist the failed turn, skip after-turn work, verification, and judging", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-flow-run-error-"));
    const fakePi = writeFakePi(root);
    const sourceAgentDir = writeSourceAgentDir(root);
    const execution = runLongFlow(root, fakePi, sourceAgentDir);
    try {
      expect({ status: execution.execution.status, output: execution.output }).toMatchObject({ status: 1 });
      expect(execution.report).toMatchObject({
        status: "run_error",
        runError: expect.stringContaining("provider_empty_length_response"),
        deterministicVerification: null,
        judge: { skipped: true, reason: "run_error" },
        turns: [{
          phase: "P1-摸底",
          toolCallCount: 1,
          acmCalls: [{ name: "acm_checkpoint", completed: true, isError: false }],
          stopReason: "length",
          hooks: { afterTurnHook: null, afterFlowHook: null },
          hostActions: { after: [] },
        }],
      });
      expect(execution.transcript).toContain("acm_checkpoint");
      expect(execution.report.turns).toHaveLength(1);
    } finally {
      cleanupExecution(execution);
      rmSync(root, { recursive: true, force: true });
    }
  }, 25000);
});
