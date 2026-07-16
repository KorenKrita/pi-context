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
  PROMPT_GUIDELINES,
  PROMPT_SNIPPETS,
  RECOVERY_GUIDANCE,
  TOOL_DESCRIPTIONS,
} from "../src/generated-guidance.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreSourcePath = join(repoRoot, "skills", "context-management", "CORE.md");
const toolContractsPath = join(repoRoot, "skills", "context-management", "TOOL-CONTRACTS.md");
const outputPath = join(repoRoot, "src", "generated-guidance.ts");
const coreSource = readFileSync(coreSourcePath, "utf8");
const toolContractsSource = readFileSync(toolContractsPath, "utf8");

describe("canonical guidance generation", () => {
  test("derives doctrine and contracts from their authoritative sources", () => {
    const derived = deriveGuidance(coreSource, toolContractsSource);

    expect(ACM_CORE).toBe(derived.core);
    expect(TOOL_DESCRIPTIONS).toEqual(derived.toolDescriptions);
    expect(PROMPT_SNIPPETS).toEqual(derived.promptSnippets);
    expect(PROMPT_GUIDELINES).toEqual(derived.promptGuidelines);
    expect(GUIDANCE_CUES).toEqual(derived.guidanceCues);
    expect(RECOVERY_GUIDANCE).toEqual(derived.recoveryGuidance);
    expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
    expect(coreSource).not.toContain("ACM:TOOL_CHECKPOINT");
    expect(toolContractsSource).not.toContain("ACM:CORE:START");
    expect(RECOVERY_GUIDANCE.hostCapability).toContain("supported Pi version");
    expect(RECOVERY_GUIDANCE.hostCapability).not.toContain("OMP");
  });

  test("renders deterministically and idempotently", () => {
    const first = renderGuidance(coreSource, toolContractsSource);
    const second = renderGuidance(coreSource, toolContractsSource);

    expect(first).toBe(second);
    expect(first).toBe(readFileSync(outputPath, "utf8"));
  });

  test("renders identical guidance from Windows CRLF sources", () => {
    const crlfCoreSource = coreSource.replace(/\n/g, "\r\n");
    const crlfToolContractsSource = toolContractsSource.replace(/\n/g, "\r\n");

    expect(renderGuidance(crlfCoreSource, crlfToolContractsSource)).toBe(
      renderGuidance(coreSource, toolContractsSource),
    );
  });

  test("check mode accepts Windows CRLF sources", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "pi-context-guidance-crlf-"));
    const tempCoreSource = join(tempDirectory, "CORE.md");
    const tempToolContracts = join(tempDirectory, "TOOL-CONTRACTS.md");
    const tempOutput = join(tempDirectory, "generated-guidance.ts");
    await Bun.write(tempCoreSource, coreSource.replace(/\n/g, "\r\n"));
    await Bun.write(tempToolContracts, toolContractsSource.replace(/\n/g, "\r\n"));
    await Bun.write(tempOutput, renderGuidance(coreSource, toolContractsSource).replace(/\n/g, "\r\n"));
    try {
      const process = Bun.spawn([
        "bun",
        fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)),
        "--core-source",
        tempCoreSource,
        "--contracts-source",
        tempToolContracts,
        "--output",
        tempOutput,
        "--check",
      ], {
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
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)), "--core-source", coreSourcePath, "--contracts-source", toolContractsPath, "--output", tempOutput, "--check"], {
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

  test("fails when a required marker is missing, duplicated, or in the wrong source", () => {
    const marker = "<!-- ACM:TOOL_TIMELINE:START -->";

    expect(() => deriveGuidance(coreSource, toolContractsSource.replace(marker, ""))).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 0/1",
    );
    expect(() => deriveGuidance(coreSource, `${toolContractsSource}\n${marker}`)).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 2/1",
    );
    const endMarker = "<!-- ACM:TOOL_TIMELINE:END -->";
    const misordered = toolContractsSource.replace(marker, "").replace(endMarker, `${endMarker}\n${marker}`);
    expect(() => deriveGuidance(coreSource, misordered)).toThrow("Marker TOOL_TIMELINE: END must appear after START");
    expect(() => deriveGuidance(coreSource.replace("<!-- ACM:CORE:START -->", ""), toolContractsSource)).toThrow(
      "Expected exactly one CORE marker pair; found 0/1",
    );
  });

  test("keeps normal cues and prompt guidelines concise and state-specific", () => {
    expect(Object.keys(GUIDANCE_CUES).sort()).toEqual([
      "checkpoint",
      "rebaseCheck",
      "timelineActive",
      "timelineCheckpoints",
      "timelineSearch",
      "timelineTree",
      "travel",
    ]);
    expect(Object.keys(PROMPT_SNIPPETS).sort()).toEqual(["checkpoint", "timeline", "travel"]);
    expect(Object.keys(PROMPT_GUIDELINES).sort()).toEqual(["checkpoint", "timeline", "travel"]);

    for (const cue of [
      ...Object.values(GUIDANCE_CUES),
      ...Object.values(PROMPT_SNIPPETS),
      ...Object.values(PROMPT_GUIDELINES),
    ]) {
      expect(cue.length).toBeLessThan(350);
      expect(cue).not.toContain("### Tend the working set");
      expect(cue).not.toContain("Goal: <");
    }
    expect(PROMPT_SNIPPETS.travel).toContain("receipt establishes the outcome");
    expect(PROMPT_GUIDELINES.checkpoint).toContain("matching receipt establishes the outcome");
    expect(PROMPT_GUIDELINES.timeline).toContain("factual topology");
    expect(PROMPT_GUIDELINES.travel).toContain("Run the request alone");
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
