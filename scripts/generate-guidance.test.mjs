import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("renders identical guidance from Windows CRLF source", () => {
    const crlfSource = source.replace(/\n/g, "\r\n");

    expect(renderGuidance(crlfSource)).toBe(renderGuidance(source));
  });

  test("check mode accepts a Windows CRLF checkout", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "pi-context-guidance-crlf-"));
    const tempSource = join(tempDirectory, "CORE.md");
    const tempOutput = join(tempDirectory, "generated-guidance.ts");
    await Bun.write(tempSource, source.replace(/\n/g, "\r\n"));
    await Bun.write(tempOutput, renderGuidance(source).replace(/\n/g, "\r\n"));
    try {
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)), "--source", tempSource, "--output", tempOutput, "--check"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Verified");
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("check mode reports stale output without writing", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "pi-context-guidance-"));
    const tempOutput = join(tempDirectory, "generated-guidance.ts");
    await Bun.write(tempOutput, "stale\n");
    try {
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)), "--source", sourcePath, "--output", tempOutput, "--check"], {
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
      rmSync(tempDirectory, { recursive: true, force: true });
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
    const endMarker = "<!-- ACM:TOOL_TIMELINE:END -->";
    const misordered = source.replace(marker, "").replace(endMarker, `${endMarker}\n${marker}`);
    expect(() => deriveGuidance(misordered)).toThrow("Marker TOOL_TIMELINE: END must appear after START");
  });

  test("keeps normal cues concise, state-neutral, and view-specific", () => {
    expect(Object.keys(GUIDANCE_CUES).sort()).toEqual([
      "checkpoint",
      "rebaseCheck",
      "timelineActive",
      "timelineCheckpoints",
      "timelineSearch",
      "timelineTree",
      "travel",
    ]);

    for (const cue of Object.values(GUIDANCE_CUES)) {
      expect(cue.length).toBeLessThan(350);
      expect(cue).not.toContain("### Tend the working set");
      expect(cue).not.toContain("Goal: <");
    }
    expect(GUIDANCE_CUES.checkpoint).toContain("working set is unchanged");
    expect(GUIDANCE_CUES.checkpoint).toContain("bookmark, not a closing bracket");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("summary debt");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("not permission to travel");
    expect(GUIDANCE_CUES.timelineActive).toContain("`active`");
    expect(GUIDANCE_CUES.timelineCheckpoints).toContain("`checkpoints`");
    expect(GUIDANCE_CUES.timelineSearch).toContain("`search`");
    expect(GUIDANCE_CUES.timelineTree).toContain("`tree`");
    expect(GUIDANCE_CUES.travel).toContain("new working set");
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
