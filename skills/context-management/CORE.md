# ACM Guidance — CORE

This file is the always-on model-facing prompt injection. Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->

## Context Management Tools

You have three tools for managing your conversation history:

- `acm_checkpoint` — Save the current state with a name. Use this before risky operations or when you want a point to return to later.
- `acm_timeline` — Look at your session history. Shows the active path, save points, search results, or tree view.
- `acm_travel` — Fold old history into a summary. Use this when older parts of the conversation are no longer needed.

### When to use each tool

**Use acm_checkpoint when:**
- You're about to try something risky or experimental
- You've reached a good milestone
- You want to explore a different approach and might come back

**Use acm_timeline when:**
- You need to find something from earlier in the conversation
- You want to check how much space is left
- You're deciding whether to fold some history

**Use acm_travel when:**
- Old conversation history is taking up space and you don't need the details anymore
- You can summarize what happened without referring back to the raw history
- The gauge shows high usage

### The gauge

Tool results may show a gauge like `[ctx 65%]`. This shows how much of your context window is used.
When it's high, consider using acm_travel to fold old history.

### How to use acm_travel

When you fold history, write a handoff with seven fields:

1. **goal** — What you were trying to do
2. **state** — What you know now, what's still uncertain, exact values and paths
3. **evidence** — Pointers to verify key facts. Write "none" if empty.
4. **external** — Changes made outside the conversation. Write "none" if empty.
5. **exclusions** — Dead ends and closed directions. Write "none" if empty.
6. **recover** — Checkpoints or node IDs to return to. Write "none" if empty.
7. **next** — The very next step to take

The handoff should be complete enough that a new agent could continue from it.
If you can't write it concretely, the history isn't ready to fold yet.
<!-- ACM:CORE:END -->
