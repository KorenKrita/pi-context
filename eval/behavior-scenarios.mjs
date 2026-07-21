// Short, outcome-scored behavior probes for ACM judgment.
//
// These scenarios deliberately avoid ACM vocabulary in their user prompts.
// They test whether a model can recognize a useful transition at a real task
// pivot, and can then refrain from creating redundant transitions in the new,
// clean working cycle.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scoreHandoff, toolSucceeded } from "./scenario-scoring.mjs";

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

function recordForTurn(ctx, index) {
  return ctx.turnRecords?.[index] ?? { events: [], toolCalls: [], assistantTexts: [] };
}

function normalizedPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function toolPath(call) {
  return normalizedPath(call?.args?.path ?? call?.args?.file_path ?? call?.args?.file);
}

function writesPath(call, relativePath) {
  const path = toolPath(call);
  return call?.name === "write" && (path === relativePath || path.endsWith(`/${relativePath}`));
}

function shellWritesPath(call, relativePath) {
  if (call?.name !== "bash" || typeof call.args?.command !== "string") return false;

  const command = call.args.command;
  const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = `(?:[\"'](?:[^\"']*\\/)?${escapedPath}[\"']|(?:[^\\s;|&]*\\/)?${escapedPath})(?=$|\\s|[;|&])`;
  const redirect = new RegExp(`(?:^|[\\s;&|])(?:\\d*>>?|&>>?)\\s*${target}`, "m");
  const tee = new RegExp(`(?:^|[\\s;&|])tee(?:\\s+(?:--append|-[A-Za-z]+))*\\s+(?:--\\s+)?${target}`, "m");

  return redirect.test(command) || tee.test(command);
}

function writesReleaseTag(call) {
  return writesPath(call, "docs/release-tag.txt") || shellWritesPath(call, "docs/release-tag.txt");
}

function readsAny(call, names) {
  if (call?.name !== "read" && call?.name !== "read_file") return false;
  const path = toolPath(call);
  return names.some((name) => path === name || path.endsWith(`/${name}`));
}

async function readWorkspaceFile(workspace, relativePath) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    return { ok: false, contents: "", detail: "workspace was not supplied to the scorer" };
  }
  try {
    return { ok: true, contents: await readFile(join(workspace, relativePath), "utf8"), detail: "file read from workspace" };
  } catch (error) {
    return {
      ok: false,
      contents: "",
      detail: error instanceof Error ? error.code ?? error.message : String(error),
    };
  }
}

function containsOnboardingOutline(contents) {
  const text = String(contents).toLowerCase();
  return text.includes("first day") && text.includes("access setup") && text.includes("first support task");
}

function validTravelBefore(toolCalls, beforeIndex) {
  const candidates = toolCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call, index }) => index < beforeIndex && call.name === "acm_travel" && toolSucceeded(call));
  return candidates.at(-1) ?? null;
}

