import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./scenarios.mjs";

const temporaryWorkspaces = [];

afterEach(() => {
  for (const workspace of temporaryWorkspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function workspace() {
  const path = mkdtempSync(join(tmpdir(), "pi-context-behavior-scenario-"));
  temporaryWorkspaces.push(path);
  return path;
}

function call(name, args = {}, details = {}) {
  return { name, args, completed: true, isError: false, details };
}

const HANDOFF = {
  goal: "Carry the completed research forward while beginning the unrelated onboarding work",
  state: "Research conclusions are settled and the next front is a short onboarding outline",
  evidence: "research-brief.md contains the completed launch conclusions",
  external: "none",
  exclusions: "Do not reopen the settled research before creating the onboarding outline",
  recover: "research-pivot-raw",
  next: "Create onboarding-outline.md with First day, Access setup, and First support task.",
};

const RECOVERY_ROUTE_CHECK = "handoff Recover identifies a verified recovery route";

const COMPLETED_RESEARCH_BRIEF = [
  "# Research brief",
  "## Market signals",
  "Predictable launch windows matter.",
  "## Interview conclusions",
  "Access comes before the first support task.",
  "## Operating constraints",
  "Access settles within one business day.",
].join("\n");

function writeOutline(root) {
  writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
}

function writeCompletedResearchBrief(root) {
  writeFileSync(join(root, "research-brief.md"), COMPLETED_RESEARCH_BRIEF);
}

function scenario(id) {
  const found = SCENARIOS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing behavior scenario ${id}`);
  return found;
}

describe("unprompted pivot behavior scenario", () => {
  const pivot = scenario("unprompted-fold-on-pivot");

  test("user prompts do not name ACM mechanisms", () => {
    const prompt = pivot.turns.map((turn) => turn.prompt).join("\n").toLowerCase();

    expect(prompt).not.toMatch(/\bacm\b/);
    expect(prompt).not.toMatch(/\bcheckpoint\b/);
    expect(prompt).not.toMatch(/\btravel\b/);
    expect(prompt).not.toMatch(/\bhandoff\b/);
    expect(prompt).not.toMatch(/\btimeline\b/);
    expect(prompt).not.toMatch(/\b(?:rebase|rehydrate|fold)\b/);
  });

  test("passes only when the real new-front file follows a verified recovery route, transition, and direct continuation", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), [
      "# First day",
      "## Access setup",
      "## First support task",
    ].join("\n"));
    const calls = [
      call("read", { path: "research/market.md" }),
      call("write", { path: "research-brief.md", content: "completed research" }),
      call("acm_checkpoint", { name: "research-pivot" }),
      call("acm_travel", { target: "research-pivot", handoff: HANDOFF, backupCurrentHeadAs: "research-pivot-raw" }),
      call("write", { path: "onboarding-outline.md", content: "pretend tool args are enough" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "first post-transition tool action writes the new front")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "onboarding outline exists with required content")?.pass).toBe(true);
  });

  test("accepts the travel transaction backup when primary Recover names that backup", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("acm_travel", { target: "root", handoff: HANDOFF, backupCurrentHeadAs: "research-pivot-raw" }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(true);
  });

  test("rejects a pivot that has neither a matching checkpoint nor a matching travel backup", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("acm_travel", { target: "root", handoff: HANDOFF }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("attributes a missing outline to the actual stale-replay travel", async () => {
    const root = workspace();
    const staleHandoff = { ...HANDOFF, next: "none — research front is closed." };
    const calls = [
      call("acm_checkpoint", { name: "research-brief-complete" }),
      call("acm_travel", {
        target: "root",
        handoff: staleHandoff,
        backupCurrentHeadAs: "research-raw-process",
      }),
      call("read", { path: "research-brief.md" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "successful transition before the new-front write")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "structured handoff")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "handoff NEXT names the new front")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "first post-transition tool action writes the new front")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "onboarding outline exists with required content")?.pass).toBe(false);
  });

  test("does not let a travel after the first outline write repair ordering", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("write", { path: "onboarding-outline.md", content: "outline" }),
      call("acm_checkpoint", { name: "too-late" }),
      call("acm_travel", { target: "root", handoff: HANDOFF, backupCurrentHeadAs: "too-late-raw" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "successful transition before the new-front write")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "structured handoff")?.pass).toBe(false);
  });

  test("does not credit write arguments when the real workspace file is absent", async () => {
    const root = workspace();
    const calls = [
      call("acm_checkpoint", { name: "research-pivot" }),
      call("acm_travel", { target: "research-pivot", handoff: HANDOFF }),
      call("write", {
        path: "onboarding-outline.md",
        content: "# First day\n## Access setup\n## First support task",
      }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "onboarding outline exists with required content")?.pass).toBe(false);
  });

  test("fails a research reread before the required direct new-front action", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("acm_checkpoint", { name: "research-pivot" }),
      call("acm_travel", { target: "research-pivot", handoff: HANDOFF }),
      call("read", { path: "research/interviews.md" }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "first post-transition tool action writes the new front")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "did not reread finished research before the new-front action")?.pass).toBe(false);
  });

  test("accepts a matching checkpoint named as the primary Recover reference", async () => {
    const root = workspace();
    writeOutline(root);
    const calls = [
      call("acm_checkpoint", { name: "research-brief-accepted" }),
      call("acm_travel", {
        target: "research-brief-accepted",
        handoff: { ...HANDOFF, recover: "checkpoint 'research-brief-accepted' preserves the accepted research state." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(true);
  });

  test("accepts a complete durable research brief named at the start of Recover", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("write", { path: "research-brief.md", content: COMPLETED_RESEARCH_BRIEF }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md on disk is the durable accepted research artifact." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(true);
  });

  test("accepts a complete durable research brief written through a successful shell redirect", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("bash", {
        command: "printf '%s\\n' '## Market signals' '## Interview conclusions' '## Operating constraints' > research-brief.md",
      }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md durable artifact for the accepted research front." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(true);
  });

  test("rejects an unrelated checkpoint even when its presence previously looked like a save point", async () => {
    const root = workspace();
    writeOutline(root);
    const calls = [
      call("acm_checkpoint", { name: "unrelated-release-review" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-pivot checkpoint is the recovery route." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects a nonexistent Recover alias instead of crediting a different successful travel backup", async () => {
    const root = workspace();
    writeOutline(root);
    const calls = [
      call("acm_travel", {
        target: "root",
        backupCurrentHeadAs: "research-raw-archive",
        handoff: { ...HANDOFF, recover: "missing-research-archive" },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("does not let Evidence or External substitute for a Recover route", async () => {
    const root = workspace();
    writeOutline(root);
    const calls = [
      call("acm_travel", {
        target: "root",
        handoff: {
          ...HANDOFF,
          evidence: "research-brief.md is a complete durable artifact",
          external: "research-brief.md remains on disk",
          recover: "none",
        },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects a vague prior-conversation pointer despite a complete brief on disk", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("write", { path: "research-brief.md", content: "complete brief" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "Prior conversation node contains the full raw research process." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects source-only and glob Recover references even when the brief is complete", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("write", { path: "research-brief.md", content: "complete brief" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research/*.md source files remain available." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects a durable brief write that occurs only after travel", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md is the durable artifact." },
      }),
      call("write", { path: "research-brief.md", content: "too late" }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects a pre-travel incomplete write even when a post-travel overwrite makes the final brief complete", async () => {
    const root = workspace();
    writeOutline(root);
    writeCompletedResearchBrief(root);
    const calls = [
      call("write", { path: "research-brief.md", content: "## Market signals\nOnly one section existed before travel." }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md is the durable artifact." },
      }),
      call("write", { path: "research-brief.md", content: COMPLETED_RESEARCH_BRIEF }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects an absent research brief despite a pre-travel write call", async () => {
    const root = workspace();
    writeOutline(root);
    const calls = [
      call("write", { path: "research-brief.md", content: "brief was claimed" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md on disk is the durable artifact." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });

  test("rejects an incomplete research brief despite a pre-travel write call", async () => {
    const root = workspace();
    writeOutline(root);
    writeFileSync(join(root, "research-brief.md"), "## Market signals\nOnly one section is present.\n");
    const calls = [
      call("write", { path: "research-brief.md", content: "incomplete brief" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, recover: "research-brief.md on disk is the durable artifact." },
      }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === RECOVERY_ROUTE_CHECK)?.pass).toBe(false);
  });
});

describe("clean-cycle restraint behavior scenario", () => {
  const restraint = scenario("restraint-clean-new-cycle");

  function context(root, secondTurnCalls, firstTurnCalls = [
    call("read", { path: "release-review.md" }),
    call("acm_checkpoint", { name: "release-review-closed" }),
    call("acm_travel", {
      target: "release-review-closed",
      handoff: { ...HANDOFF, goal: "Preserve the closed release review", next: "Wait for the next unrelated task." },
    }),
  ]) {
    return {
      events: [],
      toolCalls: [
        ...firstTurnCalls,
        ...secondTurnCalls,
      ],
      assistantTexts: [],
      turnRecords: [
        {
          events: [],
          toolCalls: firstTurnCalls,
          assistantTexts: [],
        },
        { events: [], toolCalls: secondTurnCalls, assistantTexts: [] },
      ],
      workspace: root,
    };
  }

  test("passes when a real tiny-task file is completed without another transition", async () => {
    const root = workspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/release-tag.txt"), "release-2026.07.21\n");
    const secondTurn = [call("write", { path: "docs/release-tag.txt", content: "release-2026.07.21" })];

    const result = await restraint.score(context(root, secondTurn));

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "tiny task reached its real workspace file")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "no extra save or transition before tiny task completion")?.pass).toBe(true);
  });

  test("accepts a successful shell redirection without an initial standalone checkpoint", async () => {
    const root = workspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/release-tag.txt"), "release-2026.07.21\n");
    const firstTurn = [
      call("read", { path: "release-review.md" }),
      call("acm_travel", {
        target: "root",
        handoff: { ...HANDOFF, goal: "Preserve the closed release review", next: "Wait for the next unrelated task." },
      }),
    ];
    const secondTurn = [call("bash", { command: "printf 'release-2026.07.21\\n' > docs/release-tag.txt" })];

    const result = await restraint.score(context(root, secondTurn, firstTurn));

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "tiny task reached its real workspace file")?.pass).toBe(true);
  });

  test("fails when a transition precedes the successful shell write", async () => {
    const root = workspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/release-tag.txt"), "release-2026.07.21\n");
    const secondTurn = [
      call("acm_checkpoint", { name: "unnecessary-small-task-save" }),
      call("bash", { command: "printf 'release-2026.07.21\\n' > docs/release-tag.txt" }),
    ];

    const result = await restraint.score(context(root, secondTurn));

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "tiny task reached its real workspace file")?.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "no extra save or transition before tiny task completion")?.pass).toBe(false);
  });

  test("fails when a second save or transition occurs before the tiny task completes", async () => {
    const root = workspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/release-tag.txt"), "release-2026.07.21\n");
    const secondTurn = [
      call("acm_checkpoint", { name: "unnecessary-small-task-save" }),
      call("write", { path: "docs/release-tag.txt", content: "release-2026.07.21" }),
    ];

    const result = await restraint.score(context(root, secondTurn));

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "no extra save or transition before tiny task completion")?.pass).toBe(false);
  });

  test("does not credit a correct write argument when the actual tag file is missing", async () => {
    const root = workspace();
    const secondTurn = [call("write", { path: "docs/release-tag.txt", content: "release-2026.07.21" })];

    const result = await restraint.score(context(root, secondTurn));

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "tiny task reached its real workspace file")?.pass).toBe(false);
  });
});
