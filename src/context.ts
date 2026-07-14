import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ThemeColor,
  type ToolInfo,
  DynamicBorder,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { buildSessionMessages } from "./host-bridge.js";
import { sanitizeTerminalText } from "./lib.js";
import { formatTokens } from "./utils.js";

interface TokenBuckets {
  messages: number;
  toolCalls: number;
  other: number;
}

interface ContextUsageBreakdown {
  systemPrompt: number;
  systemTools: number;
  toolCalls: number;
  messages: number;
  other: number;
  available: number;
}

interface UsageCategory {
  label: string;
  value: number;
  color: ThemeColor;
}

function estimateTextTokens(text: string): number {
  return text.length > 0 ? Math.ceil(text.length / 4) : 0;
}

function classifyMessageTokens(message: AgentMessage): TokenBuckets {
  const role = (message as { role?: string }).role;
  const total = Math.max(0, estimateTokens(message));

  if (role === "toolResult" || role === "bashExecution") {
    return { messages: 0, toolCalls: total, other: 0 };
  }
  if (role === "assistant") {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return { messages: total, toolCalls: 0, other: 0 };

    let messageWeight = 0;
    let toolWeight = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as {
        type?: string;
        text?: string;
        thinking?: string;
        name?: string;
        arguments?: unknown;
      };
      if (typed.type === "toolCall") {
        const serializedArguments = JSON.stringify(typed.arguments);
        toolWeight += (typed.name?.length ?? 0) + (serializedArguments?.length ?? 0);
      } else if (typed.type === "text" && typeof typed.text === "string") {
        messageWeight += typed.text.length;
      } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
        messageWeight += typed.thinking.length;
      }
    }

    const weight = messageWeight + toolWeight;
    if (weight === 0 || toolWeight === 0) return { messages: total, toolCalls: 0, other: 0 };
    if (messageWeight === 0) return { messages: 0, toolCalls: total, other: 0 };
    const toolCalls = Math.round(total * (toolWeight / weight));
    return { messages: total - toolCalls, toolCalls, other: 0 };
  }
  if (role === "user" || role === "branchSummary" || role === "compactionSummary" || role === "custom") {
    return { messages: total, toolCalls: 0, other: 0 };
  }
  return { messages: 0, toolCalls: 0, other: total };
}

function estimateActiveToolDefinitionTokens(activeToolDefs: readonly ToolInfo[]): number {
  if (activeToolDefs.length === 0) return 0;
  const providerDefinitions = activeToolDefs.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return estimateTextTokens(JSON.stringify(providerDefinitions));
}

function calculateContextUsageBreakdown(input: {
  totalActual: number;
  limit: number;
  systemPrompt: string;
  activeToolDefs: readonly ToolInfo[];
  messages: readonly AgentMessage[];
}): ContextUsageBreakdown {
  let messageTokensRaw = 0;
  let toolCallTokensRaw = 0;
  let unclassifiedMessageTokensRaw = 0;
  for (const message of input.messages) {
    const buckets = classifyMessageTokens(message);
    messageTokensRaw += buckets.messages;
    toolCallTokensRaw += buckets.toolCalls;
    unclassifiedMessageTokensRaw += buckets.other;
  }

  const systemTokensRaw = estimateTextTokens(input.systemPrompt);
  const toolDefTokensRaw = estimateActiveToolDefinitionTokens(input.activeToolDefs);
  const knownRaw = systemTokensRaw + toolDefTokensRaw + messageTokensRaw + toolCallTokensRaw + unclassifiedMessageTokensRaw;
  // Native/message estimates can overshoot provider accounting. Calibrate
  // downward only; never inflate known categories to hide unknown overhead.
  const downwardScale = knownRaw > input.totalActual && knownRaw > 0 ? input.totalActual / knownRaw : 1;
  const systemPrompt = Math.floor(systemTokensRaw * downwardScale);
  const systemTools = Math.floor(toolDefTokensRaw * downwardScale);
  const messages = Math.floor(messageTokensRaw * downwardScale);
  const toolCalls = Math.floor(toolCallTokensRaw * downwardScale);
  const unclassifiedMessages = Math.floor(unclassifiedMessageTokensRaw * downwardScale);
  const classifiedTotal = systemPrompt + systemTools + messages + toolCalls + unclassifiedMessages;

  return {
    systemPrompt,
    systemTools,
    toolCalls,
    messages,
    other: Math.max(0, input.totalActual - classifiedTotal) + unclassifiedMessages,
    available: Math.max(0, input.limit - input.totalActual),
  };
}

function notifyContextWarning(ctx: Pick<ExtensionCommandContext, "ui">, message: string): void {
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // The diagnostic command cannot recover when the host notification surface itself is unavailable.
  }
}

