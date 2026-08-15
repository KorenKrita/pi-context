/**
 * Minimal usage-surface declaration for proper-lockfile@4. The ledger writer
 * imports it lazily and degrades to unlocked writes when absent, so only the
 * two functions it calls are declared here.
 */
declare module "proper-lockfile" {
  export interface ProperLockfileRetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }
  export interface ProperLockfileLockOptions {
    /** The target may not exist yet on the first write, so never resolve it. */
    realpath?: boolean;
    stale?: number;
    update?: number;
    retries?: number | ProperLockfileRetryOptions;
    onCompromised?: (error: Error) => void;
  }
  export function lock(file: string, options?: ProperLockfileLockOptions): Promise<void>;
  export function unlock(file: string, options?: { realpath?: boolean }): Promise<void>;
}
