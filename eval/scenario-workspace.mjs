import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a scenario's model-visible workspace independently of its persisted
 * report, session, and event artifacts. Deliberately retain this directory so
 * result evidence remains inspectable after the runner exits.
 *
 * @param {{ scenarioId: string, environmentMode: string }} options
 * @returns {string}
 */
export function createScenarioWorkspace({ scenarioId, environmentMode }) {
  return mkdtempSync(join(tmpdir(), `acm-${environmentMode}-${scenarioId}-`));
}
