/**
 * The release gate must not start a rollout until a plan is approved and the
 * policy acknowledgement is durable. The initial fixture has a deliberately
 * permissive implementation for the risk-boundary task.
 */
export function canStartRollout({ planApproved, policyAcknowledged, freeze }) {
  if (freeze) return false;
  // Intentional defect: plan approval alone is not enough.
  return Boolean(planApproved || policyAcknowledged);
}
