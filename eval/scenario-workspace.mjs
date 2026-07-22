import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createEvaluationWorkspace({ workspaceId, environmentMode, rootDir = tmpdir() }) {
  mkdirSync(rootDir, { recursive: true });
  return mkdtempSync(join(rootDir, `acm-${environmentMode}-${workspaceId}-`));
}

/**
 * Creates a scenario's model-visible workspace independently of its persisted
 * report, session, and event artifacts. Deliberately retain this directory so
 * result evidence remains inspectable after the runner exits.
 *
 * @param {{ scenarioId: string, environmentMode: string, rootDir?: string }} options
 * @returns {string}
 */
export function createScenarioWorkspace({ scenarioId, environmentMode, rootDir }) {
  return createEvaluationWorkspace({ workspaceId: scenarioId, environmentMode, rootDir });
}

/**
 * Creates a long-flow model workspace independently of its persisted report,
 * session, and event artifacts. The caller deliberately retains it as evidence.
 *
 * @param {{ flowId: string, environmentMode: string, rootDir?: string }} options
 * @returns {string}
 */
export function createFlowWorkspace({ flowId, environmentMode, rootDir }) {
  return createEvaluationWorkspace({ workspaceId: flowId, environmentMode, rootDir });
}
