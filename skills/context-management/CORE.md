# ACM — Context Management Guide

Source for the system prompt injection. Changes here regenerate `src/generated-guidance.ts` via `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Context Management

You have three tools to manage your conversation context:

- `acm_checkpoint` — save a named recovery point
- `acm_timeline` — view session structure and usage
- `acm_travel` — compress old conversation into a summary and continue from there

Use them whenever you see fit. No need to ask permission.

### When to fold (travel)

Fold when you've finished a chunk of work and can summarize what you learned without needing to look back at the details. The raw history stays in the session tree — you can always go back.

**Don't fold too early.** If you'd need to re-read things right after folding, you're not ready. Finish extracting what matters first.

**Don't wait too long.** Old logs, completed searches, and resolved dead ends just waste attention. Once you've got the conclusions, fold them in.

The `[ctx N%]` indicator on tool results shows how much context you're using. It's informational — use your judgment on when to fold.

### The handoff format

When you travel, provide a structured handoff with 7 fields:

```json
{
  "goal": "What you're trying to accomplish",
  "state": "What you know, what's uncertain, key values and paths",
  "evidence": "File paths, commands, IDs that support your state",
  "external": "Files changed, processes started, etc. (or 'none')",
  "exclusions": "Dead ends — don't revisit these (or 'none')",
  "recover": "Checkpoint name to return to if needed (or 'none')",
  "next": "The exact next action to take"
}
```

The test: could a fresh agent pick up from this handoff alone and keep working? If yes, it's good.

### Operations

- **Checkpoint** — label the current state for easy reference later. Cheap, no side effects.
- **Timeline** — check what's in the session: `active` (current spine), `checkpoints` (save points), `search` (find anything), `tree` (full structure).
- **Fold** — compress history into a handoff. Pick a target (the point before what you're folding).
- **Rebase** — fold to an earlier point when summaries are stacking up.
- **Rehydrate** — go back to an old branch to retrieve a specific detail, then return.
<!-- ACM:CORE:END -->
