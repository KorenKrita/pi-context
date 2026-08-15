import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Async, process-wide writer behind the boundary ledger.
 *
 * The ledger fires on the tool_result hot path; its I/O must never block the
 * event loop, so rows are serialized and enqueued synchronously and written by
 * a serialized background drain. The queue is bounded twice — by item count and
 * by line bytes — so a runaway producer costs a dropped row, never memory.
 *
 * Cross-process safety: several Pi processes may write the same ledger file.
 * The prospective size check and the append run inside a proper-lockfile
 * critical section, so the 8 MiB cap holds under concurrency and JSONL lines
 * never interleave. A lock loss (stale/compromised) aborts the critical
 * section instead of writing unlocked. Processes that do not take the lock
 * (older versions) are not serialized against us — the cap is strict among
 * lock takers only. Every failure degrades to a dropped row; the ledger is a
 * diagnostic and must never throw upward, and never block the host for long:
 * rows bound for one file are written under one lock acquisition, and a
 * flush deadline bounds the wait to the deadline plus one lock window (the
 * check sits between batches, so an in-flight batch finishes; shutdown
 * drops what it cannot write in time — losing diagnostics is priced in,
 * hanging the host is not).
 */

/** Hard cap for the shared ledger file, in bytes. */
export const LEDGER_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** Outstanding items allowed in the queue, counting the one being written. */
export const LEDGER_QUEUE_MAX_ITEMS = 256;
/** One serialized row larger than this is dropped rather than buffered. */
export const LEDGER_LINE_MAX_BYTES = 16 * 1024;

export interface LedgerQueueStats {
  /** Rows appended to the file so far in this process. */
  written: number;
  /** Enqueues rejected because the queue was full. */
  droppedQueueFull: number;
  /** Enqueues rejected because the serialized row exceeded the line cap. */
  oversizeDrops: number;
  /** Rows dropped at write time because the file cap would be exceeded. */
  fileFullDrops: number;
  /** Writes that failed after exhausting retries (path unwritable, etc.). */
  writeFailures: number;
  /** Rows dropped because a flush deadline expired before they were written. */
  deadlineDrops: number;
}

interface QueueItem {
  path: string;
  line: string;
  byteLength: number;
  maxBytes: number;
}

export type EnqueueOutcome = "enqueued" | "queue_full" | "oversize";

const stats: LedgerQueueStats = {
  written: 0,
  droppedQueueFull: 0,
  oversizeDrops: 0,
  fileFullDrops: 0,
  writeFailures: 0,
  deadlineDrops: 0,
};
let queue: QueueItem[] = [];
let drainScheduled = false;
// Deadlines installed by flushes in flight. Each flush owns its token and
// removes it only after ITS drain task settles - a finishing flush must
// never clear a deadline another pending flush still needs. Drains (background
// or flush-driven) read the earliest pending token every round.
interface FlushDeadlineToken {
  readonly deadline: number;
}

const pendingFlushDeadlines = new Set<FlushDeadlineToken>();

function earliestPendingDeadline(): number | undefined {
  if (pendingFlushDeadlines.size === 0) return undefined;
  let earliest: number | undefined;
  for (const token of pendingFlushDeadlines) {
    if (earliest === undefined || token.deadline < earliest) earliest = token.deadline;
  }
  return earliest;
}
// Serialized drain tasks: every flush enqueues behind any in-flight drain, so
// awaiting a flush always means awaiting every already-queued row.
let drainChain: Promise<void> = Promise.resolve();

export function ledgerQueueStats(): LedgerQueueStats & { queued: number } {
  return { ...stats, queued: queue.length };
}

/**
 * Serialize and enqueue one row. Synchronous, allocation-bounded, never
 * throws: the hot path must not wait on, or even observe, file I/O.
 */
export function enqueueLedgerLine(path: string, row: unknown, maxBytes: number = LEDGER_FILE_MAX_BYTES): EnqueueOutcome {
  let line: string;
  try {
    line = `${JSON.stringify(row)}\n`;
  } catch {
    stats.oversizeDrops += 1;
    return "oversize";
  }
  const byteLength = Buffer.byteLength(line, "utf8");
  if (byteLength > LEDGER_LINE_MAX_BYTES) {
    stats.oversizeDrops += 1;
    return "oversize";
  }
  if (queue.length >= LEDGER_QUEUE_MAX_ITEMS) {
    stats.droppedQueueFull += 1;
    return "queue_full";
  }
  queue.push({ path, line, byteLength, maxBytes });
  scheduleDrain();
  return "enqueued";
}

/**
 * Wait until every row enqueued so far has reached the file or been dropped.
 * `deadlineMs` bounds the wait to the deadline plus one in-flight lock
 * window: the check sits between batches, an already-started batch finishes,
 * and rows still queued when the deadline passes are dropped and counted —
 * the caller (shutdown) must not hang on lock contention, and a diagnostic
 * tail is not worth minutes of blocked exit. The deadline also binds any
 * background drain still running when the flush arrives, so an in-flight
 * no-deadline drain cannot stretch the wait across extra lock windows.
 */
