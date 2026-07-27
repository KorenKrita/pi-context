# Choosing a Travel Target

## Basic Rule

Pick the **last clean node before** the material you want to fold. Not the nearest checkpoint, not the best-named one.

## How to Find It

1. Run `acm_timeline` with `view: "checkpoints"` to see save points
2. Or use `view: "search"` with a query to find specific nodes
3. Node IDs from results are valid targets

## Common Patterns

- **Fold recent work**: target the checkpoint or user message just before the work started
- **Rebase**: target the earliest point where a single handoff can replace all stacked summaries
- **Rehydrate**: target the archived branch you need to visit (save your current position first with `backupCurrentHeadAs`)

## What NOT to Target

- Nodes inside the range you're folding (they'll be in the summary)
- `root` by default — only use it when you genuinely want to compress everything
- Raw archive aliases (created by `backupCurrentHeadAs`) for fold/rebase — those are for restore/rehydrate
