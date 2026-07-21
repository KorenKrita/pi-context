// Declarative, resumable aggregation primitives for live ACM evaluation.
//
// This module deliberately contains no model invocation. `run-matrix.mjs`
// owns process orchestration while these functions stay deterministic and
// directly unit-testable.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ENVIRONMENT_MODES } from "./driver.mjs";

export const MATRIX_SCHEMA_VERSION = 1;

const TERMINAL_ERROR_PREFIX = "assistant turn failed:";

function asNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asPositiveInteger(value, label, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function normalizedModel(model, label) {
  if (typeof model === "string") return asNonEmptyString(model, `${label}.model`);
  if (model && typeof model === "object") {
    const provider = asNonEmptyString(model.provider, `${label}.model.provider`);
    const id = asNonEmptyString(model.id ?? model.modelId, `${label}.model.id`);
    return `${provider}/${id}`;
  }
  throw new Error(`${label}.model must be provider/model or { provider, id }`);
}

function safeKey(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Validate a serializable matrix declaration and return a canonical copy.
 * A cell is intentionally explicit: all variable axes used to compare runs
 * become part of its stored provenance instead of ambient CLI state.
 */
export function validateMatrixManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("matrix manifest must be an object");
  }
  const id = asNonEmptyString(input.id, "matrix.id");
  if (!Array.isArray(input.cells) || input.cells.length === 0) {
    throw new Error("matrix.cells must be a non-empty array");
  }
  const seen = new Set();
  const cells = input.cells.map((rawCell, index) => {
    const label = `matrix.cells[${index}]`;
    if (!rawCell || typeof rawCell !== "object" || Array.isArray(rawCell)) {
      throw new Error(`${label} must be an object`);
    }
    const cellId = asNonEmptyString(rawCell.id, `${label}.id`);
    if (seen.has(cellId)) throw new Error(`matrix cell id must be unique: ${cellId}`);
    seen.add(cellId);
    const environment = asNonEmptyString(rawCell.environment ?? rawCell.environmentMode, `${label}.environment`);
    if (!ENVIRONMENT_MODES.includes(environment)) {
      throw new Error(`${label}.environment must be one of ${ENVIRONMENT_MODES.join(", ")}`);
    }
    if (!Array.isArray(rawCell.scenarios) || rawCell.scenarios.length === 0) {
      throw new Error(`${label}.scenarios must be a non-empty array`);
    }
    const scenarios = rawCell.scenarios.map((scenario, scenarioIndex) =>
      asNonEmptyString(scenario, `${label}.scenarios[${scenarioIndex}]`),
    );
    const uniqueScenarios = new Set(scenarios);
    if (uniqueScenarios.size !== scenarios.length) {
      throw new Error(`${label}.scenarios must not contain duplicates`);
    }
    const cell = {
      id: cellId,
      model: normalizedModel(rawCell.model, label),
      thinking: asNonEmptyString(rawCell.thinking ?? "off", `${label}.thinking`),
      environment,
      scenarios,
      repeats: asPositiveInteger(rawCell.repeats, `${label}.repeats`, 1),
    };
    if (rawCell.experimentalVariable !== undefined) {
      cell.experimentalVariable = asNonEmptyString(rawCell.experimentalVariable, `${label}.experimentalVariable`);
    }
    if (rawCell.contextWindow !== undefined) {
      cell.contextWindow = asPositiveInteger(rawCell.contextWindow, `${label}.contextWindow`);
    }
    if (rawCell.note !== undefined) cell.note = asNonEmptyString(rawCell.note, `${label}.note`);
    return cell;
  });
  return { schemaVersion: MATRIX_SCHEMA_VERSION, id, cells };
}

/** Expand cells into one live runner invocation each: scenario × repeat. */
export function expandMatrixManifest(manifest) {
  const valid = validateMatrixManifest(manifest);
  const jobs = [];
  const keys = new Set();
  for (const cell of valid.cells) {
    for (const scenarioId of cell.scenarios) {
      for (let repeat = 1; repeat <= cell.repeats; repeat += 1) {
        const key = `${safeKey(cell.id)}--${safeKey(scenarioId)}--r${String(repeat).padStart(2, "0")}`;
        if (keys.has(key)) {
          throw new Error(`matrix job key collision after filename-safe normalization: ${key}`);
        }
        keys.add(key);
        jobs.push({
          key,
          cellId: cell.id,
          model: cell.model,
          thinking: cell.thinking,
          environment: cell.environment,
          scenarioId,
          repeat,
          ...(cell.contextWindow === undefined ? {} : { contextWindow: cell.contextWindow }),
          ...(cell.experimentalVariable === undefined ? {} : { experimentalVariable: cell.experimentalVariable }),
          ...(cell.note === undefined ? {} : { note: cell.note }),
        });
      }
    }
  }
  return { manifest: valid, jobs };
}

