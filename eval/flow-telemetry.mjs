// Deterministic telemetry for real Pi long-flow evaluations.
//
// This module deliberately does not infer why a model did or did not choose an
// ACM action. It derives observable facts from Pi events, the flow report, and
// optional persisted session entries, then labels whether the resulting run is
// complete enough to support the requested 400K/1M comparison.

export const FLOW_TELEMETRY_SCHEMA_VERSION = 1;
export const NUDGE_LEVELS = Object.freeze([30, 50, 70]);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function eventUsage(event) {
  return event?.usage
    ?? event?.message?.usage
    ?? event?.contextUsage
    ?? event?.context?.usage
    ?? event?.details?.contextUsage
    ?? null;
}

/**
 * Recover an active-context token reading without treating completion output as
 * prompt context when Pi exposes the prompt/cache components. Older Pi events
 * only expose totalTokens, for which totalTokens remains an explicit fallback.
 */
export function activeTokensFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  for (const key of ["activeTokens", "contextTokens", "tokens"]) {
    const value = finiteNumber(usage[key]);
    if (value !== null) return value;
  }
  const input = finiteNumber(usage.inputTokens ?? usage.input ?? usage.promptTokens);
  const cache = finiteNumber(usage.cacheReadTokens ?? usage.cacheRead);
  if (input !== null || cache !== null) return (input ?? 0) + (cache ?? 0);
  for (const key of ["totalTokens", "total"]) {
    const value = finiteNumber(usage[key]);
    if (value !== null) return value;
  }
  return null;
}

export function workingBudgetFor(contextWindow) {
  const window = positiveInteger(contextWindow);
  return window === null ? null : Math.min(window, 400_000);
}

function levelFor(percent) {
  if (percent === null) return null;
  for (const level of [...NUDGE_LEVELS].reverse()) {
    if (percent >= level) return level;
  }
  return null;
}

function toolName(event) {
  return event?.toolName ?? event?.name ?? event?.message?.toolName ?? null;
}

function toolCallId(event) {
  return event?.toolCallId ?? event?.id ?? event?.message?.toolCallId ?? null;
}

function toolDetails(event) {
  return event?.result?.details ?? event?.details ?? event?.message?.details ?? null;
}

