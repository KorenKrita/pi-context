// Guidance-quality locks are deliberately sparse. Three categories only:
//
// 1. Structural invariants — document shape that runtime and hosts depend on
//    (marker, canonical vocabulary, move set, seven handoff slots, one example).
// 2. Load-bearing phrases — exact wording with measured behavioral effect;
//    every lock cites its evidence inline. Do not add a phrase lock without
//    evidence that the wording (not just the idea) carries the effect.
// 3. Negative locks — machinery and pressure language that measurably harmed
//    behavior and must not return.
//
// Decorative prose is intentionally unlocked: CORE wording may be refined
// freely as long as the invariants above hold.
import { describe, expect, test } from "bun:test";
import {
	ACM_CORE,
	ACM_CORE_MARKER,
	GUIDANCE_CUES,
	RECOVERY_GUIDANCE,
	TOOL_DESCRIPTIONS,
} from "../src/generated-guidance.js";

const skillFile = (path: string) => Bun.file(new URL(`../skills/context-management/${path}`, import.meta.url)).text();

describe("ACM guidance quality", () => {
	describe("structural invariants", () => {
		test("keeps the injection marker stable for host prompt detection", () => {
			expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
		});

		test("keeps the canonical vocabulary present", () => {
			const core = ACM_CORE.toLowerCase();
			for (const term of ["working set", "hot set", "cold start", "handoff", "sediment", "thrash", "receipt"]) {
				expect(core).toContain(term);
			}
		});

		test("offers the full move set", () => {
			for (const move of ["**Save**", "**Orient**", "**Fold**", "**Rebase**", "**Rehydrate**", "**Fork**"]) {
				expect(ACM_CORE).toContain(move);
			}
		});

		test("keeps exactly one full JSON handoff example with all seven slots", () => {
			for (const slot of ["\"goal\":", "\"state\":", "\"evidence\":", "\"external\":", "\"exclusions\":", "\"recover\":", "\"next\":"]) {
				expect(ACM_CORE).toContain(slot);
			}
			// One worked example pins the format; contrasts stay prose so the
			// format anchor is unambiguous.
			expect(ACM_CORE.split("```json").length - 1).toBe(1);
			// The example must model live cognition (open hypotheses + hot set),
			// not a results-only report.
			expect(ACM_CORE).toContain("Two hypotheses");
			expect(ACM_CORE).toContain("Hot:");
		});
	});

	describe("load-bearing phrases", () => {
		test("fold reads as safe as a save", () => {
			// Evidence: eval-archive tag, PHASE1-LOG — fold-as-safe symmetry with
			// the save agents already trust drove the Phase 1 fold-adoption gains.
			expect(ACM_CORE).toContain("as recoverable as a save");
		});

		test("cold start keeps obligations alive through mid-work folds", () => {
			// Evidence: eval-archive tag, PHASE10-LOG — v4.1 added the obligation
			// clause; mid-obligation folds then kept the task alive in every
			// strong run. v3 scopes the license to a spent stretch (dead end
			// banked, detour paid out, ingest distilled), not the whole task.
			expect(ACM_CORE).toContain("obligations survive");
			expect(ACM_CORE).toContain("Mid-investigation travel can be valuable");
			expect(ACM_CORE).toContain("when the stretch is itself spent");
		});

		test("the extraction bar gates every fold", () => {
			// Contract: acm-judgment-contract.md v1 Travel — extraction-complete
			// is the fold qualification; vague handoffs mean the fold is unearned.
			// Evidence: sol-t30-pair (eval-archive) — a t6 fold before survey
			// extraction closed triggered a 24-read rebuild wave.
			expect(ACM_CORE).toContain("Extraction-complete is the bar");
			expect(ACM_CORE).toContain("the extraction bar telling you the fold is not yet earned");
			// Recoverability covers accidents, not half-done extraction.
			expect(ACM_CORE).toContain("insurance against accidents, not a license");
			expect(ACM_CORE).toContain("what you never extracted, you will not know to go back for");
		});

		test("above the bar, deferral is drag — the tool leans forward", () => {
			// Contract: v1 北极星「度」条款 (user-decided 2026-07-27) — at the
			// best-effect frontier, prefer active use; regret is asymmetric.
			expect(ACM_CORE).toContain("lean into the fold");
			expect(ACM_CORE).toContain("Deferring a fold you have already earned is drag, not caution");
		});

		test("cadence stays judgment, never gauge- or move-authorization", () => {
			// Contract: v1 度 — the budget is information, not a deadline; no
			// fixed percentage anchor may exist for a compliant model to chase.
			expect(ACM_CORE).toContain("information, not a deadline");
			expect(ACM_CORE).toContain("Numbers carry no instruction");
			for (const check of ["Compression Candidate", "Compressibility", "Attention effect", "Recovery value", "Transition effect"]) {
				expect(ACM_CORE).toContain(check);
			}
			// Contract: v1 边界自认 cadence pair.
			expect(ACM_CORE).toContain("compress continuously");
			expect(ACM_CORE).toContain("Fold in batches");
		});

		test("boundaries are self-noticed and the tree is the answer space", () => {
			// Contract: v1 边界自认 — the perception layer is a gauge; no worded
			// cue exists, so boundary sense is the model's own duty.
			expect(ACM_CORE).toContain("No cue will fire");
			// Contract: v1 树即答案空间 — re-asking the user for what the
			// session already holds is the canonical navigation failure.
			expect(ACM_CORE).toContain("Asking again is a navigation failure, not caution");
		});

		test("the survivor is the same person, and post-fold trust is bounded spot-checks", () => {
			// Contract: v1 Trusted Handoff — live cognition survives the fold
			// (北极星: not "like a different person after folding").
			expect(ACM_CORE).toContain("still sound like the same person");
			// Rereads to "make sure" are the cost the fold removed; one
			// load-bearing claim may be spot-checked against its pointer.
			expect(ACM_CORE).toContain("the exact cost the fold existed to remove");
			expect(ACM_CORE).toContain("a bounded spot-check, not a re-derivation");
		});

		test("autonomy pauses only on explicit user request", () => {
			// Contract: AGENTS.md — agent owns ACM by default; only an explicit
			// user request pauses travel, and only for the named scope.
			expect(ACM_CORE).toContain("explicit user request to hold travel");
		});

		test("NEXT is defined by executability", () => {
			// Evidence: eval-archive tag, acm-optimization-next-2026-07-21 — NEXT
			// executability was the paired-eval axis; this is the definition.
			expect(ACM_CORE).toContain("one concrete action a fresh agent could execute immediately");
		});

		test("root is a rebase candidate, never a default", () => {
			// Contract: AGENTS.md semantic-rebase section.
			expect(ACM_CORE).toContain("Root is a candidate, never a default");
		});

		test("trusted handoff: execute NEXT, no post-travel verification ritual", () => {
			// Evidence: docs/acm-judgment-contract.md Trusted Handoff — applied
			// travel is trusted state, not something to re-verify.
			expect(GUIDANCE_CUES.travel).toContain("Execute NEXT directly");
			expect(RECOVERY_GUIDANCE.restoredHistory).toContain("Execute this handoff's NEXT directly");
		});

		test("rebase cue stays a recognition cue", () => {
			// Contract: AGENTS.md — stacked summaries are a recognition cue, not
			// a required transition.
			expect(GUIDANCE_CUES.rebaseCheck).toContain("a rebase check is worthwhile");
		});

		test("rehydration return uses target, never the backup alias", () => {
			// Contract: AGENTS.md — a backup alias restores raw history; the
			// return pointer goes in `target`, and the return must not silently
			// become a different fold base.
			expect(RECOVERY_GUIDANCE.restoredHistory).toContain("use that pointer as the next `target`, not `backupCurrentHeadAs`");
			expect(RECOVERY_GUIDANCE.restoredHistory).toContain("do not substitute an older fold base");
		});

		test("receipt discipline and external-state honesty", () => {
			// Contract: AGENTS.md mutation outcomes — applied / not_applied /
			// indeterminate; travel never rolls back external side effects.
			expect(ACM_CORE).toContain("applied, not applied, or indeterminate");
			expect(ACM_CORE).toContain("Travel rewrites conversation context only");
			// Travel must run alone so its receipt is unambiguous.
			expect(TOOL_DESCRIPTIONS.travel).toContain("alone in its assistant tool batch");
		});
	});

	describe("negative locks", () => {
		test("mandatory workflow machinery must not return", () => {
			// Evidence: pre-Phase1 preflight/state-machine guidance measurably
			// suppressed autonomous travel; removed and locked out.
			for (const banned of ["preflight", "Normal state transitions", "Required transition", "Fold gate", "-paused", "`<chain>-start`", "first action"]) {
				expect(ACM_CORE).not.toContain(banned);
			}
		});

		test("fold-pressure language must not return", () => {
			// Evidence: eval-archive tag, PHASE10-LOG — v4 default-fold pressure
			// caused mid-obligation folds that dropped the task; removed in v4.1.
			expect(ACM_CORE).not.toContain("folding is the default, not an optional extra");
			expect(ACM_CORE).not.toContain("Skip only when you can name why");
		});

		test("numeric anchors a compliant model could chase must not return", () => {
			// Contract: v1 度 — the 1/3-budget cruise anchor was removed because
			// compliant models fold toward numbers; the gauge stays numbers-only
			// and the doctrine stays timing-based (extraction bar), not level-based.
			expect(ACM_CORE).not.toContain("around a third of the working budget");
			expect(ACM_CORE).not.toContain("comfortable cruise");
		});

		test("cues never order a rebase or a verification ritual", () => {
			expect(GUIDANCE_CUES.rebaseCheck).not.toContain("Rebase instead");
			// Evidence: docs/acm-judgment-contract.md Trusted Handoff — the old
			// "verified return pointer" wording invited re-verification.
			expect(RECOVERY_GUIDANCE.restoredHistory).not.toContain("verified return pointer");
		});

		test("rollback-failure recovery stays self-contained", () => {
			// Rollback failure needs immediate factual guidance, not a Skill
			// routing detour.
			expect(RECOVERY_GUIDANCE.rollbackFailed).not.toContain("context-management");
		});
	});

	describe("advanced routing", () => {
		test("routes one reference at a time from the Skill router", async () => {
			const skill = await skillFile("SKILL.md");
			for (const section of ["Advanced Target Selection", "Archive Recovery", "Exceptional Recovery"]) {
				expect(skill).toContain(section);
			}
			expect(skill).toContain("Load one reference at a time");
			expect(skill).toContain("replace the active reference");
			expect(GUIDANCE_CUES.advancedTargetPointer).toContain("`context-management` Skill");
			expect(GUIDANCE_CUES.advancedTargetPointer).toContain("`references/target-selection.md`");
			expect(GUIDANCE_CUES.advancedExceptionalPointer).toContain("`context-management` Skill");
			expect(GUIDANCE_CUES.advancedExceptionalPointer).toContain("`references/exceptional-recovery.md`");
		});

		test("resolves references from the advertised Skill location", () => {
			for (const pointer of [GUIDANCE_CUES.advancedTargetPointer, GUIDANCE_CUES.advancedExceptionalPointer]) {
				// Regression guard: references were once resolved cwd-relative
				// and via a baked-in absolute path.
				expect(pointer).toContain("`location`");
				expect(pointer).toContain("not a cwd-relative path");
				expect(pointer).toContain("router first");
				expect(pointer).not.toContain("/Users/");
			}
		});

		test("keeps reference criteria factual and checkable", async () => {
			const target = await skillFile("references/target-selection.md");
			const archive = await skillFile("references/archive-recovery.md");
			const exceptional = await skillFile("references/exceptional-recovery.md");

			// Rebase base selection stays a checkable topology criterion.
			expect(target).toContain("must precede at least one active `branch_summary`");
			expect(target).toContain("projected summary depth must not grow");
			expect(target).toContain("every surviving item has one authoritative home");
			expect(archive).toContain("Rehydration round trip");
			// Evidence: docs/acm-judgment-contract.md Trusted Handoff.
			expect(archive).toContain("trust the returned handoff and resume the original action directly");
			for (const condition of ["Backup rollback failure", "Indeterminate branch mutation", "Low-yield fold"]) {
				expect(exceptional).toContain(condition);
			}
			// Anti-thrash: completion alone never justifies a fold.
			expect(exceptional).toContain("travel is never required merely to record completion");
		});
	});
});
