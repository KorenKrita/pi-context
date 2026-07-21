import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import integrityGuard, {
  ACM_CORE_MARKER,
  evaluateToolCall,
  inspectPromptIntegrity,
  readIntegrityAudit,
} from "./integrity-guard.mjs";

const CORE = `${ACM_CORE_MARKER}\n## Agentic Context Management CORE`;
const ACM_TOOLS = ["acm_checkpoint", "acm_timeline", "acm_travel"];

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
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy })).toMatchObject({ block: true });
    }
    expect(evaluateToolCall({ toolName: "bash", input: { command: "bun test && git status --short" }, ...policy })).toMatchObject({ block: false });
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
    workspace: process.env.ACM_INTEGRITY_WORKSPACE,
  };
  process.env.ACM_INTEGRITY_AUDIT_PATH = auditPath;
  process.env.ACM_INTEGRITY_WORKSPACE = join(root, "workspace");

  try {
    integrityGuard(pi);
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
