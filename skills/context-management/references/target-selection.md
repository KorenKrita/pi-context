# Advanced Target Selection

Use this reference only after CORE judgment says a fold or rebase is worthwhile and the correct target is still ambiguous. CORE remains authoritative for whether to travel and what the handoff must contain.

## Rebase base selection

When summaries stack or compete and the earliest safe base is unclear:

1. Inventory every surviving item: hot details, active and parked fronts, open unknowns, invariants, external effects, and recovery pointers.
2. Collect candidate bases from root, save points, and verified raw pre-fold nodes. Keep only candidates on the intended branch, deduplicate them, then sort by actual ancestor order from earliest to latest; labels suggest candidates, tree topology orders them.
3. Apply structural replacement. The candidate must precede at least one active `branch_summary` that will leave the spine, and projected summary depth must not grow. Equal depth is valid only when an old summary is replaced by the new authoritative handoff.
4. Apply cold start. `NEXT` must be immediately executable; every surviving item must live in the handoff or a usable direct pointer; ordinary continuation must not require an archived summary.
5. Choose the first candidate that passes both criteria. Usage and message deltas are supporting evidence, not substitutes for structural replacement or cold start.
6. If none passes, keep the needed detail live or use a narrower local fold. A transcript-sized handoff or a target after every active summary means the rebase is not ready.

Root is the earliest structural candidate, not the presumed answer. Selection is complete only when the chosen base passes both criteria and every surviving item has one authoritative home.

## Interleaved fronts

1. List each front as active, parked, or complete.
2. Name the one front whose history is being folded.
3. Search for that front's pre-fold save point or raw node; reject newer anchors owned by another front.
4. Keep one global next action. Preserve every surviving parked front as a compact status plus a recovery pointer.
5. Use an older shared anchor or `root` only when the handoff can carry a complete, small capsule for every front that must survive.

A target is invalid when reaching it would remove an unrecorded decision, hot detail, constraint, open unknown, or recovery pointer from another live front.

## Older or missing anchors

Prefer the save point immediately before the material being folded, even when a newer one exists elsewhere. If no save point fits:

1. Inspect `acm_timeline`; on a large tree, narrow with checkpoint listing or search before requesting the full tree.
2. Identify the last clean node before the material being folded.
3. Verify that the node is outside that material and that the handoff preserves everything created after it that must survive.
4. Use the raw node ID as the travel target.

Missing labels do not block a fold; an unverifiable target does.

## Raw node fallback

A raw node is appropriate only when all of these are checkable:

- its ID came from the current timeline result;
- it precedes the material being folded on the intended front;
- it does not belong to an interleaved front;
- the handoff preserves all state created after it that must survive.

If orientation remains uncertain, save the current meaningful state as a recovery pointer, narrow the timeline search, and identify the pre-fold node before traveling.

## Checkpoint-name collisions

Checkpoint labels are tree-wide and case-sensitive. When the desired semantic label already exists:

1. Keep the semantic base name.
2. Add the smallest meaningful scope, ordinal, or date that distinguishes the new state.
3. Search the resulting label before creating it.

Good disambiguations include `parser-fix-api-v2`, `release-validation-20260711`, and `sidebar-power-attempt-2`. Generic labels such as `checkpoint-2`, `new-start`, or `temp-done` are not recovery cues.
