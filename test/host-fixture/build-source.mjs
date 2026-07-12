#!/usr/bin/env bun
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = join(fixtureRoot, ".acm-build");
const hostPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];
const fixturePackage = JSON.parse(readFileSync(join(fixtureRoot, "package.json"), "utf8"));
const declaredVersions = hostPackages.map((name) => fixturePackage.dependencies?.[name]);
if (declaredVersions.some((version) => typeof version !== "string" || version.length === 0)) {
  throw new Error("Fixture package must declare every supported host package as an exact dependency");
}
const supportedVersion = declaredVersions[0];
if (!declaredVersions.every((version) => version === supportedVersion)) {
  throw new Error(`Fixture host package versions disagree: ${declaredVersions.join(", ")}`);
}
const entrypoints = [
  { source: "../../src/index.ts", output: "index.js" },
  { source: "../../src/live-agent-session-adapter.ts", output: "live-agent-session-adapter.js" },
];
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
const build = await Bun.build({
  entrypoints: entrypoints.map((entry) => join(fixtureRoot, entry.source)),
  outdir: outputRoot,
  naming: { entry: "[name].js" },
  target: "bun",
  format: "esm",
  packages: "external",
});
if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
const fixtureModules = join(fixtureRoot, "node_modules") + sep;
const resolvedPackages = hostPackages.map((packageName) => {
  const packageJsonPath = join(fixtureRoot, "node_modules", ...packageName.split("/"), "package.json");
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!packageJsonPath.startsWith(fixtureModules)) throw new Error(`${packageName} resolved outside fixture node_modules: ${packageJsonPath}`);
  if (metadata.version !== supportedVersion) throw new Error(`${packageName} resolved ${metadata.version} instead of ${supportedVersion}`);
  return { packageName, relativePackageJsonPath: relative(fixtureRoot, packageJsonPath), version: metadata.version };
});
writeFileSync(join(outputRoot, "host-packages.json"), `${JSON.stringify({ supportedVersion, entrypoints, resolvedPackages }, null, 2)}\n`);