export function flushLedgerQueue(deadlineMs?: number): Promise<void> {
  let token: FlushDeadlineToken | undefined;
  if (deadlineMs !== undefined) {
    // Object identity, not the deadline number: two flushes in the same
    // millisecond with the same budget produce equal numbers, and a Set of
    // numbers would merge them - the first flush's cleanup would then delete
    // the second flush's deadline.
    token = { deadline: Date.now() + deadlineMs };
    pendingFlushDeadlines.add(token);
  }
  return enqueueDrainTask(async () => {
    // async matters: the finally below must run after this drain settles,
    // not synchronously when the task callback returns its promise - that
    // old shape let one finishing flush clear another pending flush's
    // deadline.
    try {
      return await drainQueue(undefined);
    } finally {
      if (token !== undefined) pendingFlushDeadlines.delete(token);
    }
  });
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    void enqueueDrainTask(() => drainQueue(undefined));
  });
}

function enqueueDrainTask(task: () => Promise<void>): Promise<void> {
  const next = drainChain.then(task, task);
  drainChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function drainQueue(deadline: number | undefined): Promise<void> {
  while (queue.length > 0) {
    // Re-read the earliest pending flush deadline every round: a flush that
    // arrives after this drain started must still bound its remaining
    // batches, which a parameter snapshot taken at startup can never see.
    const pending = earliestPendingDeadline();
    const effectiveDeadline = pending !== undefined && (deadline === undefined || pending < deadline)
      ? pending
      : deadline;
    if (effectiveDeadline !== undefined && Date.now() >= effectiveDeadline) {
      stats.deadlineDrops += queue.length;
      queue = [];
      return;
    }
    // Batch every row bound for the same file under one lock acquisition:
    // one retry window per batch, not per row, one append syscall after the
    // cap filter, and exact accounting - only the rows that actually failed
    // are counted as failures.
    const path = queue[0]!.path;
    let batchEnd = 0;
    while (batchEnd < queue.length && queue[batchEnd]!.path === path) batchEnd++;
    let writtenInBatch = 0;
    let capDroppedInBatch = 0;
    try {
      await mkdir(dirname(path), { recursive: true });
      await withFileLock(path, async (compromised) => {
        const size = await fileSize(path);
        const writable: string[] = [];
        let prospective = size;
        for (let index = 0; index < batchEnd; index++) {
          if (compromised()) throw new Error("ledger lock compromised before write");
          const item = queue[index]!;
          if (prospective + item.byteLength > item.maxBytes) {
            stats.fileFullDrops += 1;
            capDroppedInBatch += 1;
            continue;
          }
          writable.push(item.line);
          prospective += item.byteLength;
        }
        if (writable.length > 0) {
          await appendFile(path, writable.join(""), "utf8");
          writtenInBatch = writable.length;
          stats.written += writtenInBatch;
        }
      });
    } catch {
      // Accounting from outcomes, not from a partially-updated attempt
      // counter: every row in the batch either was written, was counted in
      // fileFullDrops, or failed. A stat failure or mid-scan compromise
      // before the cap loop has run still fails every non-written,
      // non-dropped row - rows must never vanish from the ledger's counts.
      const settledRows = writtenInBatch + capDroppedInBatch;
      stats.writeFailures += Math.max(0, batchEnd - settledRows);
    }
    queue = queue.slice(batchEnd);
  }
}

/**
 * Only a genuinely missing file reads as size zero — the normal first write.
 * Any other stat error propagates so the row is dropped and counted instead
 * of silently bypassing the cap with a fake zero size.
 */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return 0;
    throw error;
  }
}

type LockfileModule = {
  lock: (file: string, options?: Record<string, unknown>) => Promise<() => Promise<void>>;
};
let lockfileModule: LockfileModule | undefined;

async function loadLockfile(): Promise<LockfileModule> {
  lockfileModule ??= (await import("proper-lockfile")) as LockfileModule;
  return lockfileModule;
}

/**
 * Run `critical` under a proper-lockfile lock on the ledger file, passing a
 * `compromised()` probe the critical section must honor: proper-lockfile
 * detects stale/compromised locks mid-flight and calls onCompromised, and a
 * write after that point would run unlocked against the cap. The lock module
 * is a direct dependency; if importing or acquiring it fails — broken install,
 * contention beyond the retry window — the failure propagates so the caller
 * drops those rows and counts them. There is no unlocked write path. Unlock
 * failures are swallowed: a completed write stays completed.
 */
async function withFileLock(path: string, critical: (compromised: () => boolean) => Promise<void>): Promise<void> {
  const lockfile = await loadLockfile();
  let compromised = false;
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 10_000,
    update: 5_000,
    retries: { retries: 20, factor: 1, minTimeout: 20, maxTimeout: 100 },
    onCompromised: () => {
      compromised = true;
    },
  });
  try {
    await critical(() => compromised);
  } finally {
    try {
      await release();
    } catch {
      // Release failure must not turn a completed write into a failure.
    }
  }
}
