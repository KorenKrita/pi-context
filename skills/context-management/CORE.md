# ACM CORE (草根版)

<!-- ACM:CORE:START -->
## Context Management Tools

You have three tools to manage your own conversation context. They are normal tools — use them on your own whenever they help.

**The problem they solve:** long sessions fill up with stale logs, old diffs, and finished exploration. That old text slows you down and wastes the window. These tools let you save restore points, inspect the session, and fold finished work into a short summary. Nothing is ever lost — all old history stays in the session tree and can be recovered.

### The three tools

1. **`acm_checkpoint`** — save a named restore point at the current position. Free and instant; changes nothing. Do it before risky operations, before reading a lot of material you may later fold away, or when you reach a good stable state.

2. **`acm_timeline`** — look at the session: what's in context now (`active`), your saved checkpoints (`checkpoints`), search old history (`search`), or see the branch structure (`tree`). It also shows current token usage.

3. **`acm_travel`** — fold: jump back to an earlier point and replace everything after it with a short structured summary (the "handoff"). Context shrinks; the full old history stays in the tree, recoverable via checkpoint or node ID.

### When to fold

Fold when a chunk of history is **finished** and you can state its conclusions without re-reading it. Typical moments:

- You finished debugging/exploring and only the conclusion matters now.
- You read lots of files/logs and already extracted what you needed.
- A new user request only needs the results of previous work, not the process.

Do NOT fold work that is still in progress or half-understood — you'd just have to re-read it, which costs more than it saves.

Every tool result may end with a line like `[ctx 51% used · fold→22%]`: current context usage, and what usage would drop to if you folded the previous stretch. It's just a number, not an instruction.

### How to write the handoff

`acm_travel` takes 7 fields. Fill them so that a fresh agent reading only the handoff could continue the work:

```json
{
  "goal": "What we're trying to accomplish (including anything still owed to the user).",
  "state": "What's known, what's still uncertain, and the exact values/paths/names needed next.",
  "evidence": "File paths, commands, IDs that back up the state. 'none' if empty.",
  "external": "Files changed, commands run, systems touched. 'none' if empty.",
  "exclusions": "Approaches tried and ruled out, so they aren't retried. 'none' if empty.",
  "recover": "Checkpoint name or node ID to get the old history back. 'none' if empty.",
  "next": "The single concrete next action to take right now."
}
```

Keep exact file paths, function names, error messages, and numbers — they matter more than prose.

### After a fold

The tool result tells you whether it was applied. If applied, just continue with `next` — don't re-read the folded material to double-check; that defeats the purpose. Files, processes, and external systems are untouched by travel; only the conversation context changed.
<!-- ACM:CORE:END -->
