import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BANNED_PROMPT_TERMS,
  DEFAULT_EARLY_DIGEST_TOKEN_TARGET,
  DEFAULT_PACKET_TOKEN_TARGET,
  DEFAULT_SUPPLEMENT_TOKEN_TARGET,
  MAX_PACKET_TOKEN_TARGET,
  SAFFRON_EXPECTED_R1_SHA256,
  SAFFRON_FIXTURE_DIR,
  applySaffronControlPlaneR2,
  assertSaffronWorkspaceHasNoOracleFacts,
  buildSaffronEvidencePacket,
  getSaffronOracle,
  materializeSaffronFlow,
} from "./saffron-flow.mjs";
import { verifySaffronDelivery } from "./saffron-verifier.mjs";

const TEST_SEED = "saffron-test-seed-2026-07-22";

function temporaryDirectory(label) {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

function git(workspace, args) {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

function writeReferenceDelivery(workspace, oracle) {
  mkdirSync(join(workspace, "docs"), { recursive: true });
  mkdirSync(join(workspace, "release"), { recursive: true });
  writeFileSync(join(workspace, "src", "event-gate.mjs"), `
export function acceptEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
}
`);
  writeFileSync(join(workspace, "src", "policy-order.mjs"), `
export function canStartRollout({ planApproved, policyAcknowledged, freeze }) {
  return Boolean(planApproved && policyAcknowledged && !freeze);
}
`);
  writeFileSync(join(workspace, "src", "cli.mjs"), `
export function formatDryRun({ revision, ready, decisionBasis, externalRevision }) {
  return JSON.stringify({ kind: "dry-run", revision, ready, decisionBasis, externalRevision });
}
`);
  writeFileSync(join(workspace, "docs", "evidence-ledger.md"), `${oracle.authorityOwner}\nRejected stale claim: ${oracle.staleClaim}\n`);
  writeFileSync(join(workspace, "release", "go-no-go.json"), `${JSON.stringify({
    externalRevision: oracle.externalRevision,
    incidentNonce: oracle.incidentNonce,
    decision: oracle.expectedDecision,
  }, null, 2)}\n`);
  writeFileSync(join(workspace, "release", "reconciliation.md"), `revision=${oracle.externalRevision}\nincident=${oracle.incidentNonce}\n`);
  writeFileSync(join(workspace, "release", "legal-exceptions.md"), `Approved legal exception: ${oracle.legalExclusion}\n`);
  writeFileSync(join(workspace, "README.md"), [
    "# Saffron Cutover",
    "Use immutable eventId for idempotency.",
    "The order is plan then policy acknowledgement then rollout.",
    "Dry run reports decisionBasis and externalRevision.",
    "A release freeze means hold.",
  ].join("\n"));
}

function saffronTurnRecords(oracle, {
  probe = true,
  probeBeforeWrite = true,
  correctResult = true,
  p6AfterTurnHook = {
    kind: "control_plane_r1_to_r2",
    precondition: "expected_r1",
    beforeRevision: "R1",
    beforeSha256: SAFFRON_EXPECTED_R1_SHA256,
    expectedBeforeSha256: SAFFRON_EXPECTED_R1_SHA256,
    beforeError: null,
  },
} = {}) {
  const statusCall = {
    name: "bash",
    completed: true,
    isError: false,
    args: { command: "node scripts/control-plane-status.mjs" },
    resultText: correctResult
      ? JSON.stringify({ revision: oracle.externalRevision, freeze: true, incidentNonce: oracle.incidentNonce })
      : JSON.stringify({ revision: "R1", freeze: false, incidentNonce: "stale" }),
  };
  const writeCall = {
    name: "write",
    completed: true,
    isError: false,
    args: { path: "release/go-no-go.json", content: "{}" },
  };
  const calls = probe
    ? probeBeforeWrite ? [statusCall, writeCall] : [writeCall, statusCall]
    : [writeCall];
  return [
    { phase: "P6-晚到证据", hooks: { afterTurnHook: p6AfterTurnHook } },
    { phase: "P7-当前控制面", toolCalls: calls },
  ];
}

test("Saffron materialization is deterministic across context-window arms", () => {
  const first = materializeSaffronFlow({
    contextWindow: 400_000,
    seed: TEST_SEED,
  });
  const second = materializeSaffronFlow({
    contextWindow: 1_000_000,
    seed: TEST_SEED,
  });
  expect(first.promptHashes).toEqual(second.promptHashes);
  expect(first.manifest.packet.sha256).toBe(second.manifest.packet.sha256);
  expect(first.manifest.packet.tokenEstimate).toBeGreaterThanOrEqual(DEFAULT_PACKET_TOKEN_TARGET);
  expect(first.manifest.earlyDigest.tokenEstimate).toBeGreaterThanOrEqual(DEFAULT_EARLY_DIGEST_TOKEN_TARGET);
  expect(first.manifest.supplement.tokenEstimate).toBeGreaterThanOrEqual(DEFAULT_SUPPLEMENT_TOKEN_TARGET);
  expect(first.manifest.requestedContextWindow).toBe(400_000);
  expect(second.manifest.requestedContextWindow).toBe(1_000_000);
});

test("Saffron default materialization calibrates packet occupancy without exceeding a 400K arm", () => {
  const flow = materializeSaffronFlow({ contextWindow: 400_000, seed: TEST_SEED });
  const largestPayloadEstimate = Math.max(
    flow.manifest.packet.tokenEstimate,
    flow.manifest.earlyDigest.tokenEstimate,
    flow.manifest.supplement.tokenEstimate,
  );
  const preP7PayloadEstimate = flow.manifest.packet.tokenEstimate + flow.manifest.earlyDigest.tokenEstimate;

  expect(DEFAULT_PACKET_TOKEN_TARGET).toBe(235_000);
  expect(flow.manifest.packet.tokenTarget).toBe(DEFAULT_PACKET_TOKEN_TARGET);
  expect(flow.manifest.packet.tokenEstimate).toBeGreaterThanOrEqual(DEFAULT_PACKET_TOKEN_TARGET);
  expect(flow.manifest.packet.tokenEstimate).toBeLessThanOrEqual(MAX_PACKET_TOKEN_TARGET);
  expect(largestPayloadEstimate).toBeLessThan(400_000);
  expect(preP7PayloadEstimate).toBeLessThan(400_000);
});

test("Saffron defaults use fresh cryptographic seeds while explicit seed pairs remain identical", () => {
  const randomFirst = materializeSaffronFlow({ packetTokenTarget: 2_000, earlyDigestTokenTarget: 1_500, supplementTokenTarget: 1_500 });
  const randomSecond = materializeSaffronFlow({ packetTokenTarget: 2_000, earlyDigestTokenTarget: 1_500, supplementTokenTarget: 1_500 });
  expect(randomFirst.manifest.seedSha256).not.toBe(randomSecond.manifest.seedSha256);
  expect(randomFirst.manifest.oracleSha256).not.toBe(randomSecond.manifest.oracleSha256);
  expect(randomFirst.promptHashes).not.toEqual(randomSecond.promptHashes);

  const seededFirst = materializeSaffronFlow({ seed: TEST_SEED, packetTokenTarget: 2_000, earlyDigestTokenTarget: 1_500, supplementTokenTarget: 1_500 });
  const seededSecond = materializeSaffronFlow({ seed: TEST_SEED, packetTokenTarget: 2_000, earlyDigestTokenTarget: 1_500, supplementTokenTarget: 1_500 });
  expect(seededFirst.promptHashes).toEqual(seededSecond.promptHashes);
  expect(seededFirst.manifest.oracleSha256).toBe(seededSecond.manifest.oracleSha256);
});

test("Saffron user prompts remain de-primed", () => {
  const flow = materializeSaffronFlow({
    seed: TEST_SEED,
    packetTokenTarget: 2_000,
    earlyDigestTokenTarget: 1_500,
    supplementTokenTarget: 1_500,
  });
  for (const turn of flow.turns) {
    for (const term of BANNED_PROMPT_TERMS) {
      expect(term.test(turn.prompt)).toBe(false);
    }
  }
});

test("Saffron P7 compaction skips only the exact already-compacted or too-small-session no-ops", async () => {
  const flow = materializeSaffronFlow({
    seed: TEST_SEED,
    packetTokenTarget: 2_000,
    earlyDigestTokenTarget: 1_500,
    supplementTokenTarget: 1_500,
  });
  const p7 = flow.turns.find((turn) => turn.phase === "P7-当前控制面");
  expect(p7?.after).toBeDefined();

  let compactCalls = 0;
  await expect(p7.after({
    events: [{ type: "session_compact" }],
    driver: { compact: async () => { compactCalls += 1; } },
  })).resolves.toEqual({ kind: "native_compact", skipped: "already_compacted_during_p7" });
  expect(compactCalls).toBe(0);

  await expect(p7.after({
    events: [],
    driver: { compact: async () => { throw new Error("compact rejected: Nothing to compact (session too small)"); } },
  })).resolves.toEqual({
    kind: "native_compact",
    skipped: "session_too_small",
    reason: "Nothing to compact (session too small)",
  });

  await expect(p7.after({
    events: [],
    driver: { compact: async () => ({ error: "Nothing to compact (session too small)" }) },
  })).resolves.toEqual({
    kind: "native_compact",
    skipped: "session_too_small",
    reason: "Nothing to compact (session too small)",
  });

  await expect(p7.after({
    events: [],
    driver: { compact: async () => { throw new Error("compact rejected: transport lost"); } },
  })).rejects.toThrow("compact rejected: transport lost");

  await expect(p7.after({
    events: [],
    driver: { compact: async () => ({ error: "transport lost" }) },
  })).rejects.toThrow("compact rejected: transport lost");
});

test("Saffron persists only hashes before stop and writes private oracle evidence afterward", () => {
  const runDir = temporaryDirectory("saffron-run-evidence");
  try {
    const flow = materializeSaffronFlow({
      runDir,
      seed: TEST_SEED,
      packetTokenTarget: 2_000,
      earlyDigestTokenTarget: 1_500,
      supplementTokenTarget: 1_500,
    });
    const manifest = JSON.parse(readFileSync(join(runDir, "saffron-manifest.json"), "utf8"));
    expect(manifest.fixtureSha256).toBeTruthy();
    expect(manifest.packet.sha256).toBeTruthy();
    expect(manifest.promptHashes).toEqual(flow.promptHashes);
    expect(manifest.oracleSha256).toBeTruthy();
    expect(manifest.seed).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain(TEST_SEED);
    expect(JSON.stringify(manifest)).not.toContain(flow.hiddenOracle.legalExclusion);
    expect(() => readFileSync(join(runDir, "saffron-oracle.json"), "utf8")).toThrow();

    flow.persistPrivateEvidence({ runDir });
    const persistedEvidence = JSON.parse(readFileSync(join(runDir, "saffron-oracle.json"), "utf8"));
    expect(persistedEvidence.oracle.legalExclusion).toBe(flow.hiddenOracle.legalExclusion);
    expect(JSON.stringify(persistedEvidence)).not.toContain(TEST_SEED);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("Saffron beforeRun establishes a clean, deterministic local Git baseline without run artifacts", () => {
  const workspace = temporaryDirectory("saffron-git-baseline");
  const runDir = temporaryDirectory("saffron-git-run");
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    const flow = materializeSaffronFlow({
      seed: TEST_SEED,
      packetTokenTarget: 2_000,
      earlyDigestTokenTarget: 1_500,
      supplementTokenTarget: 1_500,
    });

    const first = flow.beforeRun({ workspace, runDir });
    const baselineCommit = git(workspace, ["rev-parse", "HEAD"]);
    expect(first).toEqual({ state: "initialized", commit: baselineCommit });
    expect(git(workspace, ["status", "--porcelain"])).toBe("");
    expect(git(workspace, ["branch", "--show-current"])).toBe("main");
    expect(git(workspace, ["log", "-1", "--format=%s"]))
      .toBe("chore: establish Saffron fixture baseline");
    expect(git(workspace, ["log", "-1", "--format=%an <%ae> %aI %cI"]))
      .toBe("KorenKrita <KorenKrita@gmail.com> 2000-01-01T00:00:00Z 2000-01-01T00:00:00Z");
    expect(git(workspace, ["config", "--local", "--get", "user.name"]))
      .toBe("KorenKrita");
    expect(git(workspace, ["config", "--local", "--get", "user.email"]))
      .toBe("KorenKrita@gmail.com");
    const trackedFiles = git(workspace, ["ls-files"]).split("\n");
    expect(trackedFiles).toContain("AGENTS.md");
    expect(trackedFiles).toContain("src/event-gate.mjs");
    expect(trackedFiles).not.toContain("saffron-manifest.json");
    expect(trackedFiles).not.toContain("saffron-oracle.json");
    expect(readFileSync(join(runDir, "saffron-manifest.json"), "utf8")).toContain("fixtureSha256");

    const second = flow.beforeRun({ workspace, runDir });
    expect(second).toEqual({ state: "existing", commit: baselineCommit });
    expect(git(workspace, ["rev-parse", "HEAD"])).toBe(baselineCommit);
    expect(git(workspace, ["status", "--porcelain"])).toBe("");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("Saffron oracle anchors are absent from the copied model workspace", () => {
  const workspace = temporaryDirectory("saffron-workspace");
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    expect(() => assertSaffronWorkspaceHasNoOracleFacts(workspace, getSaffronOracle(TEST_SEED))).not.toThrow();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron verifier accepts a correct delivery and rejects an altered legal phrase", async () => {
  const workspace = temporaryDirectory("saffron-verifier");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    const hostHook = applySaffronControlPlaneR2({ workspace, oracle });
    expect(hostHook.precondition).toBe("expected_r1");
    expect(hostHook.beforeRevision).toBe("R1");
    expect(hostHook.beforeSha256).toBe(SAFFRON_EXPECTED_R1_SHA256);
    expect(hostHook.expectedBeforeSha256).toBe(SAFFRON_EXPECTED_R1_SHA256);
    expect(hostHook.beforeError).toBeNull();
    writeReferenceDelivery(workspace, oracle);
    const good = await verifySaffronDelivery({ workspace, oracle, turnRecords: saffronTurnRecords(oracle, { p6AfterTurnHook: hostHook }) });
    expect(good.pass).toBe(true);

    writeFileSync(join(workspace, "release", "legal-exceptions.md"), "Approved legal exception: paraphrased wording\n");
    const bad = await verifySaffronDelivery({ workspace, oracle, turnRecords: saffronTurnRecords(oracle) });
    expect(bad.pass).toBe(false);
    expect(bad.checks.find((item) => item.name === "legal exception preserves exact high-entropy phrase")?.pass).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron fixture-local delivery verifier requires the current incident nonce", () => {
  const workspace = temporaryDirectory("saffron-local-delivery-verifier");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    applySaffronControlPlaneR2({ workspace, oracle });
    writeReferenceDelivery(workspace, oracle);

    expect(execFileSync(process.execPath, ["scripts/verify-delivery.mjs"], {
      cwd: workspace,
      encoding: "utf8",
    })).toContain("saffron delivery verification passed");

    const decisionPath = join(workspace, "release", "go-no-go.json");
    const { incidentNonce: _incidentNonce, ...decisionWithoutNonce } = JSON.parse(readFileSync(decisionPath, "utf8"));
    for (const invalidDecision of [
      decisionWithoutNonce,
      { ...decisionWithoutNonce, incidentNonce: "stale-incident-linkage" },
    ]) {
      writeFileSync(decisionPath, `${JSON.stringify(invalidDecision, null, 2)}\n`);
      const failed = spawnSync(process.execPath, ["scripts/verify-delivery.mjs"], {
        cwd: workspace,
        encoding: "utf8",
      });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("go/no-go decision must preserve the current control-plane incident nonce/linkage");
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron P6 overwrites a model-forged R2 and attributes the precondition failure to task verification", async () => {
  const workspace = temporaryDirectory("saffron-forged-r2");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    writeFileSync(join(workspace, "fixtures", "control-plane.json"), `${JSON.stringify({
      revision: "R2",
      freeze: false,
      approvedProviders: ["forged"],
      incidentNonce: "forged-before-host-perturbation",
      updatedBy: "model-forgery",
    }, null, 2)}\n`);

    const hostHook = applySaffronControlPlaneR2({ workspace, oracle });
    expect(hostHook.precondition).toBe("unexpected_revision");
    expect(hostHook.beforeRevision).toBe("R2");
    expect(hostHook.beforeSha256).toBeTruthy();
    expect(hostHook.beforeError).toBeNull();
    expect(JSON.parse(readFileSync(join(workspace, "fixtures", "control-plane.json"), "utf8"))).toEqual({
      revision: oracle.externalRevision,
      freeze: oracle.expectedFreeze,
      approvedProviders: ["atlas"],
      incidentNonce: oracle.incidentNonce,
      updatedBy: "saffron-control-plane-r2-hook",
    });

    writeReferenceDelivery(workspace, oracle);
    const result = await verifySaffronDelivery({
      workspace,
      oracle,
      turnRecords: saffronTurnRecords(oracle, { p6AfterTurnHook: hostHook }),
    });
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "P6 host perturbation starts from exact R1")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "external control plane reached R2 freeze")?.pass).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron P6 rejects forged R1 content even when the revision remains R1", async () => {
  const workspace = temporaryDirectory("saffron-forged-r1");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    writeFileSync(join(workspace, "fixtures", "control-plane.json"), `${JSON.stringify({
      revision: "R1",
      freeze: true,
      approvedProviders: ["forged"],
      incidentNonce: "forged-r1-nonce",
      updatedBy: "model-forgery",
    }, null, 2)}\n`);

    const hostHook = applySaffronControlPlaneR2({ workspace, oracle });
    expect(hostHook.precondition).toBe("unexpected_content");
    expect(hostHook.beforeRevision).toBe("R1");
    expect(hostHook.beforeSha256).not.toBe(SAFFRON_EXPECTED_R1_SHA256);
    expect(hostHook.expectedBeforeSha256).toBe(SAFFRON_EXPECTED_R1_SHA256);
    expect(JSON.parse(readFileSync(join(workspace, "fixtures", "control-plane.json"), "utf8")).revision).toBe(oracle.externalRevision);

    writeReferenceDelivery(workspace, oracle);
    const result = await verifySaffronDelivery({
      workspace,
      oracle,
      turnRecords: saffronTurnRecords(oracle, { p6AfterTurnHook: hostHook }),
    });
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "P6 host perturbation starts from exact R1")?.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "external control plane reached R2 freeze")?.pass).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron P6 records invalid and missing control-plane preconditions before installing R2", () => {
  const workspace = temporaryDirectory("saffron-invalid-control-plane");
  const oracle = getSaffronOracle(TEST_SEED);
  const controlPlanePath = join(workspace, "fixtures", "control-plane.json");
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    writeFileSync(controlPlanePath, "{ invalid JSON");
    const invalid = applySaffronControlPlaneR2({ workspace, oracle });
    expect(invalid.precondition).toBe("invalid_json");
    expect(invalid.beforeRevision).toBeNull();
    expect(invalid.beforeSha256).toHaveLength(64);
    expect(invalid.beforeError).toBeTruthy();
    expect(JSON.parse(readFileSync(controlPlanePath, "utf8")).revision).toBe(oracle.externalRevision);

    rmSync(controlPlanePath);
    const missing = applySaffronControlPlaneR2({ workspace, oracle });
    expect(missing.precondition).toBe("missing");
    expect(missing.beforeRevision).toBeNull();
    expect(missing.beforeSha256).toBeNull();
    expect(missing.beforeError).toBeTruthy();
    expect(JSON.parse(readFileSync(controlPlanePath, "utf8")).revision).toBe(oracle.externalRevision);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron verifier rejects a missing, stale, or wrong-order P7 control-plane query", async () => {
  const workspace = temporaryDirectory("saffron-p7-verifier");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    applySaffronControlPlaneR2({ workspace, oracle });
    writeReferenceDelivery(workspace, oracle);
    for (const turnRecords of [
      saffronTurnRecords(oracle, { probe: false }),
      saffronTurnRecords(oracle, { correctResult: false }),
      saffronTurnRecords(oracle, { probeBeforeWrite: false }),
    ]) {
      const result = await verifySaffronDelivery({ workspace, oracle, turnRecords });
      expect(result.pass).toBe(false);
      expect(result.checks.find((item) => item.name === "P7 refreshes control-plane state before writing go/no-go")?.pass).toBe(false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron verifier rejects a stale bypass claim copied as valid permission", async () => {
  const workspace = temporaryDirectory("saffron-stale-verifier");
  const oracle = getSaffronOracle(TEST_SEED);
  try {
    cpSync(SAFFRON_FIXTURE_DIR, workspace, { recursive: true });
    applySaffronControlPlaneR2({ workspace, oracle });
    writeReferenceDelivery(workspace, oracle);
    writeFileSync(
      join(workspace, "docs", "evidence-ledger.md"),
      `${oracle.authorityOwner}\nValid release permission: ${oracle.staleClaim}\n`,
    );
    const result = await verifySaffronDelivery({ workspace, oracle, turnRecords: saffronTurnRecords(oracle) });
    expect(result.pass).toBe(false);
    expect(result.checks.find((item) => item.name === "evidence ledger preserves authority and rejects stale lower-rank claim")?.pass).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Saffron packet has deterministic structured records rather than random text", () => {
  const first = buildSaffronEvidencePacket({ seed: TEST_SEED, tokenTarget: 2_000 });
  const second = buildSaffronEvidencePacket({ seed: TEST_SEED, tokenTarget: 2_000 });
  expect(first.sha256).toBe(second.sha256);
  expect(first.tokenEstimate).toBeGreaterThanOrEqual(2_000);
  expect(first.packet).toContain("Authority status:");
  expect(first.packet).toContain("Review obligation:");
});

test("Saffron rejects token targets that could overflow a 400K run", () => {
  expect(() => materializeSaffronFlow({ seed: TEST_SEED, packetTokenTarget: 240_001 })).toThrow();
  expect(() => materializeSaffronFlow({ seed: TEST_SEED, earlyDigestTokenTarget: 50_001 })).toThrow();
  expect(() => materializeSaffronFlow({ seed: TEST_SEED, supplementTokenTarget: 70_001 })).toThrow();
});
