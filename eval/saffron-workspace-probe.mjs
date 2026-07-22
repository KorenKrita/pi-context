import { pathToFileURL } from "node:url";
import { join } from "node:path";

const RESULT_PREFIX = "SAFFRON_WORKSPACE_PROBE=";
const trustedWrite = process.stdout.write.bind(process.stdout);
const trustedExit = process.exit.bind(process);
const [workspace, externalRevision] = process.argv.slice(2);
if (!workspace || !externalRevision) throw new Error("workspace and externalRevision are required");

const importWorkspaceModule = (relativePath) => import(
  `${pathToFileURL(join(workspace, relativePath)).href}?saffron-probe=${Date.now()}-${Math.random()}`
);

const [eventGate, policyOrder, cli] = await Promise.all([
  importWorkspaceModule("src/event-gate.mjs"),
  importWorkspaceModule("src/policy-order.mjs"),
  importWorkspaceModule("src/cli.mjs"),
]);

const accepted = eventGate.acceptEvents([
  { eventId: "evt-a", receivedAt: "2026-07-22T10:00:00Z" },
  { eventId: "evt-a", receivedAt: "2026-07-22T10:04:00Z" },
  { eventId: "evt-b", receivedAt: "2026-07-22T10:00:00Z" },
]);
const dryRun = JSON.parse(cli.formatDryRun({
  revision: externalRevision,
  ready: false,
  decisionBasis: "freeze-active",
  externalRevision,
}));
const result = {
  acceptedEventIds: Array.isArray(accepted) ? accepted.map((event) => event.eventId) : null,
  rolloutWithoutAcknowledgement: policyOrder.canStartRollout({ planApproved: true, policyAcknowledged: false, freeze: false }),
  rolloutReady: policyOrder.canStartRollout({ planApproved: true, policyAcknowledged: true, freeze: false }),
  rolloutDuringFreeze: policyOrder.canStartRollout({ planApproved: true, policyAcknowledged: true, freeze: true }),
  dryRun,
};
trustedWrite(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
trustedExit(0);
