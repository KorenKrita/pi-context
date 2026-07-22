import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

execFileSync(process.execPath, ["verify.mjs"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/verify-policy-order.mjs"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/verify-dry-run.mjs"], { cwd: root, stdio: "inherit" });

const controlPlane = JSON.parse(readFileSync(join(root, "fixtures", "control-plane.json"), "utf8"));
assert(controlPlane.revision === "R2", "delivery verification requires the later control-plane revision R2");
assert(controlPlane.freeze === true, "delivery verification expects the R2 release freeze");

const reconciliation = readFileSync(join(root, "release", "reconciliation.md"), "utf8");
assert(reconciliation.includes("R2"), "reconciliation must name the refreshed control-plane revision");
assert(reconciliation.includes(controlPlane.incidentNonce), "reconciliation must preserve the refreshed incident nonce");

for (const artifact of ["README.md", "docs/evidence-ledger.md", "release/legal-exceptions.md"]) {
  assert(existsSync(join(root, artifact)), `missing final artifact: ${artifact}`);
}
const decision = JSON.parse(readFileSync(join(root, "release", "go-no-go.json"), "utf8"));
assert(decision.externalRevision === "R2", "go/no-go decision must be based on R2");
assert(decision.decision === "hold", "the R2 release freeze requires a hold decision");
assert(
  decision.incidentNonce === controlPlane.incidentNonce,
  "go/no-go decision must preserve the current control-plane incident nonce/linkage",
);

process.stdout.write("saffron delivery verification passed\n");
