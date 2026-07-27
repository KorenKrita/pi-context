// 草根版仪表 - 就显示一个 context 用量百分比

import type { ContextUsagePressure } from "./context-pressure.js";
import type { FoldEstimates } from "./fold-estimate.js";

/** 环境变量关闭仪表 */
export function isGaugeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_GAUGE_DISABLED"] === "1";
}

/** ACM 工具结果不加仪表后缀 */
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
 * 什么时候显示仪表：
 * - 每 10% 显示一次（10%, 20%, 30%...）
 * - 超过 50% 后每 5% 显示一次
 * - 超过 80% 后每次都显示
 */
export function shouldShowGauge(state: GaugeState, pressurePercent: number): boolean {
  if (!Number.isFinite(pressurePercent) || pressurePercent < 0) return false;
  if (state.lastShownPercent === null) return true;
  
  const current = Math.floor(pressurePercent);
  const last = Math.floor(state.lastShownPercent);
  
  // 超过 80% 每次都显示
  if (current >= 80) return current !== last;
  
  // 超过 50% 每 5% 显示
  if (current >= 50) return Math.floor(current / 5) !== Math.floor(last / 5);
  
  // 低于 50% 每 10% 显示
  return Math.floor(current / 10) !== Math.floor(last / 10);
}

export function markGaugeShown(state: GaugeState, pressurePercent: number): void {
  state.lastShownPercent = pressurePercent;
}

/**
 * 仪表后缀 - 简化版
 * 只显示一个数字：context 用了百分之多少
 * 超过 50% 会提示可以考虑压缩
 */
export function buildGaugeSuffix(pressure: ContextUsagePressure, _folds?: FoldEstimates): string {
  const percent = Math.floor(pressure.pressurePercent);
  
  if (percent >= 80) {
    return `\n[ctx ${percent}% ⚠️ 建议压缩]`;
  }
  if (percent >= 50) {
    return `\n[ctx ${percent}%]`;
  }
  return `\n[ctx ${percent}%]`;
}
