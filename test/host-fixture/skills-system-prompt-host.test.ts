import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

test("exact Pi Skills system prompt lists an absolute SKILL.md and tells the model how to read it", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-context-skills-prompt-host-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const skillDir = join(tempDir, "skill-pack", "context-management");
    const skillPath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, [
      "---",
      "name: context-management",
      "description: Preserve a focused working set during complex multi-step work.",
      "---",
      "",
      "Read [target selection](references/target-selection.md) before choosing a branch.",
      "",
      "SKILL_BODY_MUST_STAY_ON_DEMAND",
    ].join("\n"));

    const agentDir = join(tempDir, "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir,
      additionalSkillPaths: [skillDir],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const loadedSkills = resourceLoader.getSkills().skills;
    expect(loadedSkills).toHaveLength(1);
    expect(loadedSkills[0]?.filePath).toBe(resolve(skillPath));

    const created = await createAgentSession({
      cwd: tempDir,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(join(tempDir, "session.jsonl")),
      tools: ["read"],
    });
    session = created.session;

    const prompt = session.systemPrompt;
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>context-management</name>");
    expect(prompt).toContain("<location>" + resolve(skillPath) + "</location>");
    expect(prompt).toContain("Use the read tool to load a skill's file when the task matches its description.");
    expect(prompt).toContain("When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.");
    expect(prompt).not.toContain("SKILL_BODY_MUST_STAY_ON_DEMAND");
  } finally {
    session?.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exact Pi agent-core Skills formatter retains the full-SKILL read mandate", () => {
  const skillPath = "/absolute/skill-pack/context-management/SKILL.md";
  const prompt = formatSkillsForSystemPrompt([{
    name: "context-management",
    description: "Preserve a focused working set during complex multi-step work.",
    content: "Read references/target-selection.md before choosing a branch.",
    filePath: skillPath,
  }]);

  expect(prompt).toContain("Read the full skill file when the task matches its description.");
  expect(prompt).toContain("When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.");
  expect(prompt).toContain("<available_skills>");
  expect(prompt).toContain(`<location>${skillPath}</location>`);
});
