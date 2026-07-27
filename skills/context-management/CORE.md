# ACM — Context Management Guide

## Context Management Tools

You have three tools for managing conversation context:

- **acm_checkpoint** — Save a named bookmark at the current point so you can return later.
- **acm_timeline** — View session structure: what's active, what's saved, usage stats.
- **acm_travel** — Compress old conversation into a handoff summary and continue from a clean point.

### When to save a checkpoint

Before risky operations, before large file reads you might fold away later, at good stopping points. Checkpoints are cheap and never change anything.

### When to travel (fold)

Travel when you've finished a chunk of work and can summarize what you learned. The bar: can you write a handoff that a fresh agent could continue from? If yes, fold.

### The handoff

Travel takes a structured handoff with 7 fields: goal, state, evidence, external, exclusions, recover, next. All must be filled; use "none" for empty supporting fields.

### After travel

Execute `next` directly. The handoff is your new working state. Don't re-derive what it already settled.
