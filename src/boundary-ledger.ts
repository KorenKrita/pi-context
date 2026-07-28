import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 *
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 *
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 *
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 */

/** 每个观测到的用户请求边界一行。仅记录计数与百分比。 */
export interface BoundaryLedgerRow {
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  ts: string;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  session: string;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  boundary: number;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  budget: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  window: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  foldTurn: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  foldTask: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  foldsSoFar: number;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  entries: number;
}

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export interface FoldLedgerRow {
  ts: string;
  session: string;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  afterBoundary: number;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  budgetBefore: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  budgetAfter: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  messageDelta: number | null;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  summaryDepth: number | null;
}

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

function ledgerPath(env: Record<string, string | undefined> = process.env): string {
  const base = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return join(base, "state", "acm-boundary-ledger.jsonl");
}

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export function isLedgerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ACM_LEDGER_DISABLED"] === "1";
}

/**
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
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
      // 实现说明：该处维护既有的结构、状态与错误处理契约。
      // 实现说明：该处维护既有的结构、状态与错误处理契约。
    }
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ kind, ...row })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
export interface LedgerState {
  session: string;
  boundaries: number;
  folds: number;
  /** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
  lastBoundaryEntryId: string | null;
}

export function createLedgerState(session: string): LedgerState {
  return { session, boundaries: 0, folds: 0, lastBoundaryEntryId: null };
}

/**
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
 * 实现说明：该处维护既有的结构、状态与错误处理契约。
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
