# ACM Design Principles

This documents the design rationale behind the context management tools.

## Core Idea

The conversation context is a working set, not a transcript. Old process that has been fully understood should be compressed into its conclusions. The raw history stays in the session tree for recovery.

## When to Fold

**The bar: extraction-complete.** You can fold when you can write the handoff without needing to look back. If writing it forces vagueness, you're not ready.

- Dead ends whose lesson is captured → fold
- Bulk reads already distilled into conclusions → fold  
- Mid-investigation with open hypotheses → keep live (or fold only the closed parts)

## The Gauge

A simple `[ctx N%]` on tool results. Shows working-budget pressure (min of window and 400K). Just a number — the model decides what to do with it.

- Odometer cadence: shows when integer percent changes
- No thresholds, no advice, no escalation
- ACM tool results are never decorated (they have their own usage info)
- Kill switch: `ACM_GAUGE_DISABLED=1`

## The Handoff

Seven fields: goal, state, evidence, external, exclusions, recover, next.

**Cold start test**: a fresh agent should be able to continue from the handoff alone.

## Travel Outcomes

- `applied` — mutation succeeded, handoff is authoritative
- `not_applied` — nothing changed, fix the issue and retry
- `indeterminate` — can't confirm either way, inspect before retrying

## Settlement

After a successful travel:
1. Provider delivery cuts over after the persisted tool result
2. Native AgentSession replacement waits for `agent_settled`
3. Context rebuild runs bounded retries (max 3)

## Checkpoint

- Labels a protocol-complete leaf (default: latest before the checkpoint call)
- Unique names, case-sensitive
- `root` is reserved for the first top-level entry
- One label per entry (host limitation)

## Timeline Views

- `active` — current message spine + HUD dashboard
- `checkpoints` — save points with projected summary depth
- `search` — full-tree search by label/ID/content
- `tree` — topology with branch ownership
