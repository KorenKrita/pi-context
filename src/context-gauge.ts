import type { ContextUsagePressure } from "./context-pressure.js";
import type { FoldEstimates } from "./fold-estimate.js";

/**
 * 常驻上下文仪表，ACM 注入的唯一感知面。
 *
 * 设计约定：仪表像仪表盘上的读数，不像报警器——它一直在那里，只陈述事实：
 * 现在用了多少，折叠后预计降到多少。不带动词、不下评价、没有阈值、
 * 不随用量升高而加重语气。顺从的模型会把任何超出数字的措辞当成
 * 行动指令，那正是这套设计已经退役的失败模式。
 *
 * 折叠针是推算，不是建议：它只回答“折了能省多少”，从不回答“该不该折”。
 * 它无条件出现——要是只在超过某个阈值时才露面，就等于仪表自己在挑时机，
 * 而挑时机的仪表就变成了警报。会话刚开始时的“折叠→2%”，就像停着的车
 * 速度表指在零上，是正常读数，不是噪音。
 *
 * 显示节奏像里程表：百分比的整数位变了才显示一次，涨跌都算。显示频率
 * 因此只取决于消耗快慢，不对“重要时刻”做任何人为判断。
 */

export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM 工具结果自带用量回执，不再叠加仪表。 */
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
 * 里程表节奏：整数位和上次显示的不同才显示。往下走也显示——折叠之后看到
 * 数字降下来，是真实的反馈，不是噪音。新周期的第一次读数总会显示：
 * 上下文切换之后，新读数正是值得报一次的事实。
 */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  return Math.floor(pressurePercent) !== Math.floor(state.lastShownPercent);
}

/** 拨动里程表。只在后缀真正附加到结果上之后才调用。 */
export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/**
 * 先报用量，再报收益：有参照点时追加一根折叠针“折叠→X%”，推算折掉当前
 * 请求之前那段历史后还剩多少。没有可折的内容时就不显示——缺参照点是事实，
 * 编造一个零不是。
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
