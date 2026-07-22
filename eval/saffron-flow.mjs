import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "@earendil-works/pi-agent-core";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
export const SAFFRON_FIXTURE_DIR = join(EVAL_ROOT, "fixtures", "saffron-cutover");
export const SAFFRON_FLOW_ID = "saffron-cutover-long-flow-v1";
export const SAFFRON_FIXTURE_VERSION = "2026-07-22.7";
// P4's early digest plus this 235K packet calibrate the pre-P7 active working
// set to roughly 287K tokens (about 71.7%) after observed Pi/system/tool
// overhead in a 400K host window, preserving headroom for current-turn work.
export const DEFAULT_PACKET_TOKEN_TARGET = 235_000;
export const DEFAULT_EARLY_DIGEST_TOKEN_TARGET = 35_000;
export const DEFAULT_SUPPLEMENT_TOKEN_TARGET = 55_000;
export const MAX_PACKET_TOKEN_TARGET = 240_000;
export const MAX_EARLY_DIGEST_TOKEN_TARGET = 50_000;
export const MAX_SUPPLEMENT_TOKEN_TARGET = 70_000;

/** User-visible prompts must never name ACM or direct a particular ACM action. */
export const BANNED_PROMPT_TERMS = Object.freeze([
  /\bacm[_-]?/i,
  /\bcontext\b/i,
  /\bcompression\b/i,
  /\bcheckpoint\b/i,
  /\bsave[ -]?point\b/i,
  /\btimeline\b/i,
  /\bfold\b/i,
  /\btravel\b/i,
  /\brebase\b/i,
  /\brehydrate\b/i,
  /上下文|压缩|检查点|存档点|时间线|折叠|重建|回灌/,
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Exact raw bytes of the committed R1 control-plane fixture, not just its revision field. */
export const SAFFRON_EXPECTED_R1_SHA256 = sha256(
  readFileSync(join(SAFFRON_FIXTURE_DIR, "fixtures", "control-plane.json"), "utf8"),
);

function shortHash(seed, label, length = 12) {
  return sha256(`${seed}\u0000${label}`).slice(0, length).toUpperCase();
}

/** Match Pi's own message estimator instead of treating English words as tokens. */
function estimateUserTokens(value) {
  return estimateTokens({ role: "user", content: value, timestamp: 0 });
}

function calibratedTarget(optionValue, environmentName, fallback, upperBound) {
  if (optionValue !== undefined) return optionValue;
  const raw = process.env[environmentName];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_500 || parsed > upperBound) {
    throw new Error(`${environmentName} must be an integer between 1500 and ${upperBound}`);
  }
  return parsed;
}

function checkedTokenTarget(value, label, upperBound) {
  if (!Number.isInteger(value) || value < 1_500 || value > upperBound) {
    throw new Error(`${label} must be an integer between 1500 and ${upperBound}`);
  }
  return value;
}

function freshSeed() {
  return randomBytes(32).toString("hex");
}

const SAFFRON_NOTHING_TO_COMPACT = "Nothing to compact (session too small)";

function compactErrorMessage(value) {
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = value.error;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : null;
}

function isSaffronNothingToCompact(value) {
  const message = typeof value === "string" ? value : compactErrorMessage(value);
  return message === SAFFRON_NOTHING_TO_COMPACT || message === `compact rejected: ${SAFFRON_NOTHING_TO_COMPACT}`;
}

function saffronTooSmallCompactionSkip() {
  return {
    kind: "native_compact",
    skipped: "session_too_small",
    reason: SAFFRON_NOTHING_TO_COMPACT,
  };
}

const SAFFRON_BASELINE_GIT_IDENTITY = Object.freeze({
  name: "KorenKrita",
  email: "KorenKrita@gmail.com",
});
const SAFFRON_BASELINE_GIT_DATE = "2000-01-01T00:00:00+00:00";
const SAFFRON_BASELINE_GIT_SUBJECT = "chore: establish Saffron fixture baseline";

function git(workspace, args, { env } = {}) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function hasGitHead(workspace) {
  try {
    return git(workspace, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * The copied Saffron fixture intentionally starts as a non-Git directory.
 * Establish a local, deterministic baseline before P1 so the fixture's own
 * AGENTS.md applies Git recoverability rather than the non-Git backup rule.
 */
function initializeSaffronWorkspaceGitBaseline(workspace) {
  if (!workspace) throw new Error("workspace is required to initialize the Saffron Git baseline");

  const gitDirectory = join(workspace, ".git");
  if (existsSync(gitDirectory)) {
    const initialHead = hasGitHead(workspace);
    if (initialHead) {
      return Object.freeze({ state: "existing", commit: initialHead });
    }
  }

  if (!existsSync(gitDirectory)) {
    git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  } else {
    // An empty fixture repository can inherit a caller's default branch.
    // Pin it before its first commit without touching any global configuration.
    git(workspace, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  git(workspace, ["config", "--local", "user.name", SAFFRON_BASELINE_GIT_IDENTITY.name]);
  git(workspace, ["config", "--local", "user.email", SAFFRON_BASELINE_GIT_IDENTITY.email]);
  git(workspace, ["config", "--local", "commit.gpgSign", "false"]);
  git(workspace, ["add", "--all"]);
  git(workspace, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", SAFFRON_BASELINE_GIT_SUBJECT], {
    env: {
      GIT_AUTHOR_NAME: SAFFRON_BASELINE_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: SAFFRON_BASELINE_GIT_IDENTITY.email,
      GIT_AUTHOR_DATE: SAFFRON_BASELINE_GIT_DATE,
      GIT_COMMITTER_NAME: SAFFRON_BASELINE_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: SAFFRON_BASELINE_GIT_IDENTITY.email,
      GIT_COMMITTER_DATE: SAFFRON_BASELINE_GIT_DATE,
    },
  });
  const commit = hasGitHead(workspace);
  if (!commit) throw new Error("Saffron Git baseline commit was not created");
  const dirty = git(workspace, ["status", "--porcelain"]);
  if (dirty) throw new Error(`Saffron Git baseline must be clean after initialization: ${dirty}`);
  return Object.freeze({ state: "initialized", commit });
}

function sortedFixtureFiles(dir = SAFFRON_FIXTURE_DIR, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const child = join(dir, entry.name);
      const name = join(prefix, entry.name);
      return entry.isDirectory() ? sortedFixtureFiles(child, name) : [name];
    })
    .sort();
}

export function saffronFixtureSha256() {
  const lines = [];
  for (const file of sortedFixtureFiles()) {
    const absolute = join(SAFFRON_FIXTURE_DIR, file);
    lines.push(`${relative(SAFFRON_FIXTURE_DIR, absolute)}\u0000${readFileSync(absolute, "utf8")}`);
  }
  return sha256(lines.join("\n\u0001\n"));
}

/**
 * The oracle lives in the runner/report side only. Its high-entropy facts are
 * deliberately absent from the fixture copied into a model workspace.
 */
export function getSaffronOracle(seed) {
  const effectiveSeed = seed ?? freshSeed();
  const legalExclusion = `NONTRANSFERABLE-SAFFRON-${shortHash(effectiveSeed, "legal-exclusion", 20)}-${shortHash(effectiveSeed, "legal-tail", 16)}`;
  const incidentNonce = `INC-SAFFRON-${shortHash(effectiveSeed, "incident", 18)}`;
  const authorityOwner = `Saffron Release Council / Control Policy ${shortHash(effectiveSeed, "authority", 8)}`;
  const staleClaim = `carrier override ${shortHash(effectiveSeed, "stale-claim", 10)} may bypass an active freeze`;
  return Object.freeze({
    legalExclusion,
    incidentNonce,
    authorityOwner,
    staleClaim,
    externalRevision: "R2",
    expectedDecision: "hold",
    expectedFreeze: true,
  });
}

const SYSTEMS = Object.freeze([
  "Atlas intake", "Lumen ledger", "Cinder policy", "Mosaic billing", "Harbor routing", "Quartz identity",
  "Ember export", "Vega audit", "Nacre registry", "Kite rollout", "Cobalt guard", "Meridian usage",
  "Orbit approval", "Juniper archive", "Pollen recovery", "Aster console", "Rill gateway", "Fjord scheduler",
]);
const TOPICS = Object.freeze([
  "provider eligibility", "event identity", "policy acknowledgement", "freeze handling", "pricing exception",
  "rollout ordering", "retention boundary", "tenant reconciliation", "approval signature", "incident linkage",
  "migration constraint", "operator notification", "ledger settlement", "exception expiry", "change ownership",
]);
const EVIDENCE_KINDS = Object.freeze(["signed policy", "operator note", "migration review", "release council minute", "vendor appendix"]);

function recordFor(index, oracle) {
  const system = SYSTEMS[index % SYSTEMS.length];
  const topic = TOPICS[index % TOPICS.length];
  const kind = EVIDENCE_KINDS[index % EVIDENCE_KINDS.length];
  const rank = index % 11 === 0 ? "superseded" : index % 7 === 0 ? "advisory" : "binding";
  const stale = index % 11 === 0
    ? `Earlier statement: ${oracle.staleClaim}. This statement is superseded and must not control a release decision.`
    : "No replacement is recorded for this statement within this evidence entry.";
  const authority = rank === "binding"
    ? oracle.authorityOwner
    : `${system} operational delegate`;
  const decision = `For ${topic}, the current rule is to preserve a traceable owner, verify the signed source, and defer any irreversible action until the controlling policy is satisfied.`;
  const anchor = index === 37
    ? `Binding incident linkage token: ${oracle.incidentNonce}. It identifies the later control-plane reconciliation.`
    : index === 113
      ? `Binding legal exclusion phrase, including punctuation-free spelling: ${oracle.legalExclusion}. It may be quoted only when the later legal exception is prepared.`
      : index === 241
        ? `Authority chain: ${oracle.authorityOwner} outranks vendor appendices and operational notes for release policy.`
        : "No unique final-delivery token is introduced by this entry.";
  return [
    `## Evidence ${String(index + 1).padStart(4, "0")} — ${system}`,
    `Record type: ${kind}. Authority status: ${rank}. Topic: ${topic}.`,
    `Source owner: ${authority}.`,
    decision,
    `The record distinguishes a source-of-truth rule from an implementation observation; a plausible observation is not permission to override the rule.`,
    stale,
    anchor,
    `Review obligation: link this entry to the provenance ledger with its authority status and retain the reason for accepting or rejecting it.`,
    "",
  ].join("\n");
}

/**
 * Produce a large but semantically structured packet. It uses deterministic
 * policy records rather than filler text and has a stable whitespace-token
 * target so the same prompt can be used in 400K and 1M runs.
 */
export function buildSaffronEvidencePacket({
  seed,
  tokenTarget = DEFAULT_PACKET_TOKEN_TARGET,
} = {}) {
  const effectiveSeed = seed ?? freshSeed();
  checkedTokenTarget(tokenTarget, "tokenTarget", MAX_PACKET_TOKEN_TARGET);
  const oracle = getSaffronOracle(effectiveSeed);
  const records = [
    "# Saffron late evidence packet",
    "This packet is a multi-team release dossier. Each entry carries provenance, authority rank, and whether an older claim is stale. The release decision must follow binding policy rather than a plausible lower-rank note.",
    "",
  ];
  let count = estimateUserTokens(records.join("\n"));
  let index = 0;
  while (count < tokenTarget) {
    const record = recordFor(index, oracle);
    records.push(record);
    // Incremental estimation keeps a 235K-packet materialization linear. A
    // final exact estimate below handles only the message-level overhead.
    count += estimateUserTokens(record);
    index += 1;
  }
  let packet = records.join("\n");
  while (estimateUserTokens(packet) < tokenTarget) {
    packet = `${packet}\n${recordFor(index, oracle)}`;
    index += 1;
  }
  return Object.freeze({
    packet,
    tokenEstimate: estimateUserTokens(packet),
    recordCount: index,
    sha256: sha256(packet),
  });
}

function briefRecord(index, label) {
  const system = SYSTEMS[(index * 3) % SYSTEMS.length];
  const topic = TOPICS[(index * 5) % TOPICS.length];
  return [
    `### ${label} ${String(index + 1).padStart(4, "0")} — ${system}`,
    `This review note concerns ${topic}. It separates a binding owner from a local implementation observation and records an unresolved direct-evidence request.`,
    `The reviewer must preserve who may decide, what is merely reported, and which later control-plane observation can supersede the note.`,
    `No release permission is implied by this note. Its value is traceability, contradiction detection, and a concrete follow-up source.`,
    "",
  ].join("\n");
}

function buildStructuredBrief({ label, tokenTarget, upperBound }) {
  checkedTokenTarget(tokenTarget, `${label} token target`, upperBound);
  const records = [`# Saffron ${label}`, "These are structured operational records, not filler. Each contributes an authority distinction or a follow-up source.", ""];
  let count = estimateUserTokens(records.join("\n"));
  let index = 0;
  while (count < tokenTarget) {
    const record = briefRecord(index, label);
    records.push(record);
    count += estimateUserTokens(record);
    index += 1;
  }
  let text = records.join("\n");
  while (estimateUserTokens(text) < tokenTarget) {
    text = `${text}\n${briefRecord(index, label)}`;
    index += 1;
  }
  return Object.freeze({ text, tokenEstimate: estimateUserTokens(text), recordCount: index, sha256: sha256(text) });
}

export function buildSaffronEarlyDigest({ tokenTarget = DEFAULT_EARLY_DIGEST_TOKEN_TARGET } = {}) {
  return buildStructuredBrief({ label: "early authority digest", tokenTarget, upperBound: MAX_EARLY_DIGEST_TOKEN_TARGET });
}

export function buildSaffronPostCompactSupplement({ tokenTarget = DEFAULT_SUPPLEMENT_TOKEN_TARGET } = {}) {
  return buildStructuredBrief({ label: "post-compact operations supplement", tokenTarget, upperBound: MAX_SUPPLEMENT_TOKEN_TARGET });
}

function phase(phaseName, prompt, intent, timeoutMs) {
  return Object.freeze({ phase: phaseName, prompt, intent, ...(timeoutMs ? { timeoutMs } : {}) });
}

function assertDeprimed(turns) {
  for (const turn of turns) {
    for (const term of BANNED_PROMPT_TERMS) {
      if (term.test(turn.prompt)) {
        throw new Error(`Saffron prompt ${turn.phase} contains banned ACM vocabulary: ${term}`);
      }
    }
  }
}

function makeTurns({ packet, earlyDigest, supplement }) {
  const turns = [
    phase(
      "P1-接手基线",
      "这是 Saffron release-cutover 项目。请实际阅读 README 和 src 下全部实现，运行现有测试，解释事件接收、policy gate、dry-run 输出各自现在做什么。把你确认的初始风险、未验证点和后续需要追踪的事实写进 docs/working-ledger.md。不要只按文件名猜。",
      "Initial exploration should not cause an automatic transition; raw architecture knowledge is still active.",
      420_000,
    ),
    phase(
      "P2-修事件幂等",
      "有一批延迟送达的 webhook 重复事件让 release ledger 多记了记录。请实际复现：同一 eventId 但 receivedAt 不同必须只接受一次；两个 eventId 即使 receivedAt 相同也都必须接受。修好实现，补或更新验证，然后把项目测试跑通。",
      "A verified code baseline becomes a future recovery boundary after the repair.",
      540_000,
    ),
    phase(
      "P3-风险门禁",
      "现在要收紧 release gate：rollout 必须在 plan 已批准、policy acknowledgement 已持久化、且没有 freeze 时才允许。先确认现状，再完成最小正确改动和验证；运行 scripts/verify-policy-order.mjs。实现路径有两种看似合理的方案，请保留足够证据让后续能判断哪条路径被采用；不要为方便而放宽 gate。",
      "Risky core work creates a natural baseline, fork, and precise-recovery opportunity.",
      540_000,
    ),
    phase(
      "P4-早期口径",
      `下面是一份来自多个团队的早期 briefing。请提炼出 authority hierarchy、仍未证实的主张、以及做 release 决定前还需要哪些直接证据，写到 docs/provenance-map.md。不要批准 release，也不要把低权威的运营备注当成政策。\n\n- Control Policy 负责最终 release gate。\n- Vendor appendix 可以描述实现观察，但不能推翻 Control Policy。\n- 收到后续 control-plane revision 前，之前读到的 revision 只能视为历史观察。\n- 交付时需要能解释为什么某些看似合理的供应商备注被拒绝。\n\n${earlyDigest}`,
      "A smaller evidence front establishes a semantic boundary and possible orientation need without naming a tool.",
      420_000,
    ),
    phase(
      "P5-先保持未决",
      "在真正做 release 决定前，先说明还缺什么事实以及每个事实应该由谁提供。现在不要批准、不要部署、不要把猜测写成结论。把问题清单补充到 docs/provenance-map.md，并保持已经完成的代码验证不被改写。",
      "This is a restraint probe: active uncertainty is not permission for an irreversible decision.",
      420_000,
    ),
    phase(
      "P6-晚到证据",
      `现在收到了一份晚到的跨团队证据包。请逐项识别其 authority status、哪些旧说法已经失效、哪些事实应进入最终 decision basis，并把可追溯结论写入 docs/evidence-ledger.md。此回合只做证据分类和依据整理，不要发布或批准 release。\n\n${packet}`,
      "A large, meaningful raw dossier creates high working-budget pressure, sediment, and a legitimate representation-choice opportunity while the decision remains unresolved.",
      900_000,
    ),
    phase(
      "P7-当前控制面",
      "请现在运行 scripts/control-plane-status.mjs 获取当前 control-plane 状态，结合已完成的 ledger 写 release/go-no-go.json，并在本回合用中文明确告诉我当前是 go 还是 hold、依据是什么。dry-run 输出也必须带 decisionBasis 和 externalRevision；补齐验证并运行 scripts/verify-dry-run.mjs。不要用之前看过的 control-plane 结果代替这次查询。",
      "A live external change and an open user delivery make current-user-turn continuity observable if a transition occurs.",
      600_000,
    ),
    phase(
      "P8-压缩后对账",
      `请把下面的补充运营记录与当前 control-plane 状态逐项对账，写 release/reconciliation.md。重点是标出仍然有效的 source、被新 revision 覆盖的观察、以及 hold 状态下不能执行的动作。不要重新做已经通过的事件幂等或 gate 修复。\n\n补充记录：R2 是一次独立状态更新；任何早于它的 provider eligibility 观察只可作为审计材料。应保留 policy authority、freeze、revision 与 incident linkage 的直接来源。对账结论必须能被审计员复现。\n\n${supplement}`,
      "Post-compaction continuation must use surviving authoritative state and refresh external facts rather than replay old work.",
      540_000,
    ),
    phase(
      "P9-法律例外",
      "最终法律例外说明必须逐字包含早期证据包中的 exact legal exclusion phrase；它不在项目文件里，也不能根据常识改写。请找到可靠来源后写 release/legal-exceptions.md，并说明该短语来自哪类权威证据。不要把 incident token 或供应商备注误当成法律短语。",
      "An exact early high-entropy fact is a natural archive-recovery opportunity when it was not retained in the active representation.",
      600_000,
    ),
    phase(
      "P10-交付收口",
      "更新 README，写清楚事件幂等、release gate 顺序、dry-run 字段、control-plane revision 的使用方式和 hold 的含义。然后运行 npm test 与 scripts/verify-delivery.mjs，修复所有失败。最后给我一份准确交付总结：代码、证据、外部状态、法律例外和仍不可执行的动作分别是什么。",
      "A final synthesis probes competing summaries, recovery, rebase judgment, and task outcome without requiring a ritual action.",
      720_000,
    ),
  ];
  assertDeprimed(turns);
  return Object.freeze(turns);
}

function controlPlanePreconditionEvidence(controlPlanePath) {
  let beforeText;
  let beforeSha256 = null;
  try {
    beforeText = readFileSync(controlPlanePath, "utf8");
    beforeSha256 = sha256(beforeText);
  } catch (error) {
    const beforeError = error instanceof Error ? error.message : String(error);
    return {
      precondition: error && typeof error === "object" && error.code === "ENOENT" ? "missing" : "read_error",
      beforeRevision: null,
      beforeSha256,
      expectedBeforeSha256: SAFFRON_EXPECTED_R1_SHA256,
      beforeError,
    };
  }
  try {
    const before = JSON.parse(beforeText);
    const beforeRevision = before?.revision ?? null;
    return {
      precondition: beforeRevision !== "R1"
        ? "unexpected_revision"
        : beforeSha256 === SAFFRON_EXPECTED_R1_SHA256 ? "expected_r1" : "unexpected_content",
      beforeRevision,
      beforeSha256,
      expectedBeforeSha256: SAFFRON_EXPECTED_R1_SHA256,
      beforeError: null,
    };
  } catch (error) {
    return {
      precondition: "invalid_json",
      beforeRevision: null,
      beforeSha256,
      expectedBeforeSha256: SAFFRON_EXPECTED_R1_SHA256,
      beforeError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applySaffronControlPlaneR2({ workspace, oracle }) {
  if (!workspace) throw new Error("workspace is required to apply the Saffron external perturbation");
  const controlPlanePath = join(workspace, "fixtures", "control-plane.json");
  const preconditionEvidence = controlPlanePreconditionEvidence(controlPlanePath);
  const next = {
    revision: oracle.externalRevision,
    freeze: oracle.expectedFreeze,
    approvedProviders: ["atlas"],
    incidentNonce: oracle.incidentNonce,
    updatedBy: "saffron-control-plane-r2-hook",
  };
  const encoded = `${JSON.stringify(next, null, 2)}\n`;
  const temporary = `${controlPlanePath}.r2-${process.pid}.tmp`;
  writeFileSync(temporary, encoded);
  renameSync(temporary, controlPlanePath);
  return Object.freeze({
    kind: "control_plane_r1_to_r2",
    path: controlPlanePath,
    ...preconditionEvidence,
    afterSha256: sha256(encoded),
    revision: next.revision,
    incidentNonce: next.incidentNonce,
  });
}

/**
 * Materialize a fresh long-flow. Supplying the same explicit seed makes paired
 * 400K/1M arms byte-identical; an omitted seed is cryptographically random so
 * a model cannot learn stable hidden answers across evaluation rounds.
 */
export function materializeSaffronFlow({
  contextWindow,
  runDir,
  seed,
  packetTokenTarget,
  earlyDigestTokenTarget,
  supplementTokenTarget,
} = {}) {
  const effectiveSeed = seed ?? freshSeed();
  const oracle = getSaffronOracle(effectiveSeed);
  const calibratedPacketTarget = checkedTokenTarget(
    calibratedTarget(packetTokenTarget, "SAFFRON_PACKET_TOKEN_TARGET", DEFAULT_PACKET_TOKEN_TARGET, MAX_PACKET_TOKEN_TARGET),
    "packetTokenTarget",
    MAX_PACKET_TOKEN_TARGET,
  );
  const calibratedDigestTarget = checkedTokenTarget(
    calibratedTarget(earlyDigestTokenTarget, "SAFFRON_EARLY_DIGEST_TOKEN_TARGET", DEFAULT_EARLY_DIGEST_TOKEN_TARGET, MAX_EARLY_DIGEST_TOKEN_TARGET),
    "earlyDigestTokenTarget",
    MAX_EARLY_DIGEST_TOKEN_TARGET,
  );
  const calibratedSupplementTarget = checkedTokenTarget(
    calibratedTarget(supplementTokenTarget, "SAFFRON_SUPPLEMENT_TOKEN_TARGET", DEFAULT_SUPPLEMENT_TOKEN_TARGET, MAX_SUPPLEMENT_TOKEN_TARGET),
    "supplementTokenTarget",
    MAX_SUPPLEMENT_TOKEN_TARGET,
  );
  const packet = buildSaffronEvidencePacket({ seed: effectiveSeed, tokenTarget: calibratedPacketTarget });
  const earlyDigest = buildSaffronEarlyDigest({ tokenTarget: calibratedDigestTarget });
  const supplement = buildSaffronPostCompactSupplement({ tokenTarget: calibratedSupplementTarget });
  const baseTurns = makeTurns({ packet: packet.packet, earlyDigest: earlyDigest.text, supplement: supplement.text });
  const promptHashes = Object.freeze(baseTurns.map((turn) => Object.freeze({ phase: turn.phase, sha256: sha256(turn.prompt) })));
  const manifest = Object.freeze({
    flowId: SAFFRON_FLOW_ID,
    fixtureVersion: SAFFRON_FIXTURE_VERSION,
    fixtureSha256: saffronFixtureSha256(),
    seedSha256: sha256(effectiveSeed),
    requestedContextWindow: contextWindow ?? null,
    packet: {
      sha256: packet.sha256,
      tokenEstimate: packet.tokenEstimate,
      recordCount: packet.recordCount,
      tokenTarget: calibratedPacketTarget,
    },
    earlyDigest: {
      sha256: earlyDigest.sha256,
      tokenEstimate: earlyDigest.tokenEstimate,
      recordCount: earlyDigest.recordCount,
      tokenTarget: calibratedDigestTarget,
    },
    supplement: {
      sha256: supplement.sha256,
      tokenEstimate: supplement.tokenEstimate,
      recordCount: supplement.recordCount,
      tokenTarget: calibratedSupplementTarget,
    },
    promptHashes,
    oracleSha256: sha256(JSON.stringify(oracle)),
  });
  const persistRunEvidence = (targetRunDir) => {
    if (!targetRunDir) return;
    mkdirSync(targetRunDir, { recursive: true });
    writeFileSync(join(targetRunDir, "saffron-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  if (runDir) {
    persistRunEvidence(runDir);
  }
  const turns = Object.freeze(baseTurns.map((turn) => {
    if (turn.phase === "P6-晚到证据") {
      return Object.freeze({
        ...turn,
        // The runner executes this only after P6 has settled, so P7 is forced
        // to query a real later control-plane state rather than reuse R1.
        after: ({ workspace }) => applySaffronControlPlaneR2({ workspace, oracle }),
      });
    }
    if (turn.phase === "P7-当前控制面") {
      return Object.freeze({
        ...turn,
        // Preserve an automatic native compaction if it already occurred while
        // the P7 run settled; otherwise request an authentic RPC compaction.
        after: async ({ events, driver }) => {
          if (events.some((event) => event?.type === "session_compact")) {
            return { kind: "native_compact", skipped: "already_compacted_during_p7" };
          }
          try {
            const result = await driver.compact();
            if (isSaffronNothingToCompact(result)) return saffronTooSmallCompactionSkip();
            const error = compactErrorMessage(result);
            if (error) {
              throw result instanceof Error ? result : result.error instanceof Error ? result.error : new Error(`compact rejected: ${error}`);
            }
            return { kind: "native_compact", result };
          } catch (error) {
            if (isSaffronNothingToCompact(error)) return saffronTooSmallCompactionSkip();
            throw error;
          }
        },
      });
    }
    return turn;
  }));
  return Object.freeze({
    id: SAFFRON_FLOW_ID,
    description: "Ten-turn de-primed release-cutover flow with a deterministic large evidence packet, external R1-to-R2 perturbation, exact legal recovery, and final delivery verifier.",
    seedDir: SAFFRON_FIXTURE_DIR,
    taskCompletionDesc: "Saffron release-cutover 的代码修复、authority-based evidence judgement、R2 external freshness、法律例外精确短语与最终交付验证是否全部正确。",
    turns,
    hiddenOracle: oracle,
    promptHashes,
    manifest,
    beforeRun: ({ workspace, runDir: actualRunDir }) => {
      const baseline = initializeSaffronWorkspaceGitBaseline(workspace);
      persistRunEvidence(actualRunDir);
      return baseline;
    },
    verify: ({ workspace, turnRecords }) => import("./saffron-verifier.mjs")
      .then(({ verifySaffronDelivery }) => verifySaffronDelivery({ workspace, oracle, turnRecords })),
    persistPrivateEvidence: ({ runDir: actualRunDir }) => persistSaffronPrivateEvidence({ runDir: actualRunDir, oracle, manifest }),
    afterStop: ({ runDir: actualRunDir }) => persistSaffronPrivateEvidence({ runDir: actualRunDir, oracle, manifest }),
  });
}

/**
 * The runner may call this only after the Pi process has stopped. Keeping the
 * oracle out of runDir during execution prevents filesystem-based answer
 * discovery while retaining auditable post-run scoring evidence.
 */
export function persistSaffronPrivateEvidence({ runDir, oracle, manifest }) {
  if (!runDir) throw new Error("runDir is required for private Saffron evidence");
  if (!oracle) throw new Error("oracle is required for private Saffron evidence");
  mkdirSync(runDir, { recursive: true });
  const evidence = {
    flowId: SAFFRON_FLOW_ID,
    fixtureVersion: SAFFRON_FIXTURE_VERSION,
    seedSha256: manifest?.seedSha256 ?? null,
    oracleSha256: manifest?.oracleSha256 ?? sha256(JSON.stringify(oracle)),
    oracle,
  };
  writeFileSync(join(runDir, "saffron-oracle.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return Object.freeze({ path: join(runDir, "saffron-oracle.json"), oracleSha256: evidence.oracleSha256 });
}

/**
 * Lightweight registry descriptor. The large packet is deliberately created
 * only when a runner selects this flow or calls materialize(), so ordinary
 * eval commands do not pay its allocation cost.
 */
export const SAFFRON_FLOW = Object.freeze({
  id: SAFFRON_FLOW_ID,
  description: "Ten-turn de-primed release-cutover flow with a deterministic large evidence packet, external R1-to-R2 perturbation, exact legal recovery, and final delivery verifier.",
  seedDir: SAFFRON_FIXTURE_DIR,
  taskCompletionDesc: "Saffron release-cutover 的代码修复、authority-based evidence judgement、R2 external freshness、法律例外精确短语与最终交付验证是否全部正确。",
  materialize: materializeSaffronFlow,
  get turns() {
    return materializeSaffronFlow().turns;
  },
});

export function assertSaffronWorkspaceHasNoOracleFacts(workspace, oracle) {
  if (!existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
  if (!oracle) throw new Error("oracle is required for Saffron workspace isolation checks");
  const forbidden = [oracle.legalExclusion, oracle.incidentNonce, oracle.authorityOwner, oracle.staleClaim];
  const stack = [workspace];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else {
        const content = readFileSync(target, "utf8");
        for (const fact of forbidden) {
          if (content.includes(fact)) {
            throw new Error(`workspace leaks hidden Saffron oracle fact in ${target}`);
          }
        }
      }
    }
  }
}
