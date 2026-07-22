import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFullEnvCheckoutExtensions,
  assertAgentsOnlyCheckoutResources,
  buildAgentsOnlyAgentDir,
  buildFullEnvAgentDir,
  forbiddenFullEnvPackageIdentity,
  readAgentsOnlyHarnessAudit,
  readFullEnvHarnessAudit,
  sanitizeFullEnvSettings,
} from "./setup.mjs";

describe("full-env package sanitization", () => {
  test("accepts only the canonical checkout core and context extension realpaths", () => {
    const canonical = {
      environmentMode: "full-env",
      coreExtensionPath: "/checkout/src/index.ts",
      contextExtensionPath: "/checkout/src/context.ts",
      expectedCoreExtensionPath: "/checkout/src/index.ts",
      expectedContextExtensionPath: "/checkout/src/context.ts",
      realpath: (path) => path,
    };
    expect(assertFullEnvCheckoutExtensions(canonical)).toMatchObject({ valid: true });
    expect(() => assertFullEnvCheckoutExtensions({ ...canonical, coreExtensionPath: "/hybrid/src/index.ts" }))
      .toThrow("full-env core extension");
    expect(() => assertFullEnvCheckoutExtensions({ ...canonical, contextExtensionPath: "/hybrid/src/context.ts" }))
      .toThrow("full-env context extension");
  });

  test("removes only installed pi-context and exact session-recall identities", () => {
    const settings = {
      enabledModels: ["ignored"],
      packages: [
        "git:github.com/KorenKrita/pi-context",
        "npm:@ogulcancelik/pi-session-recall@1.0.6",
        { source: "npm:@ogulcancelik/pi-session-recall" },
        "git:github.com/KorenKrita/skills",
        "npm:pi-contextual-notes",
      ],
    };
    const sanitized = sanitizeFullEnvSettings(settings);

    expect(sanitized.settings.packages).toEqual([
      "git:github.com/KorenKrita/skills",
      "npm:pi-contextual-notes",
    ]);
    expect(sanitized.removedPackages).toEqual([
      { source: "git:github.com/KorenKrita/pi-context", identity: "github.com/korenkrita/pi-context" },
      { source: "npm:@ogulcancelik/pi-session-recall@1.0.6", identity: "npm:@ogulcancelik/pi-session-recall" },
      { source: "npm:@ogulcancelik/pi-session-recall", identity: "npm:@ogulcancelik/pi-session-recall" },
    ]);
    expect(settings.packages).toHaveLength(5);
  });

  test("recognizes the installed git and npm source spellings without broad substring filtering", () => {
    expect(forbiddenFullEnvPackageIdentity("https://github.com/KorenKrita/pi-context.git#main"))
      .toBe("github.com/korenkrita/pi-context");
    expect(forbiddenFullEnvPackageIdentity("npm:@ogulcancelik/pi-session-recall@1.0.6"))
      .toBe("npm:@ogulcancelik/pi-session-recall");
    expect(forbiddenFullEnvPackageIdentity("npm:pi-contextual-notes")).toBeNull();
  });

  test("does not copy session-recall configuration and writes an auditable full-env manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-full-env-"));
    const source = join(root, "source-agent");
    const harness = join(root, "harness");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "settings.json"), JSON.stringify({
      packages: [
        "git:github.com/KorenKrita/pi-context",
        "npm:@ogulcancelik/pi-session-recall",
        "git:github.com/KorenKrita/skills",
      ],
      enabledModels: ["fixture"],
    }));
    writeFileSync(join(source, "models.json"), JSON.stringify({ providers: {} }));
    writeFileSync(join(source, "AGENTS.md"), "global instructions\n");
    writeFileSync(join(source, "session-recall.json"), "{\"queryModel\":{}}\n");
    writeFileSync(join(source, "command-blacklist.json"), "{\"commands\":[\"tree\"]}\n");
    writeFileSync(join(source, "pistatusline.json"), "{\"enabled\":true}\n");
    writeFileSync(join(source, "pi-autoname.json"), "{\"enabled\":true}\n");
    writeFileSync(join(source, "mcp-cache.json"), "{\"secret\":true}\n");
    mkdirSync(join(harness, "fixture"), { recursive: true });
    writeFileSync(join(harness, "fixture", "session-recall.json"), "stale\n");

    try {
      const agentDir = buildFullEnvAgentDir({
        contextWindow: 400000,
        maxTokensCap: 16000,
        label: "fixture",
        sourceAgentDir: source,
        harnessDir: harness,
      });
      const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      const audit = readFullEnvHarnessAudit(agentDir);

      expect(settings.packages).toEqual(["git:github.com/KorenKrita/skills"]);
      expect(settings.enabledModels).toBeUndefined();
      expect(existsSync(join(agentDir, "session-recall.json"))).toBe(false);
      expect(audit.excludedFiles).toEqual(expect.arrayContaining(["mcp.json", "session-recall.json"]));
      expect(audit.purgedFiles).toEqual(["session-recall.json"]);
      expect(audit.settings.removedPackages.map((entry) => entry.identity)).toEqual([
        "github.com/korenkrita/pi-context",
        "npm:@ogulcancelik/pi-session-recall",
      ]);
      expect(audit.globalAgents.source.sha256).toBe(audit.globalAgents.harness.sha256);
      expect(audit.rootConfigs.map((entry) => entry.name)).toEqual([
        "command-blacklist.json",
        "pi-autoname.json",
        "pistatusline.json",
      ]);
      for (const config of audit.rootConfigs) {
        expect(config.source.sha256).toBe(config.harness.sha256);
      }
      expect(existsSync(join(agentDir, "mcp-cache.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agents-only checkout resources", () => {
  test("accepts only the canonical checkout extensions and Skill", () => {
    const canonical = {
      environmentMode: "agents-only",
      coreExtensionPath: "/checkout/src/index.ts",
      contextExtensionPath: "/checkout/src/context.ts",
      skillPath: "/checkout/skills/context-management/SKILL.md",
      expectedCoreExtensionPath: "/checkout/src/index.ts",
      expectedContextExtensionPath: "/checkout/src/context.ts",
      expectedSkillPath: "/checkout/skills/context-management/SKILL.md",
      realpath: (path) => path,
    };
    expect(assertAgentsOnlyCheckoutResources(canonical)).toMatchObject({ valid: true, status: "canonical_checkout_resources" });
    expect(() => assertAgentsOnlyCheckoutResources({ ...canonical, coreExtensionPath: "/other/src/index.ts" }))
      .toThrow("agents-only core extension");
    expect(() => assertAgentsOnlyCheckoutResources({ ...canonical, contextExtensionPath: "/other/src/context.ts" }))
      .toThrow("agents-only context extension");
    expect(() => assertAgentsOnlyCheckoutResources({ ...canonical, skillPath: "/other/SKILL.md" }))
      .toThrow("agents-only Skill");
  });
});

describe("agents-only harness", () => {
  test("copies only models, auth, and the global AGENTS.md while excluding all ambient resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-agents-only-"));
    const source = join(root, "source-agent");
    const harness = join(root, "harness");
    mkdirSync(join(source, "extensions"), { recursive: true });
    mkdirSync(join(source, "skills", "ambient-skill"), { recursive: true });
    writeFileSync(join(source, "models.json"), JSON.stringify({ providers: { fixture: { models: [{ id: "fixture", contextWindow: 1_000_000, maxTokens: 64_000 }] } } }));
    writeFileSync(join(source, "auth.json"), "{\"fixture\":true}\n");
    writeFileSync(join(source, "AGENTS.md"), "# Global fixture instructions\n");
    writeFileSync(join(source, "settings.json"), JSON.stringify({ packages: ["npm:@ogulcancelik/pi-session-recall"] }));
    writeFileSync(join(source, "extensions", "ambient.ts"), "export {};\n");
    writeFileSync(join(source, "skills", "ambient-skill", "SKILL.md"), "# Ambient\n");
    writeFileSync(join(source, "session-recall.json"), "{}\n");
    writeFileSync(join(source, "pi.env"), "SHOULD_NOT_COPY=true\n");
    mkdirSync(join(harness, "fixture", "extensions"), { recursive: true });
    writeFileSync(join(harness, "fixture", "extensions", "stale.ts"), "export {};\n");

    try {
      const agentDir = buildAgentsOnlyAgentDir({
        contextWindow: 400_000,
        maxTokensCap: 16_000,
        label: "fixture",
        sourceAgentDir: source,
        harnessDir: harness,
      });
      const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
      const audit = readAgentsOnlyHarnessAudit(agentDir);

      expect(audit.environmentMode).toBe("agents-only");
      expect(audit.globalAgents.source.sha256).toBe(audit.globalAgents.harness.sha256);
      expect(audit.globalAgents.harness.exists).toBe(true);
      expect(audit.auth.source.sha256).toBe(audit.auth.harness.sha256);
      expect(audit.settings.packages).toEqual([]);
      expect(audit.sessionRecall).toEqual({ packagePresent: false, configPresent: false });
      expect(settings.packages).toEqual([]);
      expect(models.providers.fixture.models[0]).toMatchObject({ contextWindow: 400_000, maxTokens: 16_000 });
      for (const absent of ["extensions", "skills", "themes", "agents", "git", "npm", "bin", "mcp.json", "mcp-cache.json", "session-recall.json", "pi.env"]) {
        expect(existsSync(join(agentDir, absent))).toBe(false);
      }
      expect(audit.excludedAmbientResources).toEqual(expect.arrayContaining(["extensions", "skills", "session-recall.json"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
