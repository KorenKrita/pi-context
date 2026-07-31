// Guidance-quality locks are deliberately sparse. Three categories only:
//
// 1. Structural invariants — document shape that runtime and hosts depend on
//    (marker, handoff field split, gauge teaching, closed vocabulary).
// 2. Load-bearing behaviors — the affirmative-guidance redesign's core bets;
//    each lock names the failure mode it guards against.
// 3. Negative locks — suppression language that measurably harmed invocation
//    (0 folds across 202 real request boundaries) and must not return.
//
// Decorative prose is intentionally unlocked: wording may be refined freely
// as long as the invariants above hold.
import { describe, expect, test } from "bun:test";
import {
	ACM_CORE,
	ACM_CORE_MARKER,
	GUIDANCE_CUES,
	PROMPT_GUIDELINES,
	PROMPT_SNIPPETS,
	RECOVERY_GUIDANCE,
	TOOL_DESCRIPTIONS,
} from "../src/generated-guidance.js";

describe("ACM guidance quality", () => {
	describe("structural invariants", () => {
		test("keeps the injection marker stable for host prompt detection", () => {
			expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
		});

		test("teaches the three-required/four-optional handoff split everywhere it is used", () => {
			// The split is the single largest activation-energy reduction; if any
			// surface regresses to seven-required, routine folds get heavy again.
			expect(ACM_CORE).toContain("`goal`, `state`, `next` are required");
			expect(TOOL_DESCRIPTIONS.travel).toContain("goal/state/next required");
			expect(PROMPT_GUIDELINES.travel).toContain("goal, state, and next");
		});

		test("shows both a three-field routine example and a seven-field investigation example", () => {
			// Two examples define the range: minimal fold stays legitimate, and
			// mid-investigation folds carry hypotheses and exclusions.
			expect(ACM_CORE.split("```json").length - 1).toBe(2);
			expect(ACM_CORE).toContain("Two suspects");
			expect(ACM_CORE).toContain("Hot:");
		});

		test("teaches the gauge format it renders, including boundary and fold needles", () => {
			for (const needle of ["% budget", "% window", "boundary", "pts", "fold@turn", "fold@task"]) {
				expect(ACM_CORE).toContain(needle);
			}
		});

		test("keeps context-past and file-past separated in doctrine and travel mechanics", () => {
			expect(ACM_CORE).toContain("never a file backup");
			expect(TOOL_DESCRIPTIONS.checkpoint).toContain("not a file backup");
			expect(TOOL_DESCRIPTIONS.travel).toContain("conversation context only");
		});
	});

	describe("load-bearing behaviors", () => {
		test("the fold test is the single judgment bar, framed as readiness", () => {
			// Failure mode guarded: a second gate (cold-start proof, task
			// completion, thresholds) suppresses folding entirely.
			expect(ACM_CORE).toContain("Can you write a concrete handoff");
			expect(ACM_CORE).toContain("ready to fold");
			expect(ACM_CORE).toContain("Vague → keep working");
		});

		test("task length is explicitly excluded from the fold decision", () => {
			// Failure mode guarded: agents deferring folds because they cannot
			// classify a task as long, which mid-task they never can.
			expect(ACM_CORE).toContain("Task length never enters the decision");
		});

		test("not folding an undigested stretch stays legitimate at boundaries", () => {
			// Failure mode guarded: the boundary marker read as a fold command.
			expect(ACM_CORE).toContain("not a missed fold");
		});

		test("every fold records a return ticket and the cue directs forward execution", () => {
			expect(ACM_CORE).toContain("return ticket");
			expect(TOOL_DESCRIPTIONS.travel).toContain("automatic return ticket");
			expect(GUIDANCE_CUES.travel).toContain("execute next");
		});

		test("folded history is the first source before asking the user", () => {
			expect(ACM_CORE).toContain("Folded history is the first source");
		});

		test("prompt surfaces carry scenario triggers, not contracts", () => {
			// The retrieval surfaces must answer "when do I use this" in
			// scenario words a tool chooser can match.
			expect(PROMPT_GUIDELINES.travel).toContain("debugging phase converges");
			expect(PROMPT_GUIDELINES.checkpoint).toContain("phase boundaries");
			expect(PROMPT_SNIPPETS.travel.toLowerCase()).toContain("fold");
		});
	});

	describe("negative locks", () => {
		test("suppression framing stays retired from every model-facing surface", () => {
			// Evidence: boundary ledger — 202 real request boundaries, 0 folds
			// under warning-laden doctrine copy. These patterns are the residue.
			const surfaces = [
				ACM_CORE,
				...Object.values(TOOL_DESCRIPTIONS),
				...Object.values(GUIDANCE_CUES),
				...Object.values(PROMPT_SNIPPETS),
				...Object.values(PROMPT_GUIDELINES),
			].join("\n");
			for (const retired of [
				"Fold only what",
				"must pass cold start",
				"extraction-complete",
				"Extraction-complete",
				"sediment",
				"thrash",
				"never as a fold/rebase base",
				"is not yet earned",
			]) {
				expect(surfaces).not.toContain(retired);
			}
		});

		test("untaught vocabulary stays out of constant surfaces", () => {
			// Closed vocabulary: every term a model sees must be taught. These
			// were doctrine terms whose teaching was removed with the old CORE.
			const surfaces = [
				ACM_CORE,
				...Object.values(TOOL_DESCRIPTIONS),
				...Object.values(GUIDANCE_CUES),
				...Object.values(PROMPT_SNIPPETS),
				...Object.values(PROMPT_GUIDELINES),
				...Object.values(RECOVERY_GUIDANCE),
			].join("\n").toLowerCase();
			for (const untaught of ["rebase", "rehydrate", "hot set", "anchor gravity"]) {
				expect(surfaces).not.toContain(untaught);
			}
		});

		test("no advanced-skill routing pointers remain", () => {
			// The skill layer is deleted; pointers to it would send the model
			// hunting for files that do not exist.
			const surfaces = [
				...Object.values(GUIDANCE_CUES),
				...Object.values(RECOVERY_GUIDANCE),
			].join("\n");
			expect(surfaces).not.toContain("Skill");
			expect(surfaces).not.toContain("references/");
		});
	});
});
