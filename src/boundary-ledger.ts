import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only ledger of user-request boundaries and folds.
 *
 * Why it exists: whether a fold was missed at a request boundary is currently
 * unobservable inside this repository. The retired evaluation harness cannot
 * answer it either — it constructed scenarios, and its premises were repeatedly
 * overturned by calibration. What is missing is not a scenario but a count.
 *
 * Why not the HUD: a session that never folds is also a session that never
 * calls acm_timeline, so a rendered line is visible exactly where the failure
 * is absent. The observation has to be passive or n never grows.
 *
 * What keeps it lawful under the gauge contract: it does not inject, does not
 * choose a moment, and does not render. It is a writer with a fixed schema —
 * counts and percentages only, never message content — and every failure is
 * swallowed. A ledger is not allowed to become a new failure surface.
 */

/** One row per observed user-request boundary. Counts and percentages only. */
export interface BoundaryLedgerRow {
  /** Wall clock, so rows from concurrent sessions remain orderable. */
  ts: string;
  /** Stable per-process session discriminator; not a session file path. */
  session: string;
  /** 1-based ordinal of this boundary within the session. */
  boundary: number;
  /** Working-budget pressure at the boundary, floored. */
  budget: number | null;
  /** Hard-window usage at the boundary, floored. */
  window: number | null;
  /** Projected budget pressure after folding to the turn reference, floored. */
  foldTurn: number | null;
  /** Projected budget pressure after folding to the task reference, floored. */
  foldTask: number | null;
  /** Folds applied in this session before this boundary. */
  foldsSoFar: number;
  /** Active-branch entry count, so boundary spacing is recoverable. */
  entries: number;
}

/** One row per applied travel, carrying the delta the receipt already reports. */
export interface FoldLedgerRow {
  ts: string;
  session: string;
  /** Boundaries observed in this session before this fold. */
  afterBoundary: number;
  /** Budget pressure before the fold, floored. */
  budgetBefore: number | null;
  /** Estimated budget pressure after the fold, floored. */
  budgetAfter: number | null;
  /** Session messages removed, negative when history was restored. */
  messageDelta: number | null;
  /** Active handoff summary layers after the fold. */
  summaryDepth: number | null;
}

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

function ledgerPath(env: Record<string, string | undefined> = process.env): string {
  const base = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return join(base, "state", "acm-boundary-ledger.jsonl");
}

/** Kill switch. Read per call so a session can be excluded without a restart. */
export function isLedgerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_LEDGER_DISABLED"] === "1";
}

/**
 * Append one row. Never throws, never reports: a diagnostic writer must not be
 * able to affect a tool result. Silence on failure is the contract, not an
 * oversight — the only cost of a lost row is a slightly smaller n.
 */
export function appendLedgerRow(
  kind: "boundary" | "fold",
  row: BoundaryLedgerRow | FoldLedgerRow,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isLedgerDisabled(env)) return false;
  try {
    const path = ledgerPath(env);
    try {
      if (statSync(path).size > MAX_LEDGER_BYTES) return false;
    } catch {
      // Missing file is the normal first-write path; any other stat failure
      // falls through to the append attempt, which is itself guarded.
    }
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ kind, ...row })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Per-session ledger counters. Volatile: a fresh process starts a fresh count. */
export interface LedgerState {
  session: string;
  boundaries: number;
  folds: number;
  /** Entry id of the last counted boundary, so re-observation does not double count. */
  lastBoundaryEntryId: string | null;
}

export function createLedgerState(session: string): LedgerState {
  return { session, boundaries: 0, folds: 0, lastBoundaryEntryId: null };
}

/**
 * Count a boundary once per distinct entry. The same boundary is observed on
 * every tool result of that turn, and counting each observation would report
 * tool activity rather than request structure.
 */
export function shouldCountBoundary(state: LedgerState, boundaryEntryId: string | null): boolean {
  if (boundaryEntryId === null) return false;
  return state.lastBoundaryEntryId !== boundaryEntryId;
}

export function markBoundaryCounted(state: LedgerState, boundaryEntryId: string): number {
  state.lastBoundaryEntryId = boundaryEntryId;
  state.boundaries += 1;
  return state.boundaries;
}

export function markFoldCounted(state: LedgerState): number {
  state.folds += 1;
  return state.folds;
}

function floorOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

export function buildBoundaryRow(input: {
  state: LedgerState;
  boundary: number;
  budgetPercent: number | null | undefined;
  windowPercent: number | null | undefined;
  foldTurnPercent: number | null | undefined;
  foldTaskPercent: number | null | undefined;
  entries: number;
}): BoundaryLedgerRow {
  return {
    ts: new Date().toISOString(),
    session: input.state.session,
    boundary: input.boundary,
    budget: floorOrNull(input.budgetPercent),
    window: floorOrNull(input.windowPercent),
    foldTurn: floorOrNull(input.foldTurnPercent),
    foldTask: floorOrNull(input.foldTaskPercent),
    foldsSoFar: input.state.folds,
    entries: input.entries,
  };
}

export function buildFoldRow(input: {
  state: LedgerState;
  budgetBefore: number | null | undefined;
  budgetAfter: number | null | undefined;
  messageDelta: number | null | undefined;
  summaryDepth: number | null | undefined;
}): FoldLedgerRow {
  return {
    ts: new Date().toISOString(),
    session: input.state.session,
    afterBoundary: input.state.boundaries,
    budgetBefore: floorOrNull(input.budgetBefore),
    budgetAfter: floorOrNull(input.budgetAfter),
    messageDelta: typeof input.messageDelta === "number" && Number.isFinite(input.messageDelta)
      ? input.messageDelta
      : null,
    summaryDepth: floorOrNull(input.summaryDepth),
  };
}

export { ledgerPath as acmLedgerPath, MAX_LEDGER_BYTES as ACM_LEDGER_MAX_BYTES };
