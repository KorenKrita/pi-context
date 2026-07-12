# Archive Recovery

Use this reference only when an exact value, wording, error, or decision must be recovered from an archived conversation branch and work must continue on the present summary branch.

## Archive recovery round trip

Before leaving, record the current action and complete this round trip:

1. Create a unique `<front>-resume` checkpoint on the current summary branch.
2. Travel to the archive pointer with a temporary handoff whose sole next action is the exact lookup. Include the `<front>-resume` checkpoint as the return target.
3. Extract only the required detail and its evidence pointer. Do not begin unrelated analysis or implementation on the archive branch.
4. Travel back to `<front>-resume` with a handoff that carries the extract, its evidence, and the original action.
5. Read the travel result. Confirm that the target is `<front>-resume`, that the structural effect matches a return to the summary branch, and that context synchronization or refresh succeeded.
6. Resume the original action only after those checks pass.

If either travel reports failure or leaves branch identity uncertain, stop. Inspect the result and timeline before doing more work; never guess which branch is active.

## Archive drift

**Archive drift** means recovering a detail and then continuing ordinary work on the archive branch by accident. Prevent it with three invariants:

- the archive handoff has one bounded lookup, not an implementation task;
- the recovered detail is carried back to `<front>-resume` immediately;
- no unrelated tool call runs until the return result confirms the summary branch.

Stay on the archive branch only when intentionally abandoning the summary branch. State that decision explicitly and preserve a recovery pointer to the abandoned branch.
