import { describe, expect, test } from "bun:test";

function invoke(...args) {
  const result = Bun.spawnSync({
    cmd: ["bun", "eval/run.mjs", "--id", "__no_such_scenario__", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  };
}

describe("short scenario runner environment CLI", () => {
  test("accepts --env as an alias for explicit core-only mode", () => {
    const result = invoke("--env", "core-only");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No scenarios matched.");
    expect(result.output).not.toContain("unknown environment mode");
  });

  test("accepts the raw-control environment", () => {
    const result = invoke("--env", "raw-control");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No scenarios matched.");
    expect(result.output).not.toContain("unknown environment mode");
  });

  test("keeps --full-env as the full-env compatibility alias", () => {
    const result = invoke("--full-env");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No scenarios matched.");
    expect(result.output).not.toContain("unknown environment mode");
  });

  test("rejects contradictory environment aliases before any scenario can start", () => {
    const result = invoke("--environment-mode", "product-isolated", "--full-env");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("conflicts");
  });
});
