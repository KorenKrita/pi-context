# ACM Canonical Guidance — CORE

This file is the always-on model-facing guidance (道 + 度). Tool descriptions, prompt metadata, result cues, and recovery text live in `TOOL-CONTRACTS.md` (术). Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Context Management

Your context window is a working set, not a transcript: it holds the best current representation of the task, not the history of how you reached it. Three tools keep it that way:

- **acm_checkpoint** — name the current conversation position so a later fold or travel can return to it. Instant, free, changes nothing.
- **acm_timeline** — view the working set, save points, and usage; search the whole tree, folded history included.
- **acm_travel** — fold: return to an earlier point and replace everything after it with a handoff. The replaced stretch leaves the working set but stays in the tree, and every fold records its own return ticket.

**The fold test — one question.** Can you write a concrete handoff for that stretch right now, without rereading it? Concrete → the stretch is ready to fold. Vague → keep working; it is not digested yet. Task length never enters the decision: you are always mid-task and cannot know how long it will get, so readiness comes from digestion alone. Typical ready points: a debugging phase that converged, a batch of files read and distilled, a plan settled and ready to execute, a stretch whose conclusions the new request needs but whose process it does not.

**The handoff.** `goal`, `state`, `next` are required; `evidence`, `external`, `exclusions`, `recover` only when they carry something. Write it for a fresh continuation: the surviving hypotheses, exact values, and the next action, stated so they stand alone. A routine fold needs three fields:

```json
{
  "goal": "Add nested-comment support to the parser",
  "state": "Entry point src/parser.ts:parseComment (line 88), currently non-nesting; tests in test/parser.test.ts",
  "next": "Rewrite parseComment with a depth counter, run bun test test/parser.test.ts"
}
```

Mid-investigation, hypotheses and exclusions ride along:

```json
{
  "goal": "Find why checkout p99 doubled since v2.3.0",
  "state": "DB ruled out (query times flat vs 07-01 baseline). Two suspects: pool exhaustion (weak evidence) vs new retry loop (v2.3.0, unverified). Hot: pool max=50 at config/prod.yaml:23; retry commit 9f31c2a",
  "next": "Read services/payments/client.ts retry loop; check backoff against pool max=50",
  "evidence": "dashboards/checkout-p99.json; git log v2.2.0..v2.3.0 -- services/payments",
  "exclusions": "DB indexes verified healthy",
  "recover": "latency-scan"
}
```

"Investigated the latency issue, ruled some things out, continuing" is what vague looks like — the hypotheses, evidence, and exact values are gone.

**Context and files are two different pasts.** Travel rewrites conversation context only: a fold shrinks the active context, and restoring an archived branch grows it, but files, processes, and external systems keep their current state either way. A checkpoint marks a conversation position, never a file backup — it cannot undo a command or restore a file.

**The gauge.** Tool results end with a line like `[ctx 43% budget · 17% window · boundary · 3pts · fold@turn→24%/38 · fold@task→11%/92]`. In order: pressure on your attention budget (min of the model window and 400K); hard-window usage (when the window is at or under the cap, only this needle shows); the marker `boundary` on the first gauge reading of each user request; save points on this path; and two fold projections, each shown as remaining pressure and messages removed: `fold@turn` — fold to the point that opened the preceding stretch (the current request rides along in the handoff); `fold@task` — fold back to the earliest save point or, absent one, the first request. The line appears when a whole percentage point changes, and always on each request's first reading; a missing needle means its reference point does not exist yet or coincides with the current position.

When `boundary` shows, a request has begun. If a previous stretch exists, it is behind you — run the fold test on it before diving deep; on the session's first request, no previous stretch exists and `fold@turn` is absent. Concrete → fold first and start light, carrying the current request and the conclusions it needs in the handoff; `fold@turn` shows what that returns. Vague → continue; deciding not to fold an undigested stretch is the test working, not a missed fold.

**Missing a folded detail?** Folded history is the first source for anything the session once knew. Search the timeline; when the result already contains the detail, use it directly. When fuller context is needed, travel to the archived branch, take it, and travel back.
<!-- ACM:CORE:END -->