function isTerminalError(error) {
  return typeof error === "string" && error.toLowerCase().startsWith(TERMINAL_ERROR_PREFIX);
}

function runStatusFromResults(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  if (results.some((result) => result?.infrastructureInvalid)) return "infrastructure_invalid";
  if (results.some((result) => isTerminalError(result?.error))) return "terminal_failure";
  if (results.some((result) => typeof result?.error === "string" && result.error.length > 0)) return "provider_failure";
  if (results.length === 0) return "runner_failure";
  return results.every((result) => result?.pass === true) ? "passed" : "scenario_failure";
}

/**
 * Classify a completed child report without conflating task failure, terminal
 * assistant failure, provider/RPC failure, and harness infrastructure failure.
 */
export function classifyRunnerReport(report, child = {}) {
  if (!report || typeof report !== "object") {
    return {
      status: "runner_failure",
      failureClass: "runner",
      detail: child.error ?? "runner produced no readable report",
    };
  }
  const status = runStatusFromResults(report);
  const failureClass = status === "passed"
    ? null
    : status === "scenario_failure"
      ? "scenario"
      : status === "terminal_failure"
        ? "terminal"
        : status === "provider_failure"
          ? "provider"
          : status === "infrastructure_invalid"
            ? "infrastructure"
            : "runner";
  const errors = (report.results ?? [])
    .map((result) => result?.error)
    .filter((error) => typeof error === "string" && error.length > 0);
  return {
    status,
    failureClass,
    detail: errors.join("; ") || (child.exitCode && child.exitCode !== 0 ? `runner exited ${child.exitCode}` : null),
  };
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function toolSequence(result) {
  if (!Array.isArray(result?.toolCalls) || result.toolCalls.length === 0) return "(no tools)";
  return result.toolCalls.map((tool) => tool?.name ?? "(unknown)").join(" → ");
}

/** Aggregate only persisted job records. Safe to invoke while a matrix runs. */
export function aggregateMatrixState(state) {
  const jobs = Object.values(state?.jobs ?? {});
  const summary = {
    total: jobs.length,
    pending: 0,
    running: 0,
    skippedExisting: Array.isArray(state?.lastInvocation?.skippedExistingKeys)
      ? state.lastInvocation.skippedExistingKeys.length
      : 0,
    passed: 0,
    scenarioFailures: 0,
    providerFailures: 0,
    terminalFailures: 0,
    infrastructureInvalid: 0,
    runnerFailures: 0,
  };
  const checks = {};
  const toolSequences = {};
  const skillAvailability = {};
  const byCell = {};
  for (const job of jobs) {
    const cell = byCell[job.cellId] ?? {
      total: 0, passed: 0, scenarioFailures: 0, providerFailures: 0,
      terminalFailures: 0, infrastructureInvalid: 0, runnerFailures: 0,
    };
    byCell[job.cellId] = cell;
    cell.total += 1;
    switch (job.status) {
      case "pending": summary.pending += 1; break;
      case "running": summary.running += 1; break;
      case "passed": summary.passed += 1; cell.passed += 1; break;
      case "scenario_failure": summary.scenarioFailures += 1; cell.scenarioFailures += 1; break;
      case "provider_failure": summary.providerFailures += 1; cell.providerFailures += 1; break;
      case "terminal_failure": summary.terminalFailures += 1; cell.terminalFailures += 1; break;
      case "infrastructure_invalid": summary.infrastructureInvalid += 1; cell.infrastructureInvalid += 1; break;
      case "runner_failure": summary.runnerFailures += 1; cell.runnerFailures += 1; break;
      default: summary.runnerFailures += 1; cell.runnerFailures += 1; break;
    }
    for (const result of job.report?.results ?? []) {
      for (const check of result?.checks ?? []) {
        if (check?.pass === false) bump(checks, check.name ?? "(unnamed check)");
      }
      bump(toolSequences, toolSequence(result));
      const availability = result?.skillAvailability?.status ?? "not_recorded";
      bump(skillAvailability, availability);
    }
  }
  const completed = summary.passed + summary.scenarioFailures + summary.providerFailures + summary.terminalFailures
    + summary.infrastructureInvalid + summary.runnerFailures;
  const validScored = summary.passed + summary.scenarioFailures;
  return {
    ...summary,
    completed,
    passRate: validScored === 0 ? null : summary.passed / validScored,
    byCell,
    failedChecks: checks,
    toolSequences,
    skillAvailability,
  };
}

export function createMatrixState({ matrixSource, manifest, jobs, outputDir, startedAt = new Date().toISOString() }) {
  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    status: "planned",
    matrixSource,
    outputDir,
    startedAt,
    manifest,
    jobs: Object.fromEntries(jobs.map((job) => [job.key, { ...job, status: "pending", attempts: 0 }])),
  };
}

