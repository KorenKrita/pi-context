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
 * never interleave. Processes that do not take the lock (older versions) are
 * not serialized against us — the cap is strict among lock takers only. Every
 * failure, including lock-module unavailability, degrades to unlocked writes
 * or a dropped row; the ledger is a diagnostic and must never throw upward.
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
};
let queue: QueueItem[] = [];
let drainScheduled = false;
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

/** Wait until every row enqueued so far has reached the file or been dropped. */
export function flushLedgerQueue(): Promise<void> {
  return enqueueDrainTask(drainQueue);
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    void enqueueDrainTask(drainQueue);
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

async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const item = queue[0]!;
    try {
      await mkdir(dirname(item.path), { recursive: true });
      await withFileLock(item.path, async () => {
        const size = await fileSize(item.path);
        if (size + item.byteLength > item.maxBytes) {
          stats.fileFullDrops += 1;
          return;
        }
        await appendFile(item.path, item.line, "utf8");
        stats.written += 1;
      });
    } catch {
      stats.writeFailures += 1;
    }
    queue.shift();
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    // A missing file is the normal first-write path.
    return 0;
  }
}

/**
 * Run `critical` under a proper-lockfile lock on the ledger file. The lock
 * module is loaded lazily: if it is missing, or locking fails for any reason,
 * the write proceeds unlocked — an unlocked diagnostic append is worth more
 * than a dropped row, and O_APPEND keeps single writes line-atomic in
 * practice. Unlock failures are swallowed for the same reason.
 */
async function withFileLock(path: string, critical: () => Promise<void>): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    const lockfile = (await import("proper-lockfile")) as {
      lock: (file: string, options?: Record<string, unknown>) => Promise<void>;
      unlock: (file: string, options?: Record<string, unknown>) => Promise<void>;
    };
    const options = {
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 100 },
      onCompromised: () => undefined,
    };
    await lockfile.lock(path, options);
    release = () => lockfile.unlock(path, { realpath: false });
  } catch {
    await critical();
    return;
  }
  try {
    await critical();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Release failure must not turn a completed write into a failure.
      }
    }
  }
}
