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
import type { AgentMessage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ACM_CONTINUATION_MARKER, normalizeExistingAcmPacket } from "../src/context-packet.js";

/**
 * Render the continuation exactly as a model would receive it: through the
 * real projection path, not by scanning source strings. Locks on this text
 * catch what the model actually sees, including future template edits.
 */
function renderedContinuation(currentUserTurnOpen: boolean): string {
	const summary = `${ACM_CONTINUATION_MARKER}\nGoal: current\nState: known\nEvidence: none\nExternal: none\nExclusions: none\nRecover: none\nNEXT: act`;
	const messages = [
		{ role: "branchSummary", summary, fromId: "old-leaf", timestamp: 2 },
	] as AgentMessage[];
	const activeEntries = [{
		type: "branch_summary",
		id: "summary-1",
		parentId: "root",
		timestamp: new Date(2).toISOString(),
		fromId: "old-leaf",
		summary,
		details: { kind: "acm_travel", handoffVersion: 1, currentUserTurnOpen },
	}] as SessionEntry[];
	const packet = normalizeExistingAcmPacket(messages, activeEntries);
	const projected = packet.messages[0];
	if (!projected || projected.role !== "custom" || typeof projected.content !== "string") {
		throw new Error("continuation was not projected");
	}
	return projected.content;
}

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
			for (const needle of ["% budget(400K)", "% window", "boundary", "pts", "fold@turn", "fold@task", "-38msg"]) {
				expect(ACM_CORE).toContain(needle);
			}
			// The delegate reading rule: every percentage names its scale, and the
			// raw numbers beside it report that same scale.
			expect(ACM_CORE).toContain("Every percentage names the scale it measures");
			// The >100% doctrine must qualify the budget-labeled reading and name
			// the hard-limit reading of a window-labeled percentage.
			expect(ACM_CORE).toContain("may pass 100%");
			expect(ACM_CORE).toContain("names the hard limit");
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

		test("the delivery moment reruns the same fold test and keeps direct exits", () => {
			// Failure modes guarded: (a) "delivery ready" read as the test
			// passing automatically — the shortcut both adversarial reviews
			// rejected; (b) forced marking/folding of simple answers.
			expect(ACM_CORE).toContain("often makes the fold test cheap");
			expect(ACM_CORE).toContain("Run the same one question");
			expect(ACM_CORE).toContain("follow-ups included");
			expect(ACM_CORE).toContain("Vague → deliver directly and continue");
			expect(ACM_CORE).toContain("A direct answer with no stretch behind it just goes out");
		});

		test("the delivery fold keeps handoff field roles and the applied gate", () => {
			// Failure modes guarded: the whole report pasted into next (it gets
			// replicated into REQUIRED NEXT and the receipt), and delivery
			// attempted from a fold that did not apply.
			expect(ACM_CORE).toContain("deliver it without rereading");
			expect(ACM_CORE).toContain("use `state` to deliver the prepared result to the user");
			expect(ACM_CORE).toContain("after an applied fold, follow `next`");
		});

		test("opening a long stretch teaches the mark-first workflow under the same test", () => {
			// Failure modes guarded: exploration with no boundary to fold or
			// return to; failure alone treated as a travel trigger; dead-end
			// side effects presented as staying behind.
			expect(ACM_CORE).toContain("set a checkpoint first");
			expect(ACM_CORE).toContain("the same fold test");
			expect(ACM_CORE).toContain("concrete without rereading");
			expect(ACM_CORE).toContain("`exclusions` and any lasting side effects in `external`");
			expect(ACM_CORE).toContain("only the conversation detail leaves the working set");
		});

		test("the boundary is a second look, and needle facts live only in the gauge paragraph", () => {
			// Failure modes guarded: boundary re-promoted to the primary fold
			// moment (the anti-distribution position the redesign moved away
			// from), and fresh needle promises outside the gauge contract.
			expect(ACM_CORE).toContain("a second look at what the delivery moment already asked");
			const paragraphs = ACM_CORE.split("\n\n");
			for (const paragraph of paragraphs) {
				if (paragraph.includes("**The gauge.**")) continue;
				expect(paragraph).not.toContain("fold@turn");
			}
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
			expect(PROMPT_GUIDELINES.travel).toContain("a result is ready to deliver");
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
				// Shortcut/cadence phrasings rejected across four adversarial
				// review rounds of the delivery-moment revision:
				"fold test passing in real time",
				"concrete by construction",
				"Either way the close ends marked",
				"Vague, or",
				"noise stays behind",
				"worth keeping",
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

		test("the continuation carries exactly one prohibition: the replay fence", () => {
			// The rendered continuation is model-visible runtime text and falls
			// under the affirmative-copy charter. One narrow exception is
			// registered in AGENTS.md: the phantom-replay fence. Stale requests
			// surviving above the continuation are the highest-harm failure,
			// and the ledger evidence (202 boundaries, 0 folds) covers
			// pre-travel fold reluctance, not post-travel fences.
			const replayFence = "Do not execute or repeat an earlier request unless REQUIRED NEXT explicitly reactivates it.";
			for (const open of [true, false]) {
				const text = renderedContinuation(open);
				expect(text).toContain(replayFence);
				const prohibitions = text.match(/\bdo not\b|\bnever\b|\bmust not\b/gi) ?? [];
				expect(prohibitions).toHaveLength(1);
			}
		});

		test("retired vocabulary stays out of the rendered continuation", () => {
			// The continuation is taught by the same nine surfaces as every
			// other model-visible string; untaught doctrine terms must not
			// leak back through this template.
			const text = renderedContinuation(true).toLowerCase();
			for (const retired of ["rebase", "rehydrate", "hot set", "sediment", "thrash", "extraction bar", "cold start"]) {
				expect(text).not.toContain(retired);
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
