import { canStartRollout } from "./policy-order.mjs";

export function buildRolloutPlan(input) {
  return {
    allowed: canStartRollout(input),
    sequence: ["plan", "policy acknowledgement", "rollout"],
  };
}
