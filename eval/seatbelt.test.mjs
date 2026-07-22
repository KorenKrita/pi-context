import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { buildEvaluationSeatbeltProfiles, classifySeatbeltSupport, writeEvaluationSeatbeltProfiles } from "./seatbelt.mjs";

test("formal agents-only evidence is kernel-enforced only on Darwin", () => {
  expect(classifySeatbeltSupport({ agentsOnly: true, platform: "darwin", executableExists: true, profilesExist: true }))
    .toEqual({ required: true, supported: true, enabled: true, enforcement: "kernel_enforced", formalEvidenceEligible: true, failureStatus: null });
  expect(classifySeatbeltSupport({ agentsOnly: true, platform: "linux", executableExists: false, profilesExist: false }))
    .toEqual({ required: true, supported: false, enabled: false, enforcement: "unsupported", formalEvidenceEligible: false, failureStatus: "agents_only_sandbox_unsupported" });
});

test("profile denies existing sibling workspaces, sibling runs, private state, and canonical aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "acm-seatbelt-profile-"));
  const tempRoot = join(root, "temp");
  const workspaceTarget = join(tempRoot, "current-target");
  const workspace = join(tempRoot, "acm-current");
  const priorTarget = join(tempRoot, "prior-target");
  const priorAlias = join(tempRoot, "acm-prior");
  const runsRoot = join(root, "runs");
  const runDir = join(runsRoot, "current-run");
  const priorRun = join(runsRoot, "prior-run");
  const harnessRoot = join(root, "harness");
  const agentDir = join(harnessRoot, "current-agent");
  const siblingAgentDir = join(harnessRoot, "sibling-agent");
  const homeDir = join(root, "home");
  const evalRoot = join(root, "eval");
  const privateEvalRoot = join(homeDir, ".codex", "private", "pi-context-eval");
  for (const path of [workspaceTarget, priorTarget, runDir, priorRun, agentDir, siblingAgentDir, join(homeDir, ".pi"), join(homeDir, ".codex", "sessions"), join(homeDir, ".codex", "archived_sessions"), join(homeDir, ".codex", "memories"), privateEvalRoot, join(evalRoot, "fixtures")]) {
    mkdirSync(path, { recursive: true });
  }
  symlinkSync(workspaceTarget, workspace, "dir");
  symlinkSync(priorTarget, priorAlias, "dir");
  try {
    const result = buildEvaluationSeatbeltProfiles({ workspace, runDir, agentDir, harnessRoot, runsRoot, tempRoot, homeDir, evalRoot, privateEvalRoot });
    const denied = new Set(result.outer.deniedRoots.map((entry) => entry.path));
    expect(denied.has(tempRoot)).toBe(true);
    expect(denied.has(realpathSync(tempRoot))).toBe(true);
    expect(denied.has(workspace)).toBe(false);
    expect(denied.has(realpathSync(workspace))).toBe(false);
    expect(denied.has(runsRoot)).toBe(true);
    expect(denied.has(runDir)).toBe(false);
    expect(denied.has(harnessRoot)).toBe(true);
    expect(denied.has(agentDir)).toBe(false);
    expect(denied.has(join(homeDir, ".pi"))).toBe(true);
    expect(denied.has("/private/etc/passwd")).toBe(true);
    expect(denied.has("/etc/passwd")).toBe(true);
    expect(denied.has(privateEvalRoot)).toBe(true);
    expect(denied.has(join(evalRoot, "fixtures"))).toBe(true);
    expect(result.outer.deniedRoots.find((entry) => entry.path === privateEvalRoot)?.source).toBe("private_eval_root");
    expect(result.outer.deniedRoots.find((entry) => entry.path === join(evalRoot, "fixtures"))?.source).toBe("task_fixture_source");
    expect(result.outer.currentRoots).toEqual(expect.arrayContaining([workspace, realpathSync(workspace), runDir, agentDir]));
    expect(result.tool.deniedRoots.some((entry) => entry.path === harnessRoot)).toBe(true);
    expect(result.tool.deniedRoots.some((entry) => entry.path === runsRoot)).toBe(true);
    expect(result.outer.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.tool.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(result.outer.profile)).toBeLessThan(65_535);
    expect(Buffer.byteLength(result.tool.profile)).toBeLessThan(65_535);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile generation rejects control characters before emitting SBPL", () => {
  expect(() => buildEvaluationSeatbeltProfiles({
    workspace: "/tmp/acm-current\n(allow default)",
    runDir: "/tmp/runs/current",
    agentDir: "/tmp/harness/current",
    homeDir: "/tmp/home",
    evalRoot: "/tmp/eval",
  })).toThrow("control characters");
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

darwinTest("kernel sandbox blocks dynamic and alias reads while allowing the current workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "acm-seatbelt-kernel-"));
  const workspace = join(root, "acm-current");
  const prior = join(root, "acm-prior");
  const runDir = join(root, "runs", "current");
  const harnessRoot = join(root, "harness");
  const agentDir = join(harnessRoot, "current-agent");
  const siblingAgentDir = join(harnessRoot, "sibling-agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(prior, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(siblingAgentDir, { recursive: true });
  writeFileSync(join(workspace, "allowed.txt"), "allowed\n");
  writeFileSync(join(prior, "secret.txt"), "secret\n");
  writeFileSync(join(agentDir, "auth.json"), "current-auth\n");
  writeFileSync(join(siblingAgentDir, "auth.json"), "sibling-auth\n");
  try {
    const evidence = writeEvaluationSeatbeltProfiles({ workspace, runDir, agentDir, harnessRoot, runsRoot: join(root, "runs"), tempRoot: root, homeDir: join(root, "home"), evalRoot: join(root, "eval"), privateEvalRoot: join(root, "home", ".codex", "private", "pi-context-eval") });
    const allowed = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, "/bin/cat", join(workspace, "allowed.txt")], { encoding: "utf8" });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe("allowed\n");

    const escapedPrior = prior.replaceAll("/", "\\/");
    const regexScript = `const fs=require('node:fs');const p=/${escapedPrior}\\/secret.txt/.source.replaceAll('\\\\/','/');fs.readFileSync(p)`;
    const nodeBinary = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
    const dynamic = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, nodeBinary, "-e", regexScript], { encoding: "utf8" });
    expect(dynamic.status).not.toBe(0);
    expect(`${dynamic.stdout}${dynamic.stderr}`).toMatch(/Operation not permitted|EPERM/);

    const aliasPrior = prior.startsWith("/private/var/") ? prior.replace(/^\/private/, "") : prior;
    const parameter = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, "/bin/zsh", "-c", `p=\${x:-${aliasPrior}}; cat "$p/secret.txt"`], { encoding: "utf8" });
    expect(parameter.status).not.toBe(0);
    expect(`${parameter.stdout}${parameter.stderr}`).toMatch(/Operation not permitted|deny|not permitted/i);

    const currentAuth = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, "/bin/cat", join(agentDir, "auth.json")], { encoding: "utf8" });
    expect(currentAuth.status).toBe(0);
    const siblingAuth = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, "/bin/cat", join(siblingAgentDir, "auth.json")], { encoding: "utf8" });
    expect(siblingAuth.status).not.toBe(0);
    const accountAlias = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, "/bin/cat", "/etc/passwd"], { encoding: "utf8" });
    expect(accountAlias.status).not.toBe(0);

    const toolEnvScript = "const fs=require('node:fs');fs.readFileSync(process.env.PI_CODING_AGENT_DIR + '/auth.json')";
    const toolCurrentAuth = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.tool.path, nodeBinary, "-e", toolEnvScript], {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    expect(toolCurrentAuth.status).not.toBe(0);
    expect(`${toolCurrentAuth.stdout}${toolCurrentAuth.stderr}`).toMatch(/Operation not permitted|EPERM/);
    const toolSiblingAuth = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.tool.path, nodeBinary, "-e", toolEnvScript], {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: siblingAgentDir },
    });
    expect(toolSiblingAuth.status).not.toBe(0);
    expect(`${toolSiblingAuth.stdout}${toolSiblingAuth.stderr}`).toMatch(/Operation not permitted|EPERM/);
    const toolWorkspace = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.tool.path, "/bin/cat", join(workspace, "allowed.txt")], { encoding: "utf8" });
    expect(toolWorkspace.status).toBe(0);
    const hostWorkspaceScript = `const fs=require('node:fs');const p=${JSON.stringify(join(workspace, "allowed.txt"))};fs.realpathSync(p);fs.writeFileSync(${JSON.stringify(join(workspace, "written.txt"))},'written\\n')`;
    const hostWorkspace = spawnSync("/usr/bin/sandbox-exec", ["-f", evidence.outer.path, nodeBinary, "-e", hostWorkspaceScript], { encoding: "utf8" });
    expect(hostWorkspace.status).toBe(0);
    expect(readFileSync(join(workspace, "written.txt"), "utf8")).toBe("written\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
