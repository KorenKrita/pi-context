# Exceptional Recovery

## Travel Failed (not_applied)

The session tree is unchanged. Check the error message:
- **Target not found**: use `acm_timeline search` to find the correct node ID
- **Handoff validation failed**: fix the handoff fields and retry
- **Host capability error**: the Pi version may not support this operation

## Indeterminate Result

Can't confirm whether the mutation happened or not.
- Run `acm_timeline` to check the current state
- Look for the backup label if you used `backupCurrentHeadAs`
- Don't retry blindly — inspect first

## Context Rebuild Failed

Travel succeeded but the new context couldn't be reconstructed.
- The summary entry is in the tree as a fallback
- Try `acm_timeline` to verify the branch state
- If retries exhaust, reload the session

## Rollback Issues

- **Backup label stuck**: it's still in the tree — note the ID for manual recovery
- **Rollback skipped**: prior aliases made auto-cleanup unsafe — check the active leaf manually
