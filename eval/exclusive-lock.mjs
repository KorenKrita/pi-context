import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function readOwner(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireExclusiveEvaluationLock({
  path,
  owner,
  timeoutMs = 5000,
  pollMs = 50,
  now = () => Date.now(),
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  isProcessAlive = processAlive,
}) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = now() + Math.max(0, timeoutMs);
  const token = randomUUID();
  const ownerRecord = { ...owner, pid: process.pid, token, acquiredAt: new Date().toISOString() };
  const recoveryPath = `${path}.recovery`;
  const recoveredOwners = [];
  let malformedRecoveryObservedAt = null;
  while (true) {
    if (existsSync(recoveryPath)) {
      const recoveryOwner = readOwner(recoveryPath);
      if (!recoveryOwner) {
        const observedAt = now();
        malformedRecoveryObservedAt ??= observedAt;
        if (observedAt - malformedRecoveryObservedAt >= Math.max(25, pollMs * 2)) {
          if (readOwner(recoveryPath) === null) {
            try { unlinkSync(recoveryPath); } catch { /* another process repaired it */ }
          }
          malformedRecoveryObservedAt = null;
          continue;
        }
      } else if (!isProcessAlive(recoveryOwner.pid)) {
        const confirmedRecoveryOwner = readOwner(recoveryPath);
        if (confirmedRecoveryOwner?.token === recoveryOwner.token && !isProcessAlive(confirmedRecoveryOwner.pid)) {
          try { unlinkSync(recoveryPath); } catch { /* another process recovered it */ }
        }
        malformedRecoveryObservedAt = null;
        continue;
      } else {
        malformedRecoveryObservedAt = null;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { acquired: false, path, owner: ownerRecord, currentOwner: readOwner(path), recovered: recoveredOwners.length > 0, recoveredOwners, released: false, releasedAt: null };
      }
      await sleep(Math.min(pollMs, remaining));
      continue;
    }
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try { writeFileSync(descriptor, `${JSON.stringify(ownerRecord, null, 2)}\n`); } finally { closeSync(descriptor); }
      const result = {
        acquired: true,
        path,
        owner: ownerRecord,
        recovered: recoveredOwners.length > 0,
        recoveredOwners,
        released: false,
        releasedAt: null,
        release() {
          if (result.released) return;
          const current = readOwner(path);
          if (current?.token === token) {
            try { unlinkSync(path); } catch { /* already released */ }
          }
          result.released = true;
          result.releasedAt = new Date().toISOString();
        },
      };
      return result;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const currentOwner = readOwner(path);
      if (currentOwner && !isProcessAlive(currentOwner.pid)) {
        let recoveryDescriptor = null;
        try {
          recoveryDescriptor = openSync(recoveryPath, "wx", 0o600);
          writeFileSync(recoveryDescriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
          const confirmedOwner = readOwner(path);
          if (confirmedOwner?.token === currentOwner.token && !isProcessAlive(confirmedOwner.pid)) {
            try { unlinkSync(path); } catch { /* another recovery completed */ }
            recoveredOwners.push(confirmedOwner);
          }
        } catch (recoveryError) {
          if (recoveryError?.code !== "EEXIST") throw recoveryError;
        } finally {
          if (recoveryDescriptor !== null) closeSync(recoveryDescriptor);
          const recoveryOwner = readOwner(recoveryPath);
          if (recoveryOwner?.token === token) {
            try { unlinkSync(recoveryPath); } catch { /* already released */ }
          }
        }
        continue;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { acquired: false, path, owner: ownerRecord, currentOwner, recovered: recoveredOwners.length > 0, recoveredOwners, released: false, releasedAt: null };
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }
}
