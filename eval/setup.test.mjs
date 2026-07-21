import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFullEnvCheckoutExtensions,
  buildFullEnvAgentDir,
  forbiddenFullEnvPackageIdentity,
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