function nonEmptyDomainError(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function hasDomainError(details) {
  return nonEmptyDomainError(details?.error);
}

function assistantToolNames(event) {
  const message = event?.message;
  if (message?.role !== "assistant" || !Array.isArray(message?.content)) return [];
  return message.content
    .filter((block) => block?.type === "toolCall" && typeof block?.name === "string")
    .map((block) => block.name);
}

function toolResultIsApplied(event) {
  if (event?.isError === true || event?.result?.isError === true) return false;
  const details = toolDetails(event);
  if (hasDomainError(details)) return false;
  return details?.mutationStatus === "applied" || details?.status === "created";
}

function reportTurnPhase(report, index) {
  return report?.turns?.[index]?.phase ?? `turn-${index + 1}`;
}

function splitTurns(events) {
  const turns = [[]];
  for (const event of events) {
    turns.at(-1).push(event);
    if (event?.type === "agent_settled") turns.push([]);
  }
  if (turns.at(-1).length === 0) turns.pop();
  return turns;
}

function parseReminder(event) {
  const message = event?.message ?? event;
  const customType = message?.customType;
  const details = message?.details ?? event?.details ?? {};
  if (customType !== "acm:context-usage-reminder" && details?.kind !== "context-usage-reminder") return null;
  const content = typeof message?.content === "string" ? message.content : "";
  const explicit = finiteNumber(details?.level);
  const captured = content.match(/\b(30|50|70)%\s+tier/i);
  const level = explicit ?? (captured ? Number(captured[1]) : null);
  return {
    level: NUDGE_LEVELS.includes(level) ? level : null,
    tokens: finiteNumber(details?.tokens),
    hardUsagePercent: finiteNumber(details?.usagePercent),
    pressurePercent: finiteNumber(details?.pressurePercent),
    workingBudgetTokens: positiveInteger(details?.workingBudgetTokens),
    source: customType === "acm:context-usage-reminder" ? "custom_message" : "details",
  };
}

function isCompactionBoundary(event) {
  return event?.type === "session_compact" || event?.type === "session_tree";
}

function boundaryKind(event) {
  if (event?.type === "session_compact") return "compaction";
  if (event?.type === "session_tree") return "manual_tree";
  return "successful_travel";
}

function normalizedSessionRecallIntegrity(integrity = {}) {
  const observedTools = [...new Set(integrity.observedTools ?? [])].sort();
  const forbiddenObserved = observedTools.filter((name) => name === "session_search" || name === "session_query");
  const packagePresent = integrity.sessionRecallPackagePresent === true;
  const configPresent = integrity.sessionRecallConfigPresent === true;
  const model = integrity.model ?? { observations: [], mismatches: [], pass: true };
  return {
    packagePresent,
    configPresent,
    observedTools,
    forbiddenObserved,
    pass: !packagePresent && forbiddenObserved.length === 0 && model.pass !== false,
    audit: integrity.audit ?? null,
    model,
  };
}

function modelObservation(value, source, target) {
  const provider = value?.provider ?? value?.model?.provider ?? null;
  const modelId = value?.modelId ?? value?.model?.id ?? (typeof value?.model === "string" ? value.model : null);
  const thinking = value?.thinkingLevel ?? value?.selectedThinkingLevel ?? value?.level ?? value?.thinking ?? null;
  if (provider === null && modelId === null && thinking === null) return null;
  const mismatches = [];
  if (provider !== null && target?.provider && provider !== target.provider) mismatches.push(`provider:${provider}`);
  if (modelId !== null && target?.modelId && modelId !== target.modelId) mismatches.push(`model:${modelId}`);
  if (thinking !== null && target?.thinking && thinking !== target.thinking) mismatches.push(`thinking:${thinking}`);
  return { source, provider, modelId, thinking, mismatches };
}

function collectModelIntegrity(events, sessionEntries, target) {
  const observations = [];
  const inspect = (value, source) => {
    const observation = modelObservation(value, source, target);
    if (observation) observations.push(observation);
  };
  for (const event of events) {
    if (event?.type === "message_end" && event?.message?.role === "assistant") inspect(event.message, "assistant_message");
    if (["model_select", "model_change", "thinking_level_select", "thinking_level_change"].includes(event?.type)) inspect(event, `event:${event.type}`);
  }
  for (const entry of sessionEntries) {
    if (entry?.type === "message" && entry?.message?.role === "assistant") inspect(entry.message, "session:assistant_message");
    if (["model_select", "model_change", "thinking_level_select", "thinking_level_change"].includes(entry?.type)) inspect(entry, `session:${entry.type}`);
  }
  const mismatches = observations.filter((observation) => observation.mismatches.length > 0);
  return { target: target ?? null, observations, mismatches, pass: mismatches.length === 0 };
}

function compactBoundarySamples(readings, boundaries) {
  return boundaries.map((boundary) => {
    const before = [...readings].reverse().find((reading) => reading.eventIndex < boundary.eventIndex) ?? null;
    const after = readings.find((reading) => reading.eventIndex > boundary.eventIndex) ?? null;
    return {
      ...boundary,
      preTokens: before?.activeTokens ?? null,
      preHardUsagePercent: before?.hardUsagePercent ?? null,
      postTokens: after?.activeTokens ?? null,
      postHardUsagePercent: after?.hardUsagePercent ?? null,
    };
  });
}

function summaryDepthFromEntries(sessionEntries) {
  return sessionEntries.filter((entry) => entry?.type === "branch_summary").length;
}

function judgeTaskScore(report) {
  const score = report?.judge?.verdict?.dimensions?.task_completion?.score;
  return finiteNumber(score);
}

/**
 * Derive telemetry from immutable evidence. The optional `contextWindow`
 * should come from the matrix cell rather than ambient global model config.
 */
export function collectFlowTelemetry({ events = [], report = {}, sessionEntries = [], contextWindow, integrity = {}, target } = {}) {
  const hardContextWindow = positiveInteger(contextWindow ?? report?.contextWindow);
  const workingBudgetTokens = workingBudgetFor(hardContextWindow);
  const turns = splitTurns(events);
  const readings = [];
  const calls = new Map();
  const boundaries = [];
  const reminders = [];
  const summaryDepthSnapshots = [];
  const currentUserTurnOpenReceipts = [];
  const observedTools = [];
  let cycle = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const usage = eventUsage(event);
    const activeTokens = activeTokensFromUsage(usage);
    if (activeTokens !== null && hardContextWindow !== null && workingBudgetTokens !== null) {
      readings.push({
        eventIndex,
        cycle,
        activeTokens,
        hardUsagePercent: activeTokens / hardContextWindow * 100,
        pressurePercent: activeTokens / workingBudgetTokens * 100,
        eventType: event?.type ?? "unknown",
      });
    }

    const reminder = parseReminder(event);
    if (reminder) reminders.push({ ...reminder, eventIndex, cycle });

    const name = toolName(event);
    if (typeof name === "string") observedTools.push(name);
    observedTools.push(...assistantToolNames(event));
    if (event?.type === "tool_execution_start" && typeof name === "string") {
      const id = toolCallId(event) ?? `event-${eventIndex}`;
      calls.set(id, { toolCallId: id, name, startEventIndex: eventIndex, cycle, completed: false, isError: false });
    }
    if (event?.type === "tool_execution_end" && typeof name === "string") {
      const id = toolCallId(event) ?? `event-${eventIndex}`;
      const prior = calls.get(id) ?? { toolCallId: id, name, startEventIndex: null, cycle };
      const details = toolDetails(event);
      const completed = {
        ...prior,
        endEventIndex: eventIndex,
        completed: true,
        isError: event?.isError === true || event?.result?.isError === true || hasDomainError(details),
        details: details ?? null,
        domainError: details?.error ?? null,
        mutationStatus: details?.mutationStatus ?? null,
      };
      calls.set(id, completed);
      if (name === "acm_travel") {
        const depthBefore = finiteNumber(details?.activeSummaryDepthBefore);
        const depthAfter = finiteNumber(details?.activeSummaryDepthAfter);
        if (depthBefore !== null || depthAfter !== null) {
          summaryDepthSnapshots.push({ eventIndex, cycle, before: depthBefore, after: depthAfter, delta: finiteNumber(details?.activeSummaryDepthDelta) });
        }
        if (typeof details?.currentUserTurnOpen === "boolean") {
          currentUserTurnOpenReceipts.push({ eventIndex, toolCallId: id, value: details.currentUserTurnOpen, source: "travel_receipt" });
        }
        if (toolResultIsApplied(event)) {
          boundaries.push({ eventIndex, cycle, kind: boundaryKind(event), toolCallId: id });
          cycle += 1;
        }
      }
    }

    const message = event?.message ?? event;
    if (message?.customType === "acm:post-travel-continuation" && typeof message?.details?.currentUserTurnOpen === "boolean") {
      currentUserTurnOpenReceipts.push({ eventIndex, toolCallId: message.details.toolCallId ?? null, value: message.details.currentUserTurnOpen, source: "continuation_message" });
    }
    if (isCompactionBoundary(event)) {
      boundaries.push({ eventIndex, cycle, kind: boundaryKind(event), toolCallId: null });
      cycle += 1;
    }
  }

  const crossings = [];
  for (let currentCycle = 0; currentCycle <= cycle; currentCycle += 1) {
    const inCycle = readings.filter((reading) => reading.cycle === currentCycle);
    for (const level of NUDGE_LEVELS) {
      const first = inCycle.find((reading) => reading.pressurePercent >= level);
      if (first) crossings.push({ cycle: currentCycle, level, eventIndex: first.eventIndex, activeTokens: first.activeTokens, hardUsagePercent: first.hardUsagePercent, pressurePercent: first.pressurePercent });
    }
  }

  const eventIndexes = new Map(events.map((event, index) => [event, index]));
  const turnTelemetry = turns.map((turnEvents, index) => {
    const indexed = turnEvents
      .map((event) => eventIndexes.get(event) ?? -1)
      .filter((eventIndex) => eventIndex >= 0);
    const indexedSet = new Set(indexed);
    const inTurnReadings = readings.filter((reading) => indexedSet.has(reading.eventIndex));
    const peak = inTurnReadings.reduce((max, reading) => Math.max(max, reading.activeTokens), 0);
    const hard = inTurnReadings.reduce((max, reading) => Math.max(max, reading.hardUsagePercent), 0);
    const pressure = inTurnReadings.reduce((max, reading) => Math.max(max, reading.pressurePercent), 0);
    const turnCalls = [...calls.values()].filter((call) => call.startEventIndex !== null && indexedSet.has(call.startEventIndex));
    return {
      index,
      phase: reportTurnPhase(report, index),
      eventCount: turnEvents.length,
      maxActiveTokens: inTurnReadings.length ? peak : null,
      maxHardUsagePercent: inTurnReadings.length ? hard : null,
      maxPressurePercent: inTurnReadings.length ? pressure : null,
      pressureLevel: levelFor(inTurnReadings.length ? pressure : null),
      acmCalls: turnCalls.filter((call) => call.name.startsWith("acm_")).map((call) => ({ name: call.name, completed: call.completed, isError: call.isError, mutationStatus: call.mutationStatus ?? null })),
    };
  });

  const finalIntegrity = normalizedSessionRecallIntegrity({
    ...integrity,
    observedTools: [...(integrity.observedTools ?? []), ...observedTools],
    model: collectModelIntegrity(events, sessionEntries, target),
  });
  const allCalls = [...calls.values()];
  const acmCalls = allCalls.filter((call) => call.name.startsWith("acm_"));
  const travelCalls = acmCalls.filter((call) => call.name === "acm_travel");
  const peakTokens = readings.reduce((max, reading) => Math.max(max, reading.activeTokens), 0);
  const peakHardUsagePercent = readings.reduce((max, reading) => Math.max(max, reading.hardUsagePercent), 0);
  const peakPressurePercent = readings.reduce((max, reading) => Math.max(max, reading.pressurePercent), 0);
  const crossingLevels = [...new Set(crossings.map((crossing) => crossing.level))].sort((a, b) => a - b);
  const reminderLevels = [...new Set(reminders.map((reminder) => reminder.level).filter((level) => level !== null))].sort((a, b) => a - b);
  const expectedTurns = Array.isArray(report?.turns) ? report.turns.length : null;
  const coverage = {
    usageObserved: readings.length > 0,
    observedTurns: turnTelemetry.length,
    expectedTurns,
    allExpectedTurnsSettled: expectedTurns === null ? null : turnTelemetry.length >= expectedTurns,
    peakTokens: readings.length ? peakTokens : null,
    peakHardUsagePercent: readings.length ? peakHardUsagePercent : null,
    peakPressurePercent: readings.length ? peakPressurePercent : null,
    crossedLevels: crossingLevels,
    reminderLevels,
    missingCrossingLevels: NUDGE_LEVELS.filter((level) => !crossingLevels.includes(level)),
    missingReminderLevels: NUDGE_LEVELS.filter((level) => !reminderLevels.includes(level)),
    successfulTravelObserved: travelCalls.some((call) => call.mutationStatus === "applied" && !call.isError && !nonEmptyDomainError(call.domainError)),
    failedTravelObserved: travelCalls.some((call) => call.mutationStatus === "not_applied" || call.isError || nonEmptyDomainError(call.domainError)),
    compactionBoundaryObserved: boundaries.some((boundary) => boundary.kind === "compaction"),
    currentUserTurnOpenReceiptObserved: currentUserTurnOpenReceipts.length > 0,
    summaryDepthObserved: summaryDepthSnapshots.length > 0 || summaryDepthFromEntries(sessionEntries) > 0,
  };

  return {
    schemaVersion: FLOW_TELEMETRY_SCHEMA_VERSION,
    hardContextWindow,
    workingBudgetTokens,
    turns: turnTelemetry,
    readings,
    peak: {
      activeTokens: readings.length ? peakTokens : null,
      hardUsagePercent: readings.length ? peakHardUsagePercent : null,
      pressurePercent: readings.length ? peakPressurePercent : null,
    },
    crossings,
    reminders,
    cycles: Array.from({ length: cycle + 1 }, (_, id) => ({ id, readingCount: readings.filter((reading) => reading.cycle === id).length, highestPressureLevel: levelFor(readings.filter((reading) => reading.cycle === id).reduce((max, reading) => Math.max(max, reading.pressurePercent), 0)) })),
    acm: {
      calls: acmCalls,
      successfulTravelCount: travelCalls.filter((call) => call.mutationStatus === "applied" && !call.isError && !nonEmptyDomainError(call.domainError)).length,
      failedTravelCount: travelCalls.filter((call) => call.mutationStatus === "not_applied" || call.isError || nonEmptyDomainError(call.domainError)).length,
    },
    summaryDepth: {
      snapshots: summaryDepthSnapshots,
      observedBranchSummaryEntries: summaryDepthFromEntries(sessionEntries),
    },
    currentUserTurnOpenReceipts,
    boundaries: compactBoundarySamples(readings, boundaries),
    integrity: finalIntegrity,
    coverage,
  };
}

