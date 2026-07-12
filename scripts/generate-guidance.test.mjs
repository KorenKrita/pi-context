import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveGuidance,
  renderGuidance,
} from "./generate-guidance.mjs";
import {
  ACM_CORE,
  ACM_CORE_MARKER,
  GUIDANCE_CUES,
  RECOVERY_GUIDANCE,
  TOOL_DESCRIPTIONS,
} from "../src/generated-guidance.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(repoRoot, "skills", "context-management", "CORE.md");
const outputPath = join(repoRoot, "src", "generated-guidance.ts");
const source = readFileSync(sourcePath, "utf8");

describe("canonical guidance generation", () => {
  test("derives every artifact from one marked source", () => {
    const derived = deriveGuidance(source);

    expect(ACM_CORE).toBe(derived.core);
    expect(TOOL_DESCRIPTIONS).toEqual(derived.toolDescriptions);
    expect(GUIDANCE_CUES).toEqual(derived.guidanceCues);
    expect(RECOVERY_GUIDANCE).toEqual(derived.recoveryGuidance);
    expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
    expect(RECOVERY_GUIDANCE.hostCapability).toContain("supported Pi version");
    expect(RECOVERY_GUIDANCE.hostCapability).not.toContain("OMP");
  });

  test("renders deterministically and idempotently", () => {
    const first = renderGuidance(source);
    const second = renderGuidance(source);

    expect(first).toBe(second);
    expect(first).toBe(readFileSync(outputPath, "utf8"));
  });

  test("check mode reports stale output without writing", async () => {
    const tempOutput = `${outputPath}.stale-test`;
    await Bun.write(tempOutput, "stale\n");
    try {
      const process = Bun.spawn(["bun", new URL("./generate-guidance.mjs", import.meta.url).pathname, "--source", sourcePath, "--output", tempOutput, "--check"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Generated guidance is stale");
      expect(readFileSync(tempOutput, "utf8")).toBe("stale\n");
    } finally {
      await Bun.file(tempOutput).delete();
    }
  });

  test("fails when a required marker is missing or duplicated", () => {
    const marker = "<!-- ACM:TOOL_TIMELINE:START -->";

    expect(() => deriveGuidance(source.replace(marker, ""))).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 0/1",
    );
    expect(() => deriveGuidance(`${source}\n${marker}`)).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 2/1",
    );
  });

  test("keeps normal cues concise and view-specific", () => {
    expect(Object.keys(GUIDANCE_CUES).sort()).toEqual([
      "checkpointDone",
      "checkpointStart",
      "timelineActive",
      "timelineCheckpoints",
      "timelineSearch",
      "timelineTree",
      "travelPhase",
      "travelTask",
    ]);

    for (const cue of Object.values(GUIDANCE_CUES)) {
      expect(cue.length).toBeLessThan(300);
      expect(cue).not.toContain("### Normal state transitions");
      expect(cue).not.toContain("Goal: <");
    }
    expect(GUIDANCE_CUES.timelineActive).toContain("`active`");
    expect(GUIDANCE_CUES.timelineCheckpoints).toContain("`checkpoints`");
    expect(GUIDANCE_CUES.timelineSearch).toContain("`search`");
    expect(GUIDANCE_CUES.timelineTree).toContain("`tree`");
  });

  test("keeps recovery branches separately selectable", () => {
    expect(Object.keys(RECOVERY_GUIDANCE).sort()).toEqual([
      "branchRolledBack",
      "hostCapability",
      "nameCollision",
      "refreshExhausted",
      "refreshPending",
      "restoredHistory",
      "rollbackFailed",
      "rollbackSkipped",
    ]);
    for (const guidance of Object.values(RECOVERY_GUIDANCE)) {
      expect(guidance.length).toBeLessThan(350);
      expect(guidance).not.toContain("# Exceptional Recovery");
    }
  });
});
