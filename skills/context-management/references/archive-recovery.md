# Archive Recovery

Use this reference only when one exact value, wording, error, or decision must be rehydrated from an archived conversation branch and work must continue on the present summary branch.

## Rehydration round trip

Before leaving, record the current action and complete this round trip:

1. Create a unique `<front>-resume` save point on the current summary branch.
2. Travel to the archive pointer with a temporary handoff whose sole `NEXT` is the exact lookup and whose `Recover` names `<front>-resume`.
3. Keep the archive branch bounded to that lookup. Extract the required detail and its direct evidence pointer.
4. Make the return travel to `<front>-resume` the next tool call. Its handoff carries the extract, evidence, and original action.
5. Read the return result. Confirm the resolved target is `<front>-resume`, the expected summary leaf was applied, and refresh/live-sync states are either applied or explicitly pending with a recovery path. Pending is scheduled work, not success.
6. On the resumed branch, use the next timeline/context evidence to confirm the persistent rebuild and the reported live-sync outcome. An unavailable live sync is acceptable only when the persistent branch is authoritative and the result gives the reload path.
7. Resume the original action after branch identity and context state are checkable.

If either travel changes the observable condition to a failure or indeterminate mutation, return to the Skill router and replace this reference with Exceptional Recovery. Branch identity comes from the result and timeline, never from intent.

## Archive drift

**Archive drift** means recovering a detail and then continuing ordinary work on the archive branch by accident. Prevent it with three invariants:

- the archive handoff contains one bounded lookup;
- the recovered detail returns to `<front>-resume` immediately;
- the return result establishes the summary branch before ordinary work resumes.

Stay on the archive branch only when it intentionally becomes the new working set. State that transition and preserve a recovery pointer to the abandoned branch.
