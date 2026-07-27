// 草根版 guidance locks: structure only, no phrase locks.
// The old philosophical wording locks were removed on purpose — the caogen
// rewrite keeps guidance plain and freely editable. What stays locked:
// 1. The injection marker (hosts detect it).
// 2. The seven handoff slots appear in CORE with one JSON example.
// 3. Generated guidance stays in sync with its markdown sources.
import { describe, expect, test } from "bun:test";
import { ACM_CORE, ACM_CORE_MARKER } from "../src/generated-guidance.js";

describe("ACM guidance quality", () => {
	test("keeps the injection marker stable for host prompt detection", () => {
		expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
	});

	test("keeps exactly one full JSON handoff example with all seven slots", () => {
		for (const slot of ["\"goal\":", "\"state\":", "\"evidence\":", "\"external\":", "\"exclusions\":", "\"recover\":", "\"next\":"]) {
			expect(ACM_CORE).toContain(slot);
		}
		expect(ACM_CORE.split("```json").length - 1).toBe(1);
	});

	test("names all three tools", () => {
		for (const tool of ["acm_checkpoint", "acm_timeline", "acm_travel"]) {
			expect(ACM_CORE).toContain(tool);
		}
	});
});
