import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateTokens,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import registerContextCommand from "../src/context";

function createToolInfo(overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: ["Use read instead of shelling out."],
    sourceInfo: { source: "extension", path: "/tmp/context-test.ts" },
    ...overrides,
  } as ToolInfo;
}

function captureContextCommand(tools: ToolInfo[] = []): RegisteredCommand {
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand(_name: string, commandOptions: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      command = {
        name: "context",
        invocationName: "context",
        sourceInfo: { source: "extension", path: "test" },
        ...commandOptions,
      };
    },
    getActiveTools: () => tools.map((tool) => tool.name),
    getAllTools: () => tools,
  } as unknown as ExtensionAPI;
  registerContextCommand(pi);
  if (!command) throw new Error("Context command was not registered");
  return command;
}

async function renderContext(options: {
  messages?: AgentMessage[];
  tools?: ToolInfo[];
  totalActual: number;
  limit: number;
  systemPrompt?: string;
}): Promise<string> {
  const tools = options.tools ?? [];
  const command = captureContextCommand(tools);

  const sessionManager = SessionManager.inMemory("/tmp/context-command-test");
  for (const message of options.messages ?? []) sessionManager.appendMessage(message as never);

  let rendered = "";
  const ctx = {
    mode: "tui",
    sessionManager,
    getContextUsage: () => ({
      tokens: options.totalActual,
      contextWindow: options.limit,
      percent: (options.totalActual / options.limit) * 100,
    }),
    getSystemPrompt: () => options.systemPrompt ?? "",
    ui: {
      notify() {},
      custom: async (factory: Function) => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const component = await factory({}, theme, {}, () => {});
        rendered = component.render(120).join("\n");
      },
    },
  } as unknown as ExtensionCommandContext;

  await command.handler("", ctx);
  return rendered;
}

function categoryValue(rendered: string, label: string): number {
  const line = rendered.split("\n").find((candidate) => candidate.includes(label));
  if (!line) throw new Error(`Missing ${label} row in:\n${rendered}`);
  const match = line.match(new RegExp(`${label}\\s+(\\d+)\\s+\\(`));
  if (!match) throw new Error(`Could not parse ${label} row: ${line}`);
  return Number(match[1]);
}

describe("/context accounting", () => {
  test("splits assistant tokens with the same character weights as Pi's estimator", async () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "abcdefgh" },
        { type: "thinking", thinking: "ijklmnop", signature: "not-counted" },
        { type: "toolCall", id: "call-id-not-counted", name: "read", arguments: { path: "x" } },
      ],
    } as unknown as AgentMessage;
    const total = estimateTokens(message);
    const messageWeight = 16;
    const toolWeight = "read".length + JSON.stringify({ path: "x" }).length;
    const expectedToolCalls = Math.round(total * (toolWeight / (messageWeight + toolWeight)));

    const rendered = await renderContext({ messages: [message], totalActual: total, limit: 100 });

    expect(categoryValue(rendered, "Tool Call")).toBe(expectedToolCalls);
    expect(categoryValue(rendered, "Messages")).toBe(total - expectedToolCalls);
  });

  test("counts only provider-visible tool schema fields", async () => {
    const tool = createToolInfo({
      promptGuidelines: ["x".repeat(4_000)],
      sourceInfo: { source: "extension", path: "/a/very/long/private/source/path" },
    });
    const providerShape = [{ name: tool.name, description: tool.description, parameters: tool.parameters }];
    const expected = Math.ceil(JSON.stringify(providerShape).length / 4);

    const rendered = await renderContext({ tools: [tool], totalActual: 100, limit: 1_000 });

    expect(categoryValue(rendered, "System Tools")).toBe(expected);
  });

  test("reports zero tool-definition usage when no tools are active", async () => {
    const rendered = await renderContext({ totalActual: 100, limit: 1_000 });
    expect(categoryValue(rendered, "System Tools")).toBe(0);
  });

  test("keeps unclaimed provider usage in Other without inflating known categories", async () => {
    const rendered = await renderContext({
      messages: [{ role: "user", content: "abcdefgh", timestamp: 1 } as AgentMessage],
      totalActual: 100,
      limit: 1_000,
      systemPrompt: "abcd",
    });

    expect(categoryValue(rendered, "System Prompt")).toBe(1);
    expect(categoryValue(rendered, "Messages")).toBe(2);
    expect(categoryValue(rendered, "System Tools")).toBe(0);
    expect(categoryValue(rendered, "Tool Call")).toBe(0);
    expect(categoryValue(rendered, "Other")).toBe(97);
    expect(categoryValue(rendered, "Available")).toBe(900);
  });

  test("downscales overshooting estimates while conserving official usage", async () => {
    const rendered = await renderContext({
      messages: [{ role: "user", content: "message".repeat(100), timestamp: 1 } as AgentMessage],
      tools: [createToolInfo()],
      totalActual: 50,
      limit: 40,
      systemPrompt: "system".repeat(100),
    });
    const classified =
      categoryValue(rendered, "System Prompt") +
      categoryValue(rendered, "System Tools") +
      categoryValue(rendered, "Tool Call") +
      categoryValue(rendered, "Messages") +
      categoryValue(rendered, "Other");

    expect(classified).toBe(50);
    expect(categoryValue(rendered, "Available")).toBe(0);
  });
});