async function containContextCommandFailures(
  ctx: Pick<ExtensionCommandContext, "ui">,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    notifyContextWarning(ctx, `Context usage visualization failed: ${message}`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show context usage visualization (TUI only)",
    handler: async (_args, ctx) => containContextCommandFailures(ctx, async () => {
      if (ctx.mode !== "tui") {
        notifyContextWarning(ctx, "Context usage visualization is only available in TUI mode.");
        return;
      }
      const usage = ctx.getContextUsage();
      const totalActual = usage?.tokens;
      const limit = usage?.contextWindow;
      const usagePercent = usage?.percent;
      if (
        totalActual == null ||
        !Number.isFinite(totalActual) ||
        totalActual < 0 ||
        limit == null ||
        !Number.isFinite(limit) ||
        limit <= 0 ||
        usagePercent == null ||
        !Number.isFinite(usagePercent) ||
        usagePercent < 0
      ) {
        notifyContextWarning(ctx, "Context usage info not available.");
        return;
      }

      const contextMessagesResult = buildSessionMessages(ctx.sessionManager);
      if (!contextMessagesResult.ok) {
        const message = sanitizeTerminalText(contextMessagesResult.message);
        notifyContextWarning(ctx, `Context messages could not be rebuilt: ${message}`);
        return;
      }
      const contextMessages = contextMessagesResult.value;
      const systemPrompt = ctx.getSystemPrompt();
      const activeToolNames = new Set(pi.getActiveTools());
      const activeToolDefs = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));

      const breakdown = calculateContextUsageBreakdown({
        totalActual,
        limit,
        systemPrompt,
        activeToolDefs,
        messages: contextMessages,
      });
      let componentOpened = false;
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        componentOpened = true;
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Context Usage")), 1, 0));
        container.addChild(new Spacer(1));

        const categories: UsageCategory[] = [
          { label: "System Prompt", value: breakdown.systemPrompt, color: "muted" },
          { label: "System Tools", value: breakdown.systemTools, color: "dim" },
          { label: "Tool Call", value: breakdown.toolCalls, color: "success" },
          { label: "Messages", value: breakdown.messages, color: "accent" },
        ];
        if (breakdown.other > 0) categories.push({ label: "Other", value: breakdown.other, color: "dim" });
        categories.push({ label: "Available", value: breakdown.available, color: "borderMuted" });

        const gridWidth = 10;
        const gridHeight = 5;
        const totalBlocks = gridWidth * gridHeight;
        const blocks: { color: ThemeColor; filled: boolean }[] = [];
        for (const category of categories) {
          if (category.label === "Available") continue;
          let count = Math.round((category.value / limit) * totalBlocks);
          if (count === 0 && category.value > 0) count = 1;
          for (let i = 0; i < count && blocks.length < totalBlocks; i++) {
            blocks.push({ color: category.color, filled: true });
          }
        }
        while (blocks.length < totalBlocks) blocks.push({ color: "borderMuted", filled: false });

        const gridLines: string[] = [];
        for (let row = 0; row < gridHeight; row++) {
          let rowText = "";
          for (let column = 0; column < gridWidth; column++) {
            const block = blocks[row * gridWidth + column]!;
            rowText += theme.fg(block.color, block.filled ? "■ " : "□ ");
          }
          gridLines.push(rowText.trimEnd());
        }

        const totalUsageTitle = `${theme.fg("text", theme.bold("Total Usage".padEnd(16)))} ${theme.fg("text", theme.bold(formatTokens(totalActual).padStart(7)))} ${theme.fg("text", theme.bold(`(${usagePercent.toFixed(1).padStart(5)}%)`))}`;
        const detailLines = categories.map((category) => {
          const label = category.label.padEnd(14);
          const value = formatTokens(category.value).padStart(7);
          const percent = ((category.value / limit) * 100).toFixed(1).padStart(5);
          const icon = category.label === "Available" ? "□" : "■";
          return `${theme.fg(category.color, icon)} ${theme.fg("text", label)} ${theme.fg("accent", value)} (${percent}%)`;
        });

        const allDetailLines = [totalUsageTitle, "", ...detailLines];
        const leftSideWidth = 20;
        const maxHeight = Math.max(gridLines.length, allDetailLines.length);
        for (let i = 0; i < maxHeight; i++) {
          const left = (gridLines[i] || "").padEnd(leftSideWidth);
          const right = allDetailLines[i] || "";
          container.addChild(new Text(`    ${left}      ${right}`, 1, 0));
        }

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", " Press any key to close"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: () => done(undefined),
        };
      }, { overlay: true });
      if (!componentOpened) {
        notifyContextWarning(ctx, "Context usage visualization could not be opened.");
      }
    }),
  });
}