/** Classify evidence completeness without claiming a cause for any outcome. */
export function classifyFlowEvidence({ report = {}, telemetry = {} } = {}) {
  const reportHasInfrastructureFailure = report?.status === "infrastructure_invalid" || report?.infrastructureInvalid;
  const fullEnvAudit = report?.resources?.fullEnvHarness;
  const auditIsIncomplete = report?.fullEnv === true && (
    !fullEnvAudit
    || fullEnvAudit?.globalAgents?.harness?.exists !== true
    || fullEnvAudit?.globalAgents?.source?.sha256 !== fullEnvAudit?.globalAgents?.harness?.sha256
  );
  if (reportHasInfrastructureFailure || telemetry?.integrity?.pass === false || auditIsIncomplete) {
    return {
      classification: "infrastructure_invalid",
      reason: reportHasInfrastructureFailure
        ? "runner_reported_infrastructure_invalid"
        : auditIsIncomplete
          ? "full_env_audit_incomplete"
          : "session_recall_integrity_failed",
    };
  }
  const terminalError = (report?.turns ?? []).some((turn) => turn?.stopReason === "error" || turn?.stopReason === "aborted" || turn?.errorMessage);
  if (report?.status === "run_error" || report?.runError || terminalError) {
    return { classification: "run_error", reason: report?.runError ?? "terminal_assistant_error" };
  }
  if (report?.status === "verification_failed" || report?.deterministicVerification?.passed === false) {
    return { classification: "task_failure", reason: "deterministic_verification_failed" };
  }
  const taskScore = judgeTaskScore(report);
  if (taskScore !== null && taskScore < 2) {
    return { classification: "task_failure", reason: `judge_task_completion_score_${taskScore}` };
  }
  const peakPressure = telemetry?.coverage?.peakPressurePercent;
  if (peakPressure === null || peakPressure === undefined || peakPressure < 30) {
    return { classification: "occupancy_miss", reason: "working_budget_never_reached_30_percent" };
  }
  const missing = telemetry?.coverage?.missingCrossingLevels ?? NUDGE_LEVELS;
  if (missing.length > 0 || telemetry?.coverage?.allExpectedTurnsSettled === false || taskScore === null) {
    return { classification: "coverage_insufficient", reason: missing.length > 0 ? `missing_pressure_crossings_${missing.join("_")}` : taskScore === null ? "task_judgment_missing" : "not_all_expected_turns_settled" };
  }
  return { classification: "certifying_run", reason: "observable_coverage_complete" };
}

