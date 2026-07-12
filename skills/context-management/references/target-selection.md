# Advanced Target Selection

Use this reference only after CORE has established a fold boundary and the correct target is still ambiguous. CORE remains authoritative for whether to fold and what the handoff must contain.

## Interleaved fronts

1. List each front as active, parked, or complete.
2. Name the one front whose history is being folded.
3. Search for that front's pre-boundary checkpoint or raw node; reject newer anchors owned by another front.
4. Keep one global next action. Preserve every surviving parked front as a compact status plus a recovery pointer.
5. Use an older shared anchor or `root` only when the handoff can carry a complete, small capsule for every front that must survive.

A target is invalid when reaching it would remove an unrecorded decision, constraint, or recovery pointer from another live front.

## Older or missing anchors

Prefer the checkpoint immediately before the named boundary, even when a newer checkpoint exists elsewhere. If no checkpoint fits:

1. Inspect `acm_timeline`; on a large tree, narrow with checkpoint listing or search before requesting the full tree.
2. Identify the last clean node before the boundary begins.
3. Verify that the node is outside the material being folded and that the handoff preserves everything needed after it.
4. Use the raw node ID as the travel target.

Missing labels do not block a fold; an unverifiable target does.

## Raw node fallback

A raw node is appropriate only when all of these are checkable:

- its ID came from the current timeline result;
- it precedes the named boundary on the intended front;
- it does not belong to an interleaved front;
- the handoff preserves all state created after it that must survive.

If orientation remains uncertain, checkpoint the current meaningful state as a recovery pointer, narrow the timeline search, and do not travel until the pre-boundary node is identified.

## Checkpoint-name collisions

Checkpoint labels are tree-wide and case-sensitive. When the desired semantic label already exists:

1. Keep the semantic base name.
2. Add the smallest meaningful scope, ordinal, or date that distinguishes the new boundary.
3. Search the resulting label before creating it.

Good disambiguations include `parser-fix-api-v2-start`, `release-validation-20260711-start`, and `sidebar-power-investigation-2-start`. Generic labels such as `checkpoint-2`, `new-start`, or `temp-done` are not recovery cues.
