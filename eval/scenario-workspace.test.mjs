import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createFlowWorkspace, createScenarioWorkspace } from "./scenario-workspace.mjs";

const temporaryPaths = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function pathIsInside(parent, child) {
  const segment = relative(parent, child);
  return segment === "" || (!segment.startsWith("..") && !segment.includes("../"));
}

describe("scenario evaluation workspace", () => {
  test("keeps every isolated environment workspace outside its run directory", () => {
    const runDir = mkdtempSync(join(tmpdir(), "acm-eval-run-"));
    temporaryPaths.push(runDir);

    for (const environmentMode of ["raw-control", "full-env", "core-only", "product-isolated"]) {
      const workspace = createScenarioWorkspace({
        scenarioId: `workspace-${environmentMode}`,
        environmentMode,
      });
      temporaryPaths.push(workspace);

      expect(existsSync(workspace)).toBe(true);
      expect(pathIsInside(runDir, workspace)).toBe(false);
      expect(pathIsInside(tmpdir(), workspace)).toBe(true);
    }
  });

  test("keeps every long-flow workspace outside its run directory", () => {
    const runDir = mkdtempSync(join(tmpdir(), "acm-flow-run-"));
    temporaryPaths.push(runDir);

    for (const environmentMode of ["raw-control", "full-env", "core-only", "product-isolated"]) {
      const workspace = createFlowWorkspace({
        flowId: `long-flow-${environmentMode}`,
        environmentMode,
      });
      temporaryPaths.push(workspace);

      expect(existsSync(workspace)).toBe(true);
      expect(pathIsInside(runDir, workspace)).toBe(false);
      expect(pathIsInside(tmpdir(), workspace)).toBe(true);
    }
  });

  test("places agents-only workspaces under a dedicated lock-protected root", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "acm-agents-only-root-"));
    temporaryPaths.push(rootDir);
    const workspace = createFlowWorkspace({
      flowId: "agents-only-formal",
      environmentMode: "agents-only",
      rootDir,
    });
    temporaryPaths.push(workspace);
    expect(existsSync(workspace)).toBe(true);
    expect(pathIsInside(rootDir, workspace)).toBe(true);
  });
});