/** Build a deliberately descriptive 400K-vs-1M card, not a causal verdict. */
export function compareContextArms({ pairKey, constrained400k, native1m }) {
  const summarize = (record) => ({
    classification: record?.classification ?? null,
    maxTokensCap: record?.maxTokensCap ?? null,
    peakTokens: record?.telemetry?.peak?.activeTokens ?? null,
    hardUsagePercent: record?.telemetry?.peak?.hardUsagePercent ?? null,
    pressurePercent: record?.telemetry?.peak?.pressurePercent ?? null,
    crossedLevels: record?.telemetry?.coverage?.crossedLevels ?? [],
    reminderLevels: record?.telemetry?.coverage?.reminderLevels ?? [],
    acmCalls: record?.telemetry?.acm?.calls?.map((call) => call.name) ?? [],
    taskScore: judgeTaskScore(record?.report ?? {}),
  });
  const leftProvenance = constrained400k?.provenance;
  const rightProvenance = native1m?.provenance;
  const mismatchReasons = [];
  if (!leftProvenance || !rightProvenance) mismatchReasons.push("runtime_provenance_missing");
  if (JSON.stringify(leftProvenance?.promptHashes) !== JSON.stringify(rightProvenance?.promptHashes)) mismatchReasons.push("prompt_hash_mismatch");
  if (leftProvenance?.fixtureVersion !== rightProvenance?.fixtureVersion) mismatchReasons.push("fixture_version_mismatch");
  if (leftProvenance?.fixtureSha256 !== rightProvenance?.fixtureSha256) mismatchReasons.push("fixture_hash_mismatch");
  if (leftProvenance?.oracleSha256 !== rightProvenance?.oracleSha256) mismatchReasons.push("oracle_hash_mismatch");
  if (leftProvenance?.secretSeedSha256 !== rightProvenance?.secretSeedSha256) mismatchReasons.push("seed_hash_mismatch");
  if (leftProvenance?.globalCommands?.sha256 !== rightProvenance?.globalCommands?.sha256) mismatchReasons.push("global_command_inventory_mismatch");
  if (constrained400k?.provenanceCheck?.valid === false || native1m?.provenanceCheck?.valid === false) mismatchReasons.push("cell_provenance_invalid");
  const comparable = mismatchReasons.length === 0;
  return {
    pairKey,
    comparable,
    mismatchReasons,
    constrained400k: summarize(constrained400k),
    native1m: summarize(native1m),
    interpretation: comparable
      ? "Descriptive pairing only: equal working-budget pressure does not establish that any observed behavioral difference was caused by hard context-window awareness."
      : "Not paired: prompt, fixture, oracle, or runtime provenance does not match across arms.",
  };
}
