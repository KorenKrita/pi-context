# Handoff Wire Format

Use this reference when a coherent representation update is ready to commit through `acm_travel`, when the hot set or faithful uncertainty must survive, or when travel rejects the handoff shape.

## Seven-slot wire format

Write each slot exactly once, in this order, with a non-empty value. Use `none` when a category has no content.

```text
Goal: <the outcome being pursued; quote a newly arrived request if its original turn will leave the working set>
State: <the authoritative representation: knowns, unknowns, hypotheses, attribution, constraints, hot details, discriminators, status, identifiers, and surviving fronts>
Evidence: <direct paths, commands, URLs, commits, errors, checkpoints, node IDs, baselines, or deltas>
External: <file, process, browser, remote, ticket, or other side effects that travel cannot inspect or roll back>
Exclusions: <superseded directions and constraints that must not be rediscovered>
Recover: <checkpoint, archive bookmark, or raw node that restores omitted precision>
NEXT: <one immediately executable action or discriminator>
```

The runtime validates only this observable shape. It cannot prove that the representation is authoritative, that the target precedes the compression seam, that every hot detail and front survived, or that `NEXT` is executable.

## Continuation-fidelity review

Read the draft as a fresh agent:

- `Goal` and `State` establish one authoritative present rather than competing recaps.
- `State` represents uncertainty faithfully: knowns remain known, unknowns remain unknown, and competing hypotheses retain their attribution and discriminator.
- Exact detail with high near-term reuse stays in the hot set; integrated process becomes a smaller representation.
- Every active or parked front has a compact status and a direct pointer.
- Every load-bearing claim can be checked through `Evidence` without replaying archived conversation.
- `External` distinguishes observed side effects from assumptions; inspect material effects again after travel.
- `Exclusions` prevents dead directions from re-entering the working set.
- `Recover` reaches the omitted raw path when precise rehydration is needed.
- `NEXT` can run immediately and continue the current cognition without asking what happened earlier.

The handoff has continuation fidelity when all nine checks hold. Its size is justified by the hot set and surviving state, while its attention gain is durable enough to amortize travel. A handoff that drops attribution or triggers immediate rereading has compressed the wrong information; revise the representation or carry the missing hot detail.
