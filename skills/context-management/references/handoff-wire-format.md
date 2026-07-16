# Handoff Wire Format

Use this reference when a closed boundary is ready to fold and the semantic handoff must be serialized for `acm_travel`, or when travel rejects the handoff shape.

## Seven-slot wire format

Write each slot exactly once, in this order, with a non-empty value. Use `none` when a category has no content.

```text
Goal: <the outcome now being pursued; quote a newly arrived request if its original turn will leave the working set>
State: <authoritative conclusions, decisions, status, values, identifiers, and surviving fronts>
Evidence: <direct paths, commands, URLs, commits, errors, checkpoints, or node IDs>
External: <file, process, browser, remote, ticket, or other side effects that travel cannot inspect or roll back>
Exclusions: <superseded directions and constraints that must not be rediscovered>
Recover: <checkpoint, archive bookmark, or raw node that restores omitted detail>
NEXT: <one immediately executable action>
```

The runtime validates only this observable shape. It cannot prove that the handoff is authoritative, that the target precedes the boundary, that every active front survived, or that `NEXT` is executable.

## Cold-start review

Read the draft as a fresh agent:

- `Goal` and `State` identify one authoritative present rather than competing summaries.
- Every active or parked front has a compact status and a direct pointer.
- Every load-bearing claim can be checked through `Evidence` without archived conversation.
- `External` distinguishes observed side effects from assumptions; inspect them again after travel.
- `Exclusions` prevents dead directions from re-entering the working set.
- `Recover` reaches the omitted raw path.
- `NEXT` can run immediately without asking what happened earlier.

The handoff passes cold start only when all seven checks hold. A transcript-sized handoff has not closed the boundary; keep the active uncertainty live or split the boundary more narrowly.