describe("/context command", () => {
  test.each([
    ["missing usage", undefined],
    ["non-finite tokens", { tokens: Number.NaN, contextWindow: 100, percent: Number.NaN }],
    ["negative tokens", { tokens: -1, contextWindow: 100, percent: -1 }],
    ["non-finite context window", { tokens: 10, contextWindow: Number.POSITIVE_INFINITY, percent: 0 }],
    ["negative percentage", { tokens: 10, contextWindow: 100, percent: -10 }],
  ])("warns when official context usage is %s", async (_caseName, usage) => {
    const command = captureContextCommand();

    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      getContextUsage: () => usage,
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    } as unknown as ExtensionCommandContext;

    await command.handler("", ctx);
    expect(notifications).toEqual([{ message: "Context usage info not available.", type: "warning" }]);
  });

  test("contains host exceptions and reports actionable context", async () => {
    const command = captureContextCommand();

    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      getContextUsage: () => {
        throw new Error("usage\u0000 exploded");
      },
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    } as unknown as ExtensionCommandContext;

    await command.handler("", ctx);
    expect(notifications).toEqual([{
      message: "Context usage visualization failed: usage exploded",
      type: "warning",
    }]);
  });

  test("warns instead of invoking terminal UI outside TUI mode", async () => {
    const command = captureContextCommand();

    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = {
      mode: "rpc",
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    } as unknown as ExtensionCommandContext;

    await command.handler("", ctx);
    expect(notifications).toEqual([{
      message: "Context usage visualization is only available in TUI mode.",
      type: "warning",
    }]);
  });

  test("warns when TUI does not open the visualization component", async () => {
    const command = captureContextCommand();

    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      sessionManager: SessionManager.inMemory("/tmp/context-command-noop-ui-test"),
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
      getSystemPrompt: () => "",
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        custom: async () => undefined,
      },
    } as unknown as ExtensionCommandContext;

    await command.handler("", ctx);
    expect(notifications).toEqual([{
      message: "Context usage visualization could not be opened.",
      type: "warning",
    }]);
  });

  test("renders the active session breakdown", async () => {
    const rendered = await renderContext({
      messages: [{ role: "user", content: "hello", timestamp: 1 } as AgentMessage],
      tools: [createToolInfo()],
      totalActual: 20,
      limit: 100,
      systemPrompt: "system prompt",
    });

    expect(rendered).toContain("Context Usage");
    expect(rendered).toContain("System Prompt");
    expect(rendered).toContain("System Tools");
    expect(rendered).toContain("Messages");
    expect(rendered).toContain("Available");
  });
});
