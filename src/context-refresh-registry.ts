/** Persistent post-travel context rebuild state keyed by session manager instance. */
export class ContextRefreshRegistry {
 static readonly MAX_ATTEMPTS = 3;

 private pending = new WeakSet<object>();
 private failures = new WeakMap<object, string>();
 private attempts = new WeakMap<object, number>();
 private rebuilt = new WeakSet<object>();

 markPending(sm: object): void {
  this.pending.add(sm);
  this.failures.delete(sm);
  this.attempts.set(sm, 0);
  this.rebuilt.delete(sm);
 }

 isPending(sm: object): boolean {
  return this.pending.has(sm);
 }

 getAttemptCount(sm: object): number {
  return this.attempts.get(sm) ?? 0;
 }

 clearPending(sm: object): void {
  this.pending.delete(sm);
 }

 private setFailure(sm: object, message: string): void {
  this.failures.set(sm, message);
 }

 getFailure(sm: object): string | undefined {
  return this.failures.get(sm);
 }

 /**
  * Record a failed refresh attempt. Every refresh cycle has the same bounded
  * budget; a valid cached packet may remain deliverable after exhaustion, but
  * persistence reads are not retried again until a new lifecycle cycle.
  */
 recordFailedAttempt(sm: object, message: string): boolean {
  const next = Math.min((this.attempts.get(sm) ?? 0) + 1, ContextRefreshRegistry.MAX_ATTEMPTS);
  this.attempts.set(sm, next);
  this.setFailure(sm, message);
  if (next >= ContextRefreshRegistry.MAX_ATTEMPTS) {
   this.clearPending(sm);
   return false;
  }
  return true;
 }

 markSuccess(sm: object): void {
  this.clear(sm);
 }

 clear(sm: object): void {
  this.pending.delete(sm);
  this.failures.delete(sm);
  this.attempts.delete(sm);
  this.rebuilt.delete(sm);
 }

 markRebuilt(sm: object): void {
  this.rebuilt.add(sm);
  this.failures.delete(sm);
  this.attempts.set(sm, 0);
 }

 hasRebuilt(sm: object): boolean {
  return this.rebuilt.has(sm);
 }
}
