import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  DynamicBorder,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { buildSessionMessages } from "./host-bridge.js";
import { formatTokens } from "./utils.js";

interface TokenBuckets {
  messages: number;
  toolCalls: number;
  other: number;
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
      const typed = block as { type?: string; text?: string };
      if (typed.type === "toolCall" || typed.type === "tool_use") {
        toolWeight += JSON.stringify(block).length;
      } else if (typeof typed.text === "string") {
        messageWeight += typed.text.length;
      } else {
        messageWeight += JSON.stringify(block).length;
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show context usage visualization",
    handler: async (_args, ctx) => {
      const usage = await ctx.getContextUsage();
      const totalActual = usage?.tokens;
      const limit = usage?.contextWindow;
      const usagePercent = usage?.percent;
      if (totalActual == null || limit == null || usagePercent == null || limit <= 0) {
        ctx.ui.notify("Context usage info not available.", "warning");
        return;
      }

      const contextMessagesResult = buildSessionMessages(ctx.sessionManager);
      if (!contextMessagesResult.ok) {
        ctx.ui.notify(`Context messages could not be rebuilt: ${contextMessagesResult.message}`, "warning");
        return;
      }
      const contextMessages = contextMessagesResult.value;
      const systemPrompt = ctx.getSystemPrompt();
      const activeToolNames = new Set(pi.getActiveTools());
      const activeToolDefs = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));

      let messageTokensRaw = 0;
      let toolCallTokensRaw = 0;
      let unclassifiedMessageTokensRaw = 0;
      for (const message of contextMessages) {
        const buckets = classifyMessageTokens(message);
        messageTokensRaw += buckets.messages;
        toolCallTokensRaw += buckets.toolCalls;
        unclassifiedMessageTokensRaw += buckets.other;
      }

      const systemTokensRaw = estimateTextTokens(systemPrompt);
      const toolDefTokensRaw = estimateTextTokens(JSON.stringify(activeToolDefs));
      const knownRaw = systemTokensRaw + toolDefTokensRaw + messageTokensRaw + toolCallTokensRaw + unclassifiedMessageTokensRaw;
      // Native/message estimates can overshoot provider accounting. Calibrate
      // downward only; never inflate known categories to hide unknown overhead.
      const downwardScale = knownRaw > totalActual && knownRaw > 0 ? totalActual / knownRaw : 1;
      const systemTokens = Math.floor(systemTokensRaw * downwardScale);
      const toolDefTokens = Math.floor(toolDefTokensRaw * downwardScale);
      const messageTokens = Math.floor(messageTokensRaw * downwardScale);
      const toolCallTokens = Math.floor(toolCallTokensRaw * downwardScale);
      const unclassifiedMessageTokens = Math.floor(unclassifiedMessageTokensRaw * downwardScale);
      const classifiedTotal = systemTokens + toolDefTokens + messageTokens + toolCallTokens + unclassifiedMessageTokens;
      const otherTokens = Math.max(0, totalActual - classifiedTotal);

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Context Usage")), 1, 0));
        container.addChild(new Spacer(1));

        const categories = [
          { label: "System Prompt", value: systemTokens, color: "muted" },
          { label: "System Tools", value: toolDefTokens, color: "dim" },
          { label: "Tool Call", value: toolCallTokens, color: "success" },
          { label: "Messages", value: messageTokens, color: "accent" },
        ];
        const combinedOther = otherTokens + unclassifiedMessageTokens;
        if (combinedOther > 10) categories.push({ label: "Other", value: combinedOther, color: "dim" });
        categories.push({ label: "Available", value: Math.max(0, limit - totalActual), color: "borderMuted" });

        const gridWidth = 10;
        const gridHeight = 5;
        const totalBlocks = gridWidth * gridHeight;
        const blocks: { color: string; filled: boolean }[] = [];
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
            const block = blocks[row * gridWidth + column];
            rowText += theme.fg(block.color as any, block.filled ? "■ " : "□ ");
          }
          gridLines.push(rowText.trimEnd());
        }

        const totalUsageTitle = `${theme.fg("text", theme.bold("Total Usage".padEnd(16)))} ${theme.fg("text", theme.bold(formatTokens(totalActual).padStart(7)))} ${theme.fg("text", theme.bold(`(${usagePercent.toFixed(1).padStart(5)}%)`))}`;
        const detailLines = categories.map((category) => {
          const label = category.label.padEnd(14);
          const value = formatTokens(category.value).padStart(7);
          const percent = ((category.value / limit) * 100).toFixed(1).padStart(5);
          const icon = category.label === "Available" ? "□" : "■";
          return `${theme.fg(category.color as any, icon)} ${theme.fg("text", label)} ${theme.fg("accent", value)} (${percent}%)`;
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
    },
  });
}
