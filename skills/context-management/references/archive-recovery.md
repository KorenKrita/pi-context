# Archive Recovery (Rehydrate)

## When to Use

You need a specific detail from a previously folded/abandoned branch.

## Steps

1. **Save current position**: `acm_checkpoint` with a name you can return to
2. **Travel to the archive**: `acm_travel` targeting the archived branch's checkpoint or node ID
3. **Get what you need**: read the handoff state, check a file path, get an exact value
4. **Return**: `acm_travel` back to your saved checkpoint, carrying the extracted detail in the handoff

## Key Points

- Use `backupCurrentHeadAs` on step 2 if you don't already have a checkpoint for your current position
- The return travel's `target` should be your saved checkpoint name
- Put the extracted detail in the return handoff's `state` field
- Keep it bounded — get one thing and come back
