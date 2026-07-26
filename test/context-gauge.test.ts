import { describe, expect, test } from "bun:test";
import {
	buildGaugeSuffix,
	createGaugeState,
	isAcmTool,
	isGaugeDisabled,
	markGaugeShown,
	shouldShowGauge,
} from "../src/context-gauge.js";
import { calculateContextUsagePressure } from "../src/context-pressure.js";

// The gauge is the only perception surface ACM injects (AGENTS.md gauge
// contract). These tests lock the user-visible behavior: what the suffix
// says, when it appears, and what must never be decorated.

describe("context gauge", () => {
	test("renders two needles under the 400k cap and one when the window is the budget", () => {
		const capped = calculateContextUsagePressure(410_000, 1_000_000, 41);
		expect(capped?.policy).toBe("400k-cap");
		// 410K/400K budget = 102%, 410K/1M window = 41% — over-budget stays
		// a visible fact, never clamped: the budget is information, not a wall.
		expect(buildGaugeSuffix(capped!)).toBe("\n[ctx 102% budget · 41% window]");

		const plain = calculateContextUsagePressure(50_000, 200_000, 25);
		expect(plain?.policy).toBe("actual-window");
		expect(buildGaugeSuffix(plain!)).toBe("\n[ctx 25% window]");
	});

	test("odometer cadence: shows on integer change in either direction, silent otherwise", () => {
		const state = createGaugeState();
		// Fresh cycle always shows once — the post-transition reading is the anchor.
		expect(shouldShowGauge(state, 12.4)).toBe(true);
		markGaugeShown(state, 12.4);
		// Same integer → silence; fractional drift is not a fact worth a line.
		expect(shouldShowGauge(state, 12.9)).toBe(false);
		// Up one integer → show.
		expect(shouldShowGauge(state, 13.0)).toBe(true);
		// Down after a fold → show too; shrinkage is honest feedback.
		expect(shouldShowGauge(state, 11.2)).toBe(true);
		// Garbage readings never render.
		expect(shouldShowGauge(state, Number.NaN)).toBe(false);
		expect(shouldShowGauge(state, -1)).toBe(false);
	});

	test("ACM results and the kill switch stay undecorated", () => {
		expect(isAcmTool("acm_travel")).toBe(true);
		expect(isAcmTool("acm_checkpoint")).toBe(true);
		expect(isAcmTool("bash")).toBe(false);
		expect(isGaugeDisabled({ ACM_GAUGE_DISABLED: "1" })).toBe(true);
		expect(isGaugeDisabled({})).toBe(false);
	});
});
