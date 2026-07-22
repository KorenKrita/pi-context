import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireExclusiveEvaluationLock } from "./exclusive-lock.mjs";

test("agents-only lock permits one formal cell and rejects a concurrent owner within the bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-only-lock-"));
  const path = join(root, "agents-only-formal.lock");
  try {
    const first = await acquireExclusiveEvaluationLock({ path, owner: { cellId: "A" }, timeoutMs: 50, pollMs: 5 });
    expect(first).toMatchObject({ acquired: true, path, owner: { cellId: "A" } });
    const second = await acquireExclusiveEvaluationLock({ path, owner: { cellId: "B" }, timeoutMs: 30, pollMs: 5 });
    expect(second).toMatchObject({ acquired: false, path, currentOwner: { cellId: "A" } });

    first.release();
    const afterRelease = await acquireExclusiveEvaluationLock({ path, owner: { cellId: "B" }, timeoutMs: 50, pollMs: 5 });
    expect(afterRelease).toMatchObject({ acquired: true, owner: { cellId: "B" } });
    afterRelease.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents-only lock recovers a dead owner but never removes a token-mismatched live lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-only-stale-lock-"));
  const path = join(root, "agents-only-formal.lock");
  try {
    writeFileSync(path, JSON.stringify({ cellId: "dead", pid: 999999, token: "dead-token" }));
    const recovered = await acquireExclusiveEvaluationLock({
      path,
      owner: { cellId: "new" },
      timeoutMs: 50,
      pollMs: 5,
      isProcessAlive: () => false,
    });
    expect(recovered).toMatchObject({ acquired: true, recovered: true });
    expect(recovered.recoveredOwners).toEqual([expect.objectContaining({ cellId: "dead", token: "dead-token" })]);

    writeFileSync(path, JSON.stringify({ cellId: "replacement", pid: process.pid, token: "replacement-token" }));
    recovered.release();
    expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents-only lock removes a dead recovery claimant before recovering the main lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-only-stale-recovery-"));
  const path = join(root, "agents-only-formal.lock");
  const recoveryPath = `${path}.recovery`;
  try {
    writeFileSync(path, JSON.stringify({ cellId: "dead-main", pid: 999998, token: "dead-main-token" }));
    writeFileSync(recoveryPath, JSON.stringify({ pid: 999999, token: "dead-recovery-token" }));

    const recovered = await acquireExclusiveEvaluationLock({
      path,
      owner: { cellId: "new" },
      timeoutMs: 50,
      pollMs: 5,
      isProcessAlive: () => false,
    });

    expect(recovered).toMatchObject({ acquired: true, recovered: true });
    expect(recovered.recoveredOwners).toEqual([
      expect.objectContaining({ cellId: "dead-main", token: "dead-main-token" }),
    ]);
    expect(existsSync(recoveryPath)).toBe(false);
    recovered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents-only lock recovers an empty recovery claim left before owner data was written", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-only-empty-recovery-"));
  const path = join(root, "agents-only-formal.lock");
  const recoveryPath = `${path}.recovery`;
  try {
    writeFileSync(path, JSON.stringify({ cellId: "dead-main", pid: 999998, token: "dead-main-token" }));
    writeFileSync(recoveryPath, "");
    const recovered = await acquireExclusiveEvaluationLock({
      path,
      owner: { cellId: "new" },
      timeoutMs: 150,
      pollMs: 5,
      isProcessAlive: () => false,
    });
    expect(recovered).toMatchObject({ acquired: true, recovered: true });
    expect(existsSync(recoveryPath)).toBe(false);
    recovered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
