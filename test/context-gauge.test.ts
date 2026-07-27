import { describe, expect, test } from "bun:test";
import { buildGaugeSuffix, shouldShowGauge, createGaugeState, markGaugeShown } from "../src/context-gauge.js";
import type { ContextUsagePressure } from "../src/context-pressure.js";

describe("context gauge - 草根版", () => {
  test("渲染简单的百分比", () => {
    const pressure: ContextUsagePressure = {
      pressurePercent: 45,
      usagePercent: 45,
      workingBudgetTokens: 400_000,
      policy: "400k-cap",
    };
    const suffix = buildGaugeSuffix(pressure);
    expect(suffix).toContain("45%");
  });

  test("超过 80% 显示警告", () => {
    const pressure: ContextUsagePressure = {
      pressurePercent: 85,
      usagePercent: 85,
      workingBudgetTokens: 400_000,
      policy: "400k-cap",
    };
    const suffix = buildGaugeSuffix(pressure);
    expect(suffix).toContain("85%");
    expect(suffix).toContain("建议压缩");
  });

  test("显示节奏：低于 50% 每 10% 显示一次", () => {
    const state = createGaugeState();
    
    // 首次总是显示
    expect(shouldShowGauge(state, 25)).toBe(true);
    markGaugeShown(state, 25);
    
    // 同一个 10% 区间不显示
    expect(shouldShowGauge(state, 28)).toBe(false);
    
    // 跨越 10% 边界则显示
    expect(shouldShowGauge(state, 31)).toBe(true);
  });

  test("显示节奏：超过 50% 每 5% 显示一次", () => {
    const state = createGaugeState();
    markGaugeShown(state, 52);
    
    // 同一个 5% 区间不显示
    expect(shouldShowGauge(state, 53)).toBe(false);
    
    // 跨越 5% 边界则显示
    expect(shouldShowGauge(state, 56)).toBe(true);
  });

  test("显示节奏：超过 80% 每次变化都显示", () => {
    const state = createGaugeState();
    markGaugeShown(state, 82);
    
    expect(shouldShowGauge(state, 83)).toBe(true);
    markGaugeShown(state, 83);
    expect(shouldShowGauge(state, 84)).toBe(true);
  });
});
