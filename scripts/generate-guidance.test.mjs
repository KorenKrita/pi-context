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
  TREE_SUMMARY_INSTRUCTIONS,
} from "../src/generated-guidance.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = join(repoRoot, "skills", "context-management", "CORE.md");
const contractsPath = join(repoRoot, "skills", "context-management", "TOOL-CONTRACTS.md");
const outputPath = join(repoRoot, "src", "generated-guidance.ts");
const coreSource = readFileSync(corePath, "utf8");
const contractsSource = readFileSync(contractsPath, "utf8");

describe("canonical guidance generation", () => {
  test("derives every artifact from the two marked sources", () => {
    const derived = deriveGuidance(coreSource, contractsSource);

    expect(ACM_CORE).toBe(derived.core);
    expect(TOOL_DESCRIPTIONS).toEqual(derived.toolDescriptions);
    expect(PROMPT_SNIPPETS).toEqual(derived.promptSnippets);
    expect(PROMPT_GUIDELINES).toEqual(derived.promptGuidelines);
    expect(GUIDANCE_CUES).toEqual(derived.guidanceCues);
    expect(TREE_SUMMARY_INSTRUCTIONS).toBe(derived.treeSummaryInstructions);
    expect(RECOVERY_GUIDANCE).toEqual(derived.recoveryGuidance);
    expect(ACM_CORE_MARKER).toBe("<!-- PI-CONTEXT:ACM-CORE:v1 -->");
    expect(RECOVERY_GUIDANCE.hostCapability).toContain("supported Pi version");
  });

  test("keeps manual navigation summaries handoff-shaped and standalone", () => {
    for (const slot of ["Goal:", "State:", "Evidence:", "External:", "Exclusions:", "Recover:", "NEXT:"]) {
      expect(TREE_SUMMARY_INSTRUCTIONS).toContain(slot);
    }
    expect(TREE_SUMMARY_INSTRUCTIONS).toContain("abandoned conversation branch");
    expect(TREE_SUMMARY_INSTRUCTIONS).toContain("Preserve exact file paths");
    expect(TREE_SUMMARY_INSTRUCTIONS).not.toContain("##");
  });

  test("keeps doctrine in CORE.md and mechanics in TOOL-CONTRACTS.md", () => {
    expect(coreSource).toContain("<!-- ACM:CORE:START -->");
    expect(coreSource).not.toContain("<!-- ACM:TOOL_CHECKPOINT:START -->");
    expect(contractsSource).not.toContain("<!-- ACM:CORE:START -->");
    expect(contractsSource).toContain("<!-- ACM:TOOL_TRAVEL:START -->");
  });

  test("renders deterministically and idempotently", () => {
    const first = renderGuidance(coreSource, contractsSource);
    const second = renderGuidance(coreSource, contractsSource);

    expect(first).toBe(second);
    expect(first).toBe(readFileSync(outputPath, "utf8"));
  });

  test("renders identical guidance from Windows CRLF sources", () => {
    const crlf = (value) => value.replace(/\n/g, "\r\n");

    expect(renderGuidance(crlf(coreSource), crlf(contractsSource))).toBe(renderGuidance(coreSource, contractsSource));
  });

  test("check mode accepts a Windows CRLF checkout", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "pi-context-guidance-crlf-"));
    const tempCore = join(tempDirectory, "CORE.md");
    const tempContracts = join(tempDirectory, "TOOL-CONTRACTS.md");
    const tempOutput = join(tempDirectory, "generated-guidance.ts");
    await Bun.write(tempCore, coreSource.replace(/\n/g, "\r\n"));
    await Bun.write(tempContracts, contractsSource.replace(/\n/g, "\r\n"));
    await Bun.write(tempOutput, renderGuidance(coreSource, contractsSource).replace(/\n/g, "\r\n"));
    try {
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)), "--core", tempCore, "--contracts", tempContracts, "--output", tempOutput, "--check"], {
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
      const process = Bun.spawn(["bun", fileURLToPath(new URL("./generate-guidance.mjs", import.meta.url)), "--core", corePath, "--contracts", contractsPath, "--output", tempOutput, "--check"], {
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

    expect(() => deriveGuidance(coreSource, contractsSource.replace(marker, ""))).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 0/1",
    );
    expect(() => deriveGuidance(coreSource, `${contractsSource}\n${marker}`)).toThrow(
      "Expected exactly one TOOL_TIMELINE marker pair; found 2/1",
    );
    const endMarker = "<!-- ACM:TOOL_TIMELINE:END -->";
    const misordered = contractsSource.replace(marker, "").replace(endMarker, `${endMarker}\n${marker}`);
    expect(() => deriveGuidance(coreSource, misordered)).toThrow("Marker TOOL_TIMELINE: END must appear after START");
  });

  test("keeps prompt metadata single-purpose and tool-named", () => {
    expect(Object.keys(PROMPT_SNIPPETS).sort()).toEqual(["checkpoint", "timeline", "travel"]);
    expect(Object.keys(PROMPT_GUIDELINES).sort()).toEqual(["checkpoint", "timeline", "travel"]);
    for (const [tool, snippet] of Object.entries(PROMPT_SNIPPETS)) {
      expect(snippet.includes("\n")).toBe(false);
      expect(tool.length).toBeGreaterThan(0);
    }
    for (const [tool, guideline] of Object.entries(PROMPT_GUIDELINES)) {
      for (const line of guideline.split("\n")) {
        expect(line).toContain(`acm_${tool}`);
      }
    }
  });

  test("keeps result cues concise and view-specific", () => {
    expect(Object.keys(GUIDANCE_CUES).sort()).toEqual([
      "advancedExceptionalPointer",
      "advancedTargetPointer",
      "checkpoint",
      "rebaseCheck",
      "timelineActive",
      "timelineCheckpoints",
      "timelineSearch",
      "timelineTree",
      "travel",
    ]);

    for (const cue of Object.values(GUIDANCE_CUES)) {
      expect(cue).not.toContain("Goal: <");
    }
    expect(GUIDANCE_CUES.rebaseCheck).toContain("cold start");
    expect(GUIDANCE_CUES.rebaseCheck).toContain("Root is a candidate");
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
      expect(guidance).not.toContain("# Exceptional Recovery");
    }
  });
});
