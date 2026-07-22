import { canStartRollout } from "../src/policy-order.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(canStartRollout({ planApproved: true, policyAcknowledged: false, freeze: false }) === false,
  "rollout must wait for policy acknowledgement");
assert(canStartRollout({ planApproved: true, policyAcknowledged: true, freeze: false }) === true,
  "approved plan plus policy acknowledgement must permit rollout");
assert(canStartRollout({ planApproved: true, policyAcknowledged: true, freeze: true }) === false,
  "a release freeze must block rollout");

process.stdout.write("saffron policy-order verification passed\n");
