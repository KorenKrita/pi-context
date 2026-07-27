/**
 * ACM guidance quality tests — simplified version.
 * Verifies the generated guidance contains essential concepts.
 */
import { describe, it, expect } from "bun:test";
import { ACM_CORE, TOOL_DESCRIPTIONS, GUIDANCE_CUES, RECOVERY_GUIDANCE, TREE_SUMMARY_INSTRUCTIONS } from "../src/generated-guidance.js";

describe("ACM guidance quality", () => {
  describe("CORE contains essential concepts", () => {
    it("mentions the three tools", () => {
      expect(ACM_CORE).toContain("acm_checkpoint");
      expect(ACM_CORE).toContain("acm_timeline");
      expect(ACM_CORE).toContain("acm_travel");
    });

    it("explains the handoff format", () => {
      expect(ACM_CORE).toContain("goal");
      expect(ACM_CORE).toContain("state");
      expect(ACM_CORE).toContain("evidence");
      expect(ACM_CORE).toContain("external");
      expect(ACM_CORE).toContain("exclusions");
      expect(ACM_CORE).toContain("recover");
      expect(ACM_CORE).toContain("next");
    });

    it("describes when to fold", () => {
      expect(ACM_CORE).toContain("fold");
      expect(ACM_CORE).toContain("summarize");
    });

    it("mentions the gauge indicator", () => {
      expect(ACM_CORE).toContain("[ctx");
    });

    it("explains checkpoint, timeline, fold, rebase, rehydrate", () => {
      expect(ACM_CORE).toContain("Checkpoint");
      expect(ACM_CORE).toContain("Timeline");
      expect(ACM_CORE).toContain("Fold");
      expect(ACM_CORE).toContain("Rebase");
      expect(ACM_CORE).toContain("Rehydrate");
    });
  });

  describe("tool descriptions are present", () => {
    it("has descriptions for all three tools", () => {
      expect(TOOL_DESCRIPTIONS.checkpoint.length).toBeGreaterThan(20);
      expect(TOOL_DESCRIPTIONS.timeline.length).toBeGreaterThan(20);
      expect(TOOL_DESCRIPTIONS.travel.length).toBeGreaterThan(20);
    });
  });

  describe("cues are concise and actionable", () => {
    it("checkpoint cue mentions context unchanged", () => {
      expect(GUIDANCE_CUES.checkpoint.toLowerCase()).toContain("unchanged");
    });

    it("travel cue says to execute NEXT", () => {
      expect(GUIDANCE_CUES.travel).toContain("NEXT");
    });

    it("rebase check cue mentions summary layers", () => {
      expect(GUIDANCE_CUES.rebaseCheck.toLowerCase()).toContain("summary");
    });
  });

  describe("recovery guidance covers key scenarios", () => {
    it("has all recovery entries", () => {
      expect(RECOVERY_GUIDANCE.nameCollision.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.hostCapability.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.rollbackFailed.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.branchRolledBack.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.rollbackSkipped.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.refreshPending.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.restoredHistory.length).toBeGreaterThan(10);
      expect(RECOVERY_GUIDANCE.refreshExhausted.length).toBeGreaterThan(10);
    });
  });

  describe("tree summary instructions", () => {
    it("mentions the seven handoff fields", () => {
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("Goal:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("State:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("Evidence:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("External:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("Exclusions:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("Recover:");
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain("NEXT:");
    });
  });
});
