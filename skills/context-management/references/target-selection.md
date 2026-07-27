# Picking a travel target

## Basic rule

Jump back to the last clean point BEFORE the material you want to fold away. Use `acm_timeline` (checkpoints or search view) to find candidates; a raw node ID works fine as a target if no checkpoint fits.

## Consolidating stacked summaries

If several fold summaries have piled up, you can merge them: pick an early point that sits before all of them, and write ONE handoff that carries everything still relevant (from all the summaries plus recent work). Checklist:

1. List everything that must survive: open questions, key values, side effects, recovery pointers.
2. Walk candidates from earliest to latest; pick the first one where your handoff can carry all of it.
3. If the handoff would have to be huge or vague, don't consolidate — keep working or do a smaller local fold.

'root' (the very beginning) is allowed but rarely the right answer.

## Multiple work streams in one session

If the session interleaves several tasks, fold only ONE task's history at a time. Pick a target that belongs to that task, and make sure the handoff preserves a short status + recovery pointer for every other task that's still alive. If a target would silently drop another task's state, it's the wrong target.

## Backup aliases (backupCurrentHeadAs)

A name created by `backupCurrentHeadAs` points at the full pre-fold history. Travel to it only to RESTORE old detail — doing so grows context. Never use it as a fold target.

## Name collisions

Checkpoint names are unique per session, case-sensitive. If a name is taken, keep the meaningful part and add a scope, number, or date: `parser-fix-2`, `release-check-0711`. Don't use generic names like `temp` or `checkpoint-2`.
