import type { ContextUsagePressure } from "./context-pressure.js";
import type { FoldEstimates } from "./fold-estimate.js";

/**
 * 常驻上下文仪表 —— ACM 注入的唯一感知面。
 *
 * 设计约束：仪表是家具，不是事件。它只报数字：当前用量，以及折叠后预计降到
 * 多少。不带动词、不评价、无阈值、不升级措辞——对顺从的模型，任何超出数字的
 * 措辞都会被读成行动指令，那正是已退役的失败模式。
 *
 * 折叠针是投影不是建议：它只回答「折了能省多少」，从不回答「该不该折」。
 * 它无条件出现——只在超过某阈值才出现的针是在自己挑时机，挑时机的仪表就
 * 变回了事件。会话早期的「折叠→2%」是静止的速度表读数为零，不是噪音。
 *
 * 显示节奏是里程表：整数位变化（双向）才显示。显示频率因此只跟随消耗速度，
 * 对「重要时刻」零编辑判断。
 */

export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM 工具结果自带用量回执，永不装饰。 */
export function isAcmTool(toolName: string): boolean {
  return toolName.startsWith("acm_");
}

export interface GaugeState {
  lastShownPercent: number | null;
}

export function createGaugeState(): GaugeState {
  return { lastShownPercent: null };
}

/**
 * 里程表节奏：整数位与上次显示不同才显示。向下变化也显示——折叠后看着数字
 * 切换后的新读数正是值得渲染一次的事实。
 */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

/** 拨动里程表——只在后缀真正附加到结果之后调用。 */
export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/**
 * 先报用量，再报收益：有参照点时追加一根折叠针「折叠→X%」，投影折掉当前
 * 请求之前那段历史后的用量。没有可折的内容时省略——缺参照点是事实，编造的
 * 零不是。
 */
export function buildGaugeSuffix(pressure: ContextUsagePressure, folds?: FoldEstimates): string {
  const usedPercent = pressure.policy === "400k-cap" ? pressure.pressurePercent : pressure.usagePercent;
  const parts = [`${Math.floor(usedPercent)}% used`];
  const foldPercent = folds?.turnPercent ?? folds?.taskPercent;
  if (foldPercent != null && Number.isFinite(foldPercent)) {
    parts.push(`fold→${Math.floor(foldPercent)}%`);
  }
  return `\n[ctx ${parts.join(" · ")}]`;
}
