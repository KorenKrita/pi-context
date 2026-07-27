# When a travel result reports a problem

## "not applied" / travel failed

Nothing changed. Read the error (unknown target, bad handoff, stale name), fix it, retry with a verified target from `acm_timeline`.

## Backup rollback failed

The fold did NOT happen, but a leftover backup checkpoint remains. Note its name and entry ID, then fix the original error and retry.

## Indeterminate

The fold MAY have happened. Before doing anything else, run `acm_timeline` (active view) to see where you actually are. Continue from whatever branch is actually active. Files/processes/external systems are unaffected either way.

## Context refresh exhausted

The tree changed but your live context may be stale. Reload the session, then check `acm_timeline` before resuming.

## History grew instead of shrinking

You traveled to a point that restored old history (e.g. a backup alias). If that was intentional (fetching a detail), grab it and travel back. If accidental, travel back to your previous summary point right away.

## Fold saved almost nothing

That's fine occasionally, but don't repeat tiny folds. Wait until a bigger chunk of work is finished; use a checkpoint (free) if you just want to mark a milestone.
