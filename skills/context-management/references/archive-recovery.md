# Archive Recovery

Use when you need to retrieve one specific detail from an archived branch and continue working on the current branch.

## Steps

1. Save a checkpoint on your current branch: `acm_checkpoint({ name: "return-point" })`
2. Travel to the archived branch using its checkpoint name or node ID
3. Find the detail you need
4. Travel back using the return-point as target

The detail goes in your handoff's `state` field when returning.
