import { formatDryRun } from "../src/cli.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dryRun = JSON.parse(formatDryRun({
  revision: "R2",
  ready: false,
  decisionBasis: "freeze-active",
  externalRevision: "R2",
}));
assert(dryRun.decisionBasis === "freeze-active", "dry-run must expose decisionBasis");
assert(dryRun.externalRevision === "R2", "dry-run must expose externalRevision");
process.stdout.write("saffron dry-run verification passed\n");