/** @type {import("./scenarios.mjs").Scenario[]} */
export const BEHAVIOR_SCENARIOS = [
  {
    id: "unprompted-fold-on-pivot",
    family: "behavior",
    description: "A finished, information-heavy research front gives way to an unrelated onboarding front without naming ACM tools.",
    seedFiles: {
      "research/market.md": [
        "# Market signals",
        "Enterprise pilots value predictable launch windows over feature count.",
        "Two buyers asked for a first-day admin checklist.",
        "The target launch cohort is support-led teams.",
        "",
      ].join("\n"),
      "research/interviews.md": [
        "# Interview notes",
        "Support leads want access setup before their first live queue.",
        "New hires need one contained support task after access is ready.",
        "Managers asked for a short first-day path, not a long manual.",
        "",
      ].join("\n"),
      "research/operations.md": [
        "# Operations constraints",
        "Access requests normally settle within one business day.",
        "The first support task should use a supervised low-risk queue.",
        "Launch briefing is complete once the research brief is delivered.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read research/market.md, research/interviews.md, and research/operations.md completely.",
          "Synthesize their settled conclusions into research-brief.md for the launch team.",
          "The brief should distinguish market signals, interview conclusions, and operating constraints.",
          "When the brief exists, report that the research deliverable is complete.",
        ].join(" "),
        timeoutMs: 360000,
      },
      {
        prompt: [
          "The research brief is accepted. We are now switching to an unrelated internal onboarding front.",
          "Preserve the completed research state in the most useful form for a possible later return, and clear stale process from your active working conversation when that helps.",
          "Then create onboarding-outline.md as your first concrete action on the new front.",
          "It must contain distinct sections named First day, Access setup, and First support task.",
          "Do not reopen the research source files before creating that outline.",
        ].join(" "),
        timeoutMs: 360000,
      },
    ],
    async score(ctx) {
      const allCalls = ctx.toolCalls;
      // The first attempted new-front write is the behavior boundary. A failed
      // write before the transition is still an attempted switch and must not
      // be hidden by a later successful retry after travel.
      const outlineWriteIndex = allCalls.findIndex((call) => writesPath(call, "onboarding-outline.md"));
      const outlineWrite = outlineWriteIndex >= 0 ? allCalls[outlineWriteIndex] : undefined;
      const transition = outlineWriteIndex >= 0 ? validTravelBefore(allCalls, outlineWriteIndex) : null;
      const travel = transition?.call;
      const travelIndex = transition?.index ?? -1;
      const checkpoint = travelIndex >= 0
        ? allCalls.slice(0, travelIndex).find((call) => call.name === "acm_checkpoint" && toolSucceeded(call))
        : undefined;
      const backup = typeof travel?.args?.backupCurrentHeadAs === "string"
        ? travel.args.backupCurrentHeadAs.trim()
        : "";
      const savePoint = toolSucceeded(checkpoint) || backup.length > 0;
      const handoff = scoreHandoff(travel?.args?.handoff);
      const firstPostTravel = travelIndex >= 0 ? allCalls[travelIndex + 1] : undefined;
      const directNewFrontAction = toolSucceeded(firstPostTravel) && writesPath(firstPostTravel, "onboarding-outline.md");
      const postTravelBeforeOutline = travelIndex >= 0 && outlineWriteIndex >= 0
        ? allCalls.slice(travelIndex + 1, outlineWriteIndex)
        : [];
      const rereadBeforeNewFront = postTravelBeforeOutline.some((call) =>
        readsAny(call, ["research/market.md", "research/interviews.md", "research/operations.md"]));
      const nextNamesOutline = typeof handoff.fields?.next === "string" && handoff.fields.next.includes("onboarding-outline.md");
      const outline = await readWorkspaceFile(ctx.workspace, "onboarding-outline.md");
      const actualOutline = outline.ok && containsOnboardingOutline(outline.contents);

      const checks = [
        check("recoverable save point before the pivot", savePoint,
          toolSucceeded(checkpoint)
            ? `checkpoint=${checkpoint.args?.name ?? "unnamed"}`
            : backup.length > 0
              ? `travel backup=${backup}`
              : "no successful checkpoint or non-empty travel backup before the pivot"),
        check("successful transition before the new-front write", toolSucceeded(travel) && toolSucceeded(outlineWrite),
          travel ? "travel succeeded before onboarding-outline.md" : "no successful travel before onboarding-outline.md"),
        check("structured handoff", handoff.ok, handoff.detail),
        check("handoff NEXT names the new front", nextNamesOutline,
          nextNamesOutline ? "NEXT carries onboarding-outline.md" : "NEXT did not name onboarding-outline.md"),
        check("first post-transition tool action writes the new front", directNewFrontAction,
          directNewFrontAction ? "onboarding-outline.md first" : `first=${firstPostTravel?.name ?? "none"}`),
        check("did not reread finished research before the new-front action", !rereadBeforeNewFront,
          rereadBeforeNewFront ? "research source was read after transition" : "no research reread"),
        check("onboarding outline exists with required content", actualOutline,
          actualOutline ? "verified from workspace" : `${outline.detail}; required sections missing or file absent`),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
  {
    id: "restraint-clean-new-cycle",
    family: "behavior",
    description: "After a successful context transition, a tiny independent task should complete without another save or transition first.",
    seedFiles: {
      "release-review.md": [
        "# Release review",
        "Settled: release notes are approved.",
        "Settled: no migration remains.",
        "Recoverable detail: approval packet is retained in the review archive.",
        "The next request will be unrelated to this closed review.",
        "",
      ].join("\n"),
    },
    turns: [
      {
        prompt: [
          "Read release-review.md completely.",
          "This review is closed and the next request will be unrelated.",
          "Preserve the settled review in a concise form that a fresh collaborator could continue from, then move the working conversation to the next clean front.",
          "Do not start the future task yet.",
        ].join(" "),
        timeoutMs: 360000,
      },
      {
        prompt: [
          "Now make one tiny local change: create docs/release-tag.txt containing exactly release-2026.07.21.",
          "Once the file exists, state that this small task is complete.",
          "Keep the current working conversation intact while doing this local task.",
        ].join(" "),
        timeoutMs: 240000,
      },
    ],
    async score(ctx) {
      const firstCycle = recordForTurn(ctx, 0);
      const newCycle = recordForTurn(ctx, 1);
      const initialTravelIndex = firstCycle.toolCalls.findIndex((call) => call.name === "acm_travel" && toolSucceeded(call));
      const initialTravel = initialTravelIndex >= 0 ? firstCycle.toolCalls[initialTravelIndex] : undefined;
      const handoff = scoreHandoff(initialTravel?.args?.handoff);
      const tagWriteIndex = newCycle.toolCalls.findIndex((call) => toolSucceeded(call) && writesReleaseTag(call));
      const tagWrite = tagWriteIndex >= 0 ? newCycle.toolCalls[tagWriteIndex] : undefined;
      const transitionBeforeCompletion = tagWriteIndex >= 0
        ? newCycle.toolCalls.slice(0, tagWriteIndex).filter((call) => call.name === "acm_checkpoint" || call.name === "acm_travel")
        : newCycle.toolCalls.filter((call) => call.name === "acm_checkpoint" || call.name === "acm_travel");
      const tag = await readWorkspaceFile(ctx.workspace, "docs/release-tag.txt");
      const actualTag = tag.ok && ["release-2026.07.21", "release-2026.07.21\n", "release-2026.07.21\r\n"].includes(tag.contents);

      const checks = [
        check("first cycle transition succeeded", toolSucceeded(initialTravel),
          initialTravel ? "travel succeeded" : "missing successful travel in first cycle"),
        check("first cycle has a structured handoff", handoff.ok, handoff.detail),
        check("tiny task reached its real workspace file", toolSucceeded(tagWrite) && actualTag,
          actualTag ? "docs/release-tag.txt verified from workspace" : `${tag.detail}; expected exact release tag`),
        check("no extra save or transition before tiny task completion", transitionBeforeCompletion.length === 0,
          transitionBeforeCompletion.length === 0
            ? "no checkpoint/travel before tag write"
            : `saw ${transitionBeforeCompletion.map((call) => call.name).join(", ")} before tag write`),
      ];
      return { pass: checks.every((item) => item.pass), checks };
    },
  },
];
