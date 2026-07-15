# Advanced Target Selection

Use this reference only after CORE has established a fold boundary or rebase trigger and the correct target is still ambiguous. CORE remains authoritative for whether to fold or rebase and what the handoff must contain.

## Rebase base selection

When a rebase trigger is known but the earliest safe base is unclear:

1. Inventory every surviving item: active and parked fronts, unresolved invariants, external effects, and recovery pointers.
2. Collect candidate bases from root, chain/phase/attempt starts, and verified raw pre-boundary nodes. Keep only candidates on the intended branch, deduplicate them, then sort by actual ancestor order from earliest to latest; semantic labels suggest candidates, tree topology orders them.
3. Apply structural reset. The candidate must precede at least one active `branch_summary` that will leave the spine, and projected summary depth must not grow. Equal depth is valid only when an old summary is replaced by the new authoritative snapshot.
4. Apply **cold start** exactly as defined in CORE. Map every item from step 1 to the snapshot or one direct evidence pointer; any unmapped item fails the candidate.
5. Choose the first candidate that passes both criteria. Usage and message deltas are supporting evidence, not substitutes for structural reset or cold start.
6. If none passes, keep required detail live or use a local fold. A transcript-sized snapshot or a target after every active summary means rebase is not ready.

Root is the ideal earliest candidate, not the presumed answer. Selection is complete only when the chosen base passes both criteria and every surviving item has one authoritative home.

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
