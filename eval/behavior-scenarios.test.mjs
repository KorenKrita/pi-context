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

  test("passes only when the real new-front file follows checkpoint, transition, and direct continuation", async () => {
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

  test("accepts the travel transaction backup as the pivot save point", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("acm_travel", { target: "root", handoff: HANDOFF, backupCurrentHeadAs: "research-pivot-raw" }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(true);
    expect(result.checks.find((item) => item.name === "recoverable save point before the pivot")?.pass).toBe(true);
  });

  test("rejects a pivot that has neither a standalone checkpoint nor a travel backup", async () => {
    const root = workspace();
    writeFileSync(join(root, "onboarding-outline.md"), "# First day\n## Access setup\n## First support task\n");
    const calls = [
      call("acm_travel", { target: "root", handoff: HANDOFF }),
      call("write", { path: "onboarding-outline.md", content: "outline" }),
    ];

    const result = await pivot.score({ events: [], toolCalls: calls, assistantTexts: [], workspace: root });

    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "recoverable save point before the pivot")?.pass).toBe(false);
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
