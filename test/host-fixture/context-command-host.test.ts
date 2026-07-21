import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createModelRegistry } from "./model-registry.ts";


test("/context registers and renders through the exact Pi host", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-command-host-"));
  try {
    const loaded = await discoverAndLoadExtensions(
      ["./.acm-build/context.js"],
      import.meta.dir,
      join(tempDir, "empty-agent-dir"),
    );
    expect(loaded.errors).toEqual([]);

    const sessionManager = SessionManager.inMemory(join(tempDir, "session.jsonl"));
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const modelRegistry = await createModelRegistry(tempDir);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, sessionManager, modelRegistry);

    runner.bindCore({
      sendMessage: async () => {},
      sendUserMessage: async () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => {},
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    }, {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
      compact: () => {},
      getSystemPrompt: () => "system",
      getSystemPromptOptions: () => ({ cwd: tempDir }),
    });

    let rendered = "";
    const notifications: Array<{ message: string; type?: string }> = [];
    runner.setUIContext({
      notify: (message, type) => notifications.push({ message, ...(type === undefined ? {} : { type }) }),
      custom: async (factory) => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const component = await factory({} as never, theme as never, {} as never, () => {});
        rendered = component.render(120).join("\n");
      },
    } as unknown as ExtensionUIContext, "tui");

    const command = runner.getCommand("context");
    expect(command?.description).toBe("Show context usage visualization (TUI only)");
    expect(runner.createCommandContext().mode).toBe("tui");
    await command?.handler("", runner.createCommandContext());

    expect(notifications).toEqual([]);
    expect(rendered).toContain("Context Usage");
    expect(rendered).toContain("Available");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