/** Completed reports are durable; failed/in-flight work is eligible for resume. */
export function shouldSkipExisting(record) {
  return record?.status === "passed" || record?.status === "scenario_failure" || record?.status === "infrastructure_invalid";
}

export function compactMatrixReport(state, { generatedAt = new Date().toISOString() } = {}) {
  const aggregate = aggregateMatrixState(state);
  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    matrixId: state.manifest.id,
    matrixSource: state.matrixSource,
    outputDir: state.outputDir,
    piProvenance: state.piProvenance ?? null,
    startedAt: state.startedAt,
    generatedAt,
    status: state.status,
    manifest: state.manifest,
    summary: aggregate,
    jobs: Object.values(state.jobs).map((job) => ({
      key: job.key,
      cellId: job.cellId,
      scenarioId: job.scenarioId,
      repeat: job.repeat,
      model: job.model,
      thinking: job.thinking,
      environment: job.environment,
      experimentalVariable: job.experimentalVariable ?? null,
      status: job.status,
      failureClass: job.failureClass ?? null,
      attempts: job.attempts,
      reportPath: job.reportPath ?? null,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      durationMs: job.durationMs ?? null,
      detail: job.detail ?? null,
      productCommit: job.report?.gitHead ?? null,
      skillAvailability: (job.report?.results ?? []).map((result) => result?.skillAvailability?.status ?? "not_recorded"),
    })),
  };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function markdownRows(object) {
  const rows = Object.entries(object).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows.length === 0 ? "_none_" : rows.map(([key, value]) => `- \`${key}\`: ${value}`).join("\n");
}

export function formatMatrixMarkdown(compact) {
  const summary = compact.summary;
  const lines = [
    `# ACM eval matrix: ${compact.matrixId}`,
    "",
    `- Generated: ${compact.generatedAt}`,
    `- Status: **${compact.status}**`,
    `- Matrix source: \`${compact.matrixSource}\``,
    `- Output: \`${compact.outputDir}\``,
    `- Pi CLI: ${compact.piProvenance?.cliPath ? `\`${compact.piProvenance.cliPath}\`` : "unresolved"}`,
    `- Pi CLI version: ${compact.piProvenance?.version ?? "unresolved"}`,
    `- Project exact-host contract: ${compact.piProvenance?.projectExactHostContract ?? "unresolved"}`,
    "",
    "## Outcome summary",
    "",
    "| Total | Completed | Passed | Valid-score pass rate | Scenario failures | Provider failures | Terminal failures | Infrastructure invalid | Runner failures | Pending |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.total} | ${summary.completed} | ${summary.passed} | ${percent(summary.passRate)} | ${summary.scenarioFailures} | ${summary.providerFailures} | ${summary.terminalFailures} | ${summary.infrastructureInvalid} | ${summary.runnerFailures} | ${summary.pending + summary.running} |`,
    "",
    "## Per cell",
    "",
    "| Cell | Total | Passed | Scenario | Provider | Terminal | Infra | Runner |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.byCell).sort(([a], [b]) => a.localeCompare(b)).map(([cellId, cell]) =>
      `| ${cellId} | ${cell.total} | ${cell.passed} | ${cell.scenarioFailures} | ${cell.providerFailures} | ${cell.terminalFailures} | ${cell.infrastructureInvalid} | ${cell.runnerFailures} |`,
    ),
    "",
    "## Failed checks",
    "",
    markdownRows(summary.failedChecks),
    "",
    "## Tool sequences",
    "",
    markdownRows(summary.toolSequences),
    "",
    "## Skill availability",
    "",
    markdownRows(summary.skillAvailability),
    "",
    "## Runs",
    "",
    "| Job | Cell | Scenario | Repeat | Status | Product commit | Original report |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...compact.jobs.map((job) =>
      `| ${job.key} | ${job.cellId} | ${job.scenarioId} | ${job.repeat} | ${job.status} | ${job.productCommit ?? "—"} | ${job.reportPath ? `\`${job.reportPath}\`` : "—"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** Atomic enough for interrupted local orchestration: readers see old or new JSON. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
