import { describe, expect, test } from "bun:test";
import {
	buildGaugeSuffix,
	createGaugeState,
	isAcmTool,
	isGaugeDisabled,
	isNewBoundary,
	markGaugeShown,
	resetGaugeOdometer,
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

	test("boundary marker and save-point count render between the pressure and fold needles", () => {
		const pressure = calculateContextUsagePressure(410_000, 1_000_000, 41);
		expect(buildGaugeSuffix(pressure!, undefined, { boundary: true, savePoints: 3 }))
			.toBe("\n[ctx 102% budget · 41% window · boundary · 3pts]");
		// No boundary, unknown save points → pure pressure needles, no filler.
		expect(buildGaugeSuffix(pressure!, undefined, { boundary: false, savePoints: null }))
			.toBe("\n[ctx 102% budget · 41% window]");
	});

	test("a new user boundary forces one reading; the same boundary never repeats its marker", () => {
		const state = createGaugeState();
		expect(shouldShowGauge(state, 12.4, "req-1")).toBe(true);
		expect(isNewBoundary(state, "req-1")).toBe(true);
		markGaugeShown(state, 12.4, "req-1");
		// Same request, same integer → silent, and the marker is spent.
		expect(shouldShowGauge(state, 12.8, "req-1")).toBe(false);
		expect(isNewBoundary(state, "req-1")).toBe(false);
		// Next request forces a reading even at the same integer.
		expect(shouldShowGauge(state, 12.8, "req-2")).toBe(true);
		expect(isNewBoundary(state, "req-2")).toBe(true);
	});

	test("odometer reset forces the next reading but never re-renders the request's boundary marker", () => {
		const state = createGaugeState();
		markGaugeShown(state, 40.0, "req-1");
		// Mid-request context transition (travel/model change): pressure anchor
		// is stale, boundary already rendered once for this request.
		resetGaugeOdometer(state);
		expect(shouldShowGauge(state, 12.0, "req-1")).toBe(true);
		expect(isNewBoundary(state, "req-1")).toBe(false);
	});

	test("a fold that re-exposes an older user entry does not resurrect its boundary marker", () => {
		// Cross-boundary fold: the current request's user entry leaves the
		// branch and the previous request's entry becomes the branch's last
		// user boundary again. It was already seen — it is not a new request.
		const state = createGaugeState();
		markGaugeShown(state, 20.0, "req-1");
		markGaugeShown(state, 30.0, "req-2");
		resetGaugeOdometer(state);
		expect(isNewBoundary(state, "req-1")).toBe(false);
		markGaugeShown(state, 12.0, "req-1");
		// A genuinely new request still announces itself.
		expect(isNewBoundary(state, "req-3")).toBe(true);
	});
	test("ACM results and the kill switch stay undecorated", () => {
		expect(isAcmTool("acm_travel")).toBe(true);
		expect(isAcmTool("acm_checkpoint")).toBe(true);
		expect(isAcmTool("bash")).toBe(false);
		expect(isGaugeDisabled({ ACM_GAUGE_DISABLED: "1" })).toBe(true);
		expect(isGaugeDisabled({})).toBe(false);
	});
});
