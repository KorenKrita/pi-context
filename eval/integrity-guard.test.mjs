import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import integrityGuard, {
  ACM_CORE_MARKER,
  evaluateToolCall,
  FULL_ENV_DENIED_TOOLS,
  inspectPromptIntegrity,
  readIntegrityAudit,
  rewriteWorkspaceTempPaths,
  workspaceTempDirectory,
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

  test("allows configured workspace paths and ordinary URL literals in bash", () => {
    for (const command of [
      "cd /private/tmp/saffron-workspace && find . -maxdepth 2 -type f",
      "ls /private/tmp/saffron-workspace>x",
      "ls /private/tmp/saffron-workspace<in",
      "echo https://example.com",
      "git log -1 --pretty='author=%an <%ae> / committer=%cn <%ce> / %h'",
      "git commit -m 'Control / Policy'",
      'printf "author=\\"%an / %ae\\""',
      [
        "cat >> docs/provenance-map.md <<'EOF'",
        "# Control / Policy",
        "| vendor / digest |",
        "/etc is quoted body prose, not a shell path",
        "EOF",
      ].join("\n"),
      [
        "cat <<'ONE' <<-\"TWO\"",
        "Control / Policy",
        "ONE",
        "\tvendor / digest",
        "\tTWO",
      ].join("\n"),
    ]) {
      expect(evaluateToolCall({
        toolName: "bash",
        input: { command },
        ...policy,
      })).toEqual({ block: false });
    }
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

  test("allows only exact /dev/null redirection paths", () => {
    for (const command of [
      "command -v rg >/dev/null && echo rg-present",
      "git status 2>/dev/null",
      "cat </dev/null",
      "cat 0</dev/null",
      "cd /private/tmp/saffron-workspace/..2>/dev/null",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy })).toEqual({ block: false });
    }
    for (const command of ["cat /dev/zero", "cat /dev/null/child", "cat /etc/passwd"]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy }))
        .toMatchObject({ block: true, code: "bash_absolute_path" });
    }
  });

  test("rewrites native temp paths to a stable workspace-local directory", () => {
    const root = mkdtempSync(join(tmpdir(), "acm-integrity-temp-rewrite-"));
    const workspace = join(root, "workspace");
    const otherWorkspace = join(root, "other-workspace");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(otherWorkspace);
    const command = "for i in 1 2; do npm test >/tmp/saffron-test-$i.log; done; cat /private/tmp/saffron-test-$i.log";
    try {
      const rewritten = rewriteWorkspaceTempPaths(command, workspace);
      const workspaceTemp = join(workspace, ".git", "acm-eval-tmp");
      expect(workspaceTempDirectory(workspace)).toBe(workspaceTemp);
      expect(rewritten).toBe(`for i in 1 2; do npm test >${workspaceTemp}/saffron-test-$i.log; done; cat ${workspaceTemp}/saffron-test-$i.log`);
      expect(rewriteWorkspaceTempPaths(command, workspace)).toBe(rewritten);
      expect(workspaceTempDirectory(otherWorkspace)).toBe(join(otherWorkspace, ".acm-eval-tmp"));
      expect(rewriteWorkspaceTempPaths("echo https://example.com/tmp/file /tmpfoo", workspace))
        .toBe("echo https://example.com/tmp/file /tmpfoo");
      expect(rewriteWorkspaceTempPaths(`cd ${policy.workspace} && find .`, policy.workspace))
        .toBe(`cd ${policy.workspace} && find .`);
      expect(rewriteWorkspaceTempPaths("cat <<'EOF'\n/tmp/prose\nEOF\nprintf %s /tmp/live", workspace))
        .toBe(`cat <<'EOF'\n/tmp/prose\nEOF\nprintf %s ${workspaceTemp}/live`);
      expect(rewriteWorkspaceTempPaths("cat <<EOF\n/tmp/prose\nEOF", workspace))
        .toBe("cat <<EOF\n/tmp/prose\nEOF");
      expect(rewriteWorkspaceTempPaths("curl https://example.com?path=/tmp/foo#fragment=/tmp/bar", workspace))
        .toBe("curl https://example.com?path=/tmp/foo#fragment=/tmp/bar");
      expect(rewriteWorkspaceTempPaths("curl HTTPS://example.com?path=/tmp/foo", workspace))
        .toBe("curl HTTPS://example.com?path=/tmp/foo");
      expect(rewriteWorkspaceTempPaths("curl Http://example.com?path=/tmp/foo", workspace))
        .toBe("curl Http://example.com?path=/tmp/foo");
      expect(rewriteWorkspaceTempPaths("curl https://example.com/a\\;b/path=/tmp/foo", workspace))
        .toBe("curl https://example.com/a\\;b/path=/tmp/foo");
      expect(rewriteWorkspaceTempPaths("curl https://example.com/a\\|b\\(c\\)\\<d\\>/path=/tmp/foo", workspace))
        .toBe("curl https://example.com/a\\|b\\(c\\)\\<d\\>/path=/tmp/foo");
      expect(rewriteWorkspaceTempPaths("curl https://x; cat /tmp/live", workspace))
        .toBe(`curl https://x; cat ${workspaceTemp}/live`);
      expect(rewriteWorkspaceTempPaths("curl 'https://example.com?path=/tmp/foo'", workspace))
        .toBe("curl 'https://example.com?path=/tmp/foo'");
      expect(rewriteWorkspaceTempPaths("curl file:///tmp/live", workspace)).toBe("curl file:///tmp/live");
      expect(evaluateToolCall({
        toolName: "bash",
        input: { command: "cat <<EOF\n$(cat /etc/passwd)\nEOF" },
        workspace,
        approvedSkillRoots: [],
      })).toMatchObject({ block: true, code: "bash_absolute_path" });
      expect(evaluateToolCall({ toolName: "bash", input: { command: rewritten }, workspace, approvedSkillRoots: [] }))
        .toEqual({ block: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks parent, HOME, and eval-run escapes separated from an allowed workspace", () => {
    for (const [command, code] of [
      ["cd /private/tmp/saffron-workspace/..; pwd", "bash_parent_escape"],
      ["cd /private/tmp/saffron-workspace/..&&pwd", "bash_parent_escape"],
      ["cd /private/tmp/saffron-workspace && cd ~; pwd", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && find eval/.runs; true", "bash_eval_run_discovery"],
      ["cd /private/tmp/saffron-workspace/../..; pwd", "bash_parent_escape"],
      ["cd /private/tmp/saffron-workspace && cd ~&&pwd", "bash_home_or_pi_discovery"],
      ["find /private/tmp/saffron-workspace/.pi)", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && find eval/.runs)", "bash_eval_run_discovery"],
      ["cd /private/tmp/saffron-workspace/..>x", "bash_parent_escape"],
      ["cd /private/tmp/saffron-workspace/..)", "bash_parent_escape"],
      ["cd /private/tmp/saffron-workspace && cd ~korenkrita; pwd", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && cd ~+; pwd", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && cd ~-; pwd", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && find eval/.runs>x", "bash_eval_run_discovery"],
      ["cd /private/tmp/saffron-workspace && cd ~user/path", "bash_home_or_pi_discovery"],
      ["cd /private/tmp/saffron-workspace && x=foo:/etc; cd ${x#*:}", "bash_absolute_path"],
      ["cd /private/tmp/saffron-workspace && x=:~korenkrita; cd ${x#:}", "bash_home_or_pi_discovery"],
      ["cat '/etc/passwd'", "bash_absolute_path"],
      [`cd "${policy.workspace}/.."`, "bash_parent_escape"],
      ["cd '~korenkrita'", "bash_home_or_pi_discovery"],
      ["find 'eval/.runs'", "bash_eval_run_discovery"],
      ["cat >/etc/out <<'EOF'\nControl / Policy\nEOF", "bash_absolute_path"],
      ["cat <<EOF\n$(cat /etc/passwd)\nEOF", "bash_absolute_path"],
      [[
        "cat <<ONE <<'TWO'",
        "$(cat /etc/passwd)",
        "ONE",
        "Control / Policy",
        "TWO",
      ].join("\n"), "bash_absolute_path"],
      [[
        "cat <<'ONE' <<TWO",
        "Control / Policy",
        "ONE",
        "$(cat /etc/passwd)",
        "TWO",
      ].join("\n"), "bash_absolute_path"],
      ["printf '%s\\n' \"literal <<'EOF'\"\ncat /etc/passwd", "bash_absolute_path"],
    ]) {
      expect(evaluateToolCall({
        toolName: "bash",
        input: { command },
        ...policy,
      })).toMatchObject({ block: true, code });
    }
  });

  test("allows explicit non-sensitive environment-key reads", () => {
    for (const command of [
      "node -e 'const QUERIED_AT=process.env.QUERIED_AT; console.log(QUERIED_AT)'",
      "node -e 'console.log(process.env[\"FOO\"])'",
      "python -c 'print(os.environ[\"FOO\"]); print(os.environ.get(\"FOO\"))'",
      "python -c 'print(getenv(\"FOO\"))'",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy })).toEqual({ block: false });
    }
  });

  test("blocks sensitive environment locator keys and their filesystem use", () => {
    for (const command of [
      "node -e 'console.log(process.env.HOME)'",
      "node -e 'console.log(process.env?.PI_CODING_AGENT_DIR)'",
      "node -e 'console.log(process.env[\"CODEX_HOME\"])'",
      "node -e 'console.log(process.env?.[\"ACM_INTEGRITY_AUDIT_PATH\"])'",
      "python -c 'print(os.environ[\"HOME\"])'",
      "python -c 'print(os.environ.get(\"PI_CODING_AGENT_DIR\"))'",
      "deno eval 'console.log(Deno.env.get(\"CODEX_HOME\"))'",
      "python -c 'print(getenv(\"HOME\")); print(os.getenv(\"ACM_INTEGRITY_AUDIT_PATH\"))'",
      "node -e 'const fs=require(\"node:fs\"); fs.readFileSync(require(\"node:path\").join(process.env.HOME, \".pi\", \"config\"))'",
      "python -c 'from pathlib import Path; open(Path(os.environ[\"HOME\"]) / \".pi\" / \"config\")'",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy }))
        .toMatchObject({ block: true, code: "bash_process_or_env_discovery" });
    }
  });

  test("blocks whole-environment enumeration", () => {
    for (const command of [
      "node -e 'console.log(process.env)'",
      "node -e 'Object.keys(process.env)'",
      "python -c 'print(dict(os.environ))'",
      "python -c 'for key in os.environ: print(key)'",
    ]) {
      expect(evaluateToolCall({ toolName: "bash", input: { command }, ...policy }))
        .toMatchObject({ block: true, code: "bash_process_or_env_discovery" });
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
    expect(evaluateToolCall({ toolName: "bash", input: { command: "echo foo~bar" }, ...policy })).toEqual({ block: false });
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

test("extension rewrites native temp paths in the bash execution input", async () => {
  const root = mkdtempSync(join(tmpdir(), "acm-integrity-temp-handler-"));
  const workspace = join(root, "workspace");
  const auditPath = join(root, "audit", "integrity.jsonl");
  const handlers = new Map();
  mkdirSync(join(workspace, ".git"), { recursive: true });
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
  process.env.ACM_INTEGRITY_APPROVED_SKILL_ROOTS = JSON.stringify([]);
  process.env.ACM_INTEGRITY_REQUIRED_MARKERS = JSON.stringify([]);
  process.env.ACM_INTEGRITY_WORKSPACE = workspace;
  const tempDirectory = join(workspace, ".git", "acm-eval-tmp");
  try {
    integrityGuard(pi);
    const event = {
      toolName: "bash",
      toolCallId: "temp-call-1",
      input: { command: "for i in 1 2; do npm test >/tmp/saffron-test-$i.log; done; cat /private/tmp/saffron-test-$i.log" },
    };
    expect(await handlers.get("tool_call")(event, {})).toBeUndefined();
    expect(event.input.command).toBe(`for i in 1 2; do npm test >${tempDirectory}/saffron-test-$i.log; done; cat ${tempDirectory}/saffron-test-$i.log`);
    expect(existsSync(tempDirectory)).toBe(true);

    const nextEvent = { toolName: "bash", toolCallId: "temp-call-2", input: { command: "cat /tmp/next.log" } };
    expect(await handlers.get("tool_call")(nextEvent, {})).toBeUndefined();
    expect(nextEvent.input.command).toBe(`cat ${tempDirectory}/next.log`);
    const records = readIntegrityAudit(auditPath);
    expect(records.map((record) => record.type)).toEqual(["extension_loaded", "bash_temp_rewritten", "bash_temp_rewritten"]);
    expect(readFileSync(auditPath, "utf8")).not.toContain("/tmp/");
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
