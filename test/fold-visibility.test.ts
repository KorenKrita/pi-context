/**
 * Context gauge visibility test.
 * Verifies the simplified gauge renders correctly.
 */
import { describe, it, expect } from "bun:test";
import { buildGaugeSuffix } from "../src/context-gauge.js";
import type { ContextUsagePressure } from "../src/context-pressure.js";

describe("context gauge visibility", () => {
  it("renders simple percentage under 400k cap", () => {
    const pressure: ContextUsagePressure = {
      tokens: 200_000,
      contextWindow: 1_000_000,
      usagePercent: 20,
      workingBudgetTokens: 400_000,
      pressurePercent: 50,
      policy: "400k-cap",
    };
    const suffix = buildGaugeSuffix(pressure);
    expect(suffix).toBe("\n[ctx 50%]");
  });

  it("renders window percent when no cap applies", () => {
    const pressure: ContextUsagePressure = {
      tokens: 50_000,
      contextWindow: 200_000,
      usagePercent: 25,
      workingBudgetTokens: 200_000,
      pressurePercent: 25,
      policy: "actual-window",
    };
    const suffix = buildGaugeSuffix(pressure);
    expect(suffix).toBe("\n[ctx 25%]");
  });

  it("floors the percentage", () => {
    const pressure: ContextUsagePressure = {
      tokens: 150_000,
      contextWindow: 1_000_000,
      usagePercent: 15,
      workingBudgetTokens: 400_000,
      pressurePercent: 37.5,
      policy: "400k-cap",
    };
    const suffix = buildGaugeSuffix(pressure);
    expect(suffix).toBe("\n[ctx 37%]");
  });
});
