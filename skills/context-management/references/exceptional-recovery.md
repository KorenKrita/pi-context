# Exceptional Recovery

Use when an ACM travel result reports an error or unexpected state.

## Common failures

- **duplicate_name**: Pick a different checkpoint name.
- **target_not_found**: Use acm_timeline search to find the right node.
- **refreshPending**: Wait for context rebuild, use summary entry as fallback.
- **rollbackFailed**: Note the backup label ID before retrying.
- **branchRolledBack**: Fix the underlying issue before retrying.
- **refreshExhausted**: Reload session and check timeline.

Check acm_timeline for current state before any retry.
