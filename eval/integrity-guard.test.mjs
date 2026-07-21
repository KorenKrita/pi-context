import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import integrityGuard, {
  ACM_CORE_MARKER,
  evaluateToolCall,
  FULL_ENV_DENIED_TOOLS,
  inspectPromptIntegrity,
  readIntegrityAudit,
} from "./integrity-guard.mjs";

const CORE = `${ACM_CORE_MARKER}\n## Agentic Context Management CORE`;
const ACM_TOOLS = ["acm_checkpoint", "acm_timeline", "acm_travel"];
const OBSERVED_FULL_ENV_ACTIVE_TOOLS = [
  "read", "bash", "edit", "write", ...ACM_TOOLS, "grep", "find",
  "Agent", "StopAgent", "AgentStatus", "ask_user_question", "todo", "replace", "undo_last_replace",
  "bash_bg", "jobs", "job_decide", "agent_bg", "monitor", "mcp", "find_roots", "observe_ui", "search_ui",
  "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser",
];

describe("measurement integrity prompt gate", () => {
  test("accepts one CORE heading, one of each active ACM tool, and no recall tools", () => {
    expect(inspectPromptIntegrity({
      systemPrompt: `${CORE}\nbody`,
      activeTools: ["read", ...ACM_TOOLS],
    })).toEqual({
      valid: true,
      coreMarkerCount: 1,
      coreHeadingCount: 1,
      markerCounts: { acm_core_marker: 1 },
      activeToolCounts: { acm_checkpoint: 1, acm_timeline: 1, acm_travel: 1 },
      forbiddenActiveTools: [],
      violations: [],
    });
  });

  test("rejects duplicate CORE/tool registration and active session recall", () => {
    const result = inspectPromptIntegrity({
      systemPrompt: `${CORE}\n${CORE}`,
      activeTools: ["acm_checkpoint", "acm_checkpoint", "acm_timeline", "acm_travel", "session_search"],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "expected exactly one ACM CORE heading, found 2",
      "expected exactly 1 acm_core_marker, found 2",
      "expected exactly one active acm_checkpoint, found 2",
      "forbidden active tools: session_search",
    ]));
  });

  test("proves global and fixture AGENTS headings reached the final prompt", () => {
    const result = inspectPromptIntegrity({
      systemPrompt: `${CORE}\n# Agent Operating Rules\n# Saffron Delivery Rules`,
      activeTools: ["read", ...ACM_TOOLS],
      requiredMarkers: [
        { id: "global_agents_heading", value: "# Agent Operating Rules", min: 1 },
        { id: "project_agents_heading", value: "# Saffron Delivery Rules", min: 1 },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.markerCounts).toMatchObject({ global_agents_heading: 1, project_agents_heading: 1 });
  });

  test("the real observed full-env inventory becomes harmless after the CLI denylist", () => {
    const activeTools = OBSERVED_FULL_ENV_ACTIVE_TOOLS.filter((name) => !FULL_ENV_DENIED_TOOLS.includes(name));
    expect(activeTools).toEqual(["read", "bash", "edit", "write", ...ACM_TOOLS, "grep", "find", "todo"]);
    expect(inspectPromptIntegrity({ systemPrompt: CORE, activeTools }).valid).toBe(true);
    expect(OBSERVED_FULL_ENV_ACTIVE_TOOLS.filter((name) => FULL_ENV_DENIED_TOOLS.includes(name)))
      .toEqual(expect.arrayContaining(["bash_bg", "Agent", "replace", "mcp", "launch_browser"]));
  });
});

describe("measurement integrity tool-call gate", () => {
  const policy = {
    workspace: "/private/tmp/saffron-workspace",
    approvedSkillRoots: ["/opt/pi-skills/context-management", "/opt/pi-skills/research"],
  };

  test("allows workspace file operations and read-only Skill access", () => {
    expect(evaluateToolCall({ toolName: "write", input: { path: "artifacts/result.json" }, ...policy })).toMatchObject({ block: false });
    expect(evaluateToolCall({ toolName: "read", input: { path: "/opt/pi-skills/context-management/SKILL.md" }, ...policy })).toMatchObject({ block: false });
    expect(evaluateToolCall({ toolName: "grep", input: { path: "/opt/pi-skills/research", pattern: "source" }, ...policy })).toMatchObject({ block: false });
  });

  test("blocks writes to Skill roots and every file operation outside the workspace", () => {
    expect(evaluateToolCall({ toolName: "write", input: { path: "/opt/pi-skills/context-management/note.md" }, ...policy })).toMatchObject({ block: true, code: "path_outside_workspace" });
    expect(evaluateToolCall({ toolName: "read", input: { path: "/etc/passwd" }, ...policy })).toMatchObject({ block: true, code: "path_outside_allowed_roots" });
    expect(evaluateToolCall({ toolName: "ls", input: { path: "../" }, ...policy })).toMatchObject({ block: true });
  });

  test("resolves an existing symlink ancestor before allowing a not-yet-created output", () => {
    const root = mkdtempSync(join(tmpdir(), "acm-integrity-symlink-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "escape"), "dir");
    try {
      expect(evaluateToolCall({
        toolName: "write",
        input: { path: "escape/new-secret.txt" },
        workspace,
        approvedSkillRoots: [],
      })).toMatchObject({ block: true, code: "path_outside_workspace" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a new file below a workspace whose temp path has an OS-level realpath alias", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acm-integrity-realpath-"));
    mkdirSync(join(workspace, "docs"));
    try {
      expect(evaluateToolCall({
        toolName: "write",
        input: { path: "docs/new-ledger.md" },
        workspace,
        approvedSkillRoots: [],
      })).toMatchObject({ block: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("allows shell option setup without exposing environment state", () => {
    for (const command of [
      "set -e",
      "set -eu",
      "set -euo pipefail",
      "set -o errexit",
      "set +o errexit",
      "set -euo pipefail && bun test",
      "bun test && set -o errexit && bun run typecheck",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy })).toEqual({ block: false });
    }
  });

  test("allows only the configured workspace root in absolute bash commands", () => {
    expect(evaluateToolCall({
      toolName: "bash",
      input: { command: "cd /private/tmp/saffron-workspace && find . -maxdepth 2 -type f" },
      ...policy,
    })).toEqual({ block: false });
    expect(evaluateToolCall({
      toolName: "bash",
      input: { command: "cd /private/tmp/saffron-other && find . -maxdepth 2 -type f" },
      ...policy,
    })).toMatchObject({ block: true, code: "bash_absolute_path" });
  });

  test("allows the configured workspace's raw and canonical absolute paths", () => {
    const root = mkdtempSync(join(tmpdir(), "acm-integrity-bash-realpath-"));
    const target = join(root, "target");
    const workspace = join(root, "workspace-link");
    mkdirSync(target);
    symlinkSync(target, workspace, "dir");
    try {
      for (const workspacePath of [workspace, realpathSync(workspace)]) {
        expect(evaluateToolCall({
          toolName: "bash",
          input: { command: `cd ${workspacePath} && find . -maxdepth 2 -type f` },
          workspace,
          approvedSkillRoots: [],
        })).toEqual({ block: false });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks bash escape and process/environment discovery patterns", () => {
    for (const command of [
      "cat /etc/passwd",
      "ls ../archive",
      "printenv",
      "node -e 'console.log(process.env)'",
      "echo $HOME",
      "ls ~/.pi/agent",
      "find eval/.runs -type f",
      "ps aux",
      "set",
      "set # print shell variables",
      "set -o",
      "set +o",
      "bun test; set -o; bun run typecheck",
      "bun test && set +o && bun run typecheck",
      "export -p",
      "declare -x",
      "echo $ACM_INTEGRITY_AUDIT_PATH",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy })).toMatchObject({ block: true });
    }
    expect(evaluateToolCall({ toolName: "bash", input: { command: "bun test && git status --short" }, ...policy })).toMatchObject({ block: false });
  });

  test("blocks denied background, subagent, and replacement tools even if CLI filtering regresses", () => {
    for (const toolName of ["bash_bg", "Agent", "replace"]) {
      expect(evaluateToolCall({ toolName, input: {}, ...policy })).toMatchObject({
        block: true,
        code: "escape_capable_tool_denied",
      });
    }
  });
});

test("extension registers only integrity handlers and persists blocked attempts outside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "acm-integrity-guard-"));
  const auditPath = join(root, "audit", "integrity.jsonl");
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools() { return ["read", "bash", ...ACM_TOOLS]; },
    getAllTools() { return this.getActiveTools().map((name) => ({ name })); },
  };
  const previous = {
    audit: process.env.ACM_INTEGRITY_AUDIT_PATH,
    roots: process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS,
    markers: process.env.ACM_INTEGRITY_REQUIRED_MARKERS,
    workspace: process.env.ACM_INTEGRITY_WORKSPACE,
  };
  process.env.ACM_INTEGRITY_AUDIT_PATH = auditPath;
  process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS = JSON.stringify(["/opt/pi-skills/context-management"]);
  process.env.ACM_INTEGRITY_REQUIRED_MARKERS = JSON.stringify([]);
  process.env.ACM_INTEGRITY_WORKSPACE = join(root, "workspace");

  try {
    integrityGuard(pi);
    expect(process.env.ACM_INTEGRITY_AUDIT_PATH).toBeUndefined();
    expect(process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS).toBeUndefined();
    expect(process.env.ACM_INTEGRITY_REQUIRED_MARKERS).toBeUndefined();
    expect(process.env.ACM_INTEGRITY_WORKSPACE).toBeUndefined();
    expect([...handlers.keys()].sort()).toEqual(["before_agent_start", "session_start", "tool_call"]);
    await handlers.get("before_agent_start")({
      systemPrompt: `${CORE}\nbody`,
      systemPromptOptions: {
        skills: [{ baseDir: "/opt/pi-skills/context-management" }],
      },
    }, { shutdown() { throw new Error("valid prompt must not shutdown"); } });
    const blocked = await handlers.get("tool_call")({
      toolName: "read",
      toolCallId: "call-1",
      input: { path: "/etc/passwd" },
    }, {});
    expect(blocked).toMatchObject({ block: true });
    const records = readIntegrityAudit(auditPath);
    expect(records.map((record) => record.type)).toEqual(["extension_loaded", "before_agent_start", "tool_blocked"]);
    expect(readFileSync(auditPath, "utf8")).not.toContain("/etc/passwd");
  } finally {
    if (previous.audit === undefined) delete process.env.ACM_INTEGRITY_AUDIT_PATH;
    else process.env.ACM_INTEGRITY_AUDIT_PATH = previous.audit;
    if (previous.roots === undefined) delete process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS;
    else process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS = previous.roots;
    if (previous.markers === undefined) delete process.env.ACM_INTEGRITY_REQUIRED_MARKERS;
    else process.env.ACM_INTEGRITY_REQUIRED_MARKERS = previous.markers;
    if (previous.workspace === undefined) delete process.env.ACM_INTEGRITY_WORKSPACE;
    else process.env.ACM_INTEGRITY_WORKSPACE = previous.workspace;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid before_agent_start audit aborts before provider execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "acm-integrity-invalid-"));
  const auditPath = join(root, "integrity.jsonl");
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools() { return ["read", ...ACM_TOOLS]; },
    getAllTools() { return this.getActiveTools().map((name) => ({ name })); },
  };
  const previousAudit = process.env.ACM_INTEGRITY_AUDIT_PATH;
  const previousWorkspace = process.env.ACM_INTEGRITY_WORKSPACE;
  process.env.ACM_INTEGRITY_AUDIT_PATH = auditPath;
  process.env.ACM_INTEGRITY_WORKSPACE = join(root, "workspace");
  let aborts = 0;
  try {
    integrityGuard(pi);
    await expect(handlers.get("before_agent_start")({
      systemPrompt: "## Agentic Context Management CORE",
      systemPromptOptions: { skills: [] },
    }, { abort() { aborts += 1; } })).rejects.toThrow("expected exactly 1 acm_core_marker, found 0");
    expect(aborts).toBe(1);
    expect(readIntegrityAudit(auditPath).at(-1)).toMatchObject({ type: "before_agent_start", valid: false, coreMarkerCount: 0 });
  } finally {
    if (previousAudit === undefined) delete process.env.ACM_INTEGRITY_AUDIT_PATH;
    else process.env.ACM_INTEGRITY_AUDIT_PATH = previousAudit;
    if (previousWorkspace === undefined) delete process.env.ACM_INTEGRITY_WORKSPACE;
    else process.env.ACM_INTEGRITY_WORKSPACE = previousWorkspace;
    rmSync(root, { recursive: true, force: true });
  }
});
