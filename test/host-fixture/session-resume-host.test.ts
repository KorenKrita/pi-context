import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session resume", () => {
  test("resume uses the persisted session header cwd when no override is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-session-cwd-"));
    temporaryDirectories.push(root);
    const baseWorkspace = join(root, "base", "workspace");
    const armWorkspace = join(root, "on", "workspace");
    for (const directory of [baseWorkspace, armWorkspace]) {
      mkdirSync(directory, { recursive: true });
    }

    const original = SessionManager.create(baseWorkspace, root);
    original.appendMessage({ role: "user", content: "persist session header", timestamp: Date.now() });
    original.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "flush persisted session" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionFile = original.getSessionFile();
    if (!sessionFile) throw new Error("Expected a persisted session file");
    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0] ?? "null");
    lines[0] = JSON.stringify({ ...header, cwd: armWorkspace });
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    const resumed = SessionManager.open(sessionFile, root);
    expect(original.getCwd()).toBe(baseWorkspace);
    expect(resumed.getCwd()).toBe(armWorkspace);
  });
});
