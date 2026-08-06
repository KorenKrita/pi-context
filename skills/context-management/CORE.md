# ACM Canonical Guidance — CORE

This file is the always-on model-facing guidance (道 + 度). Tool descriptions, prompt metadata, result cues, and recovery text live in `TOOL-CONTRACTS.md` (术). Generated TypeScript must be refreshed with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Context Management

Your context window is a working set, not a transcript: it holds the best current representation of the task, not the history of how you reached it. Three tools keep it that way:

- **acm_checkpoint** — name the current conversation position so a later fold or travel can return to it. Instant, free, changes nothing.
- **acm_timeline** — view the working set, save points, and usage; search the whole tree, folded history included.
- **acm_travel** — fold: return to an earlier point and replace everything after it with a handoff. The replaced stretch leaves the working set but stays in the tree, and every fold records its own return ticket.

**The fold test — one question.** Can you write a concrete handoff for that stretch right now, without rereading it? Concrete → the stretch is ready to fold. Vague → keep working; it is not digested yet. Task length never enters the decision: you are always mid-task and cannot know how long it will get, so readiness comes from digestion alone. Typical ready points: a debugging phase that converged, a batch of files read and distilled, a plan settled and ready to execute, a search that keeps returning the same ground (the repeats confirmed what stands and what is ruled out — that is the conclusion), a stretch whose conclusions the new request needs but whose process it does not.

**The delivery moment.** A result ready to go out — a completion report, a phase conclusion, an answer — often makes the fold test cheap: writing it already did most of the separation of conclusions from process. Run the same one question on the stretch behind it before sending; concrete means the handoff carries everything the road ahead — follow-ups included — still needs from that stretch. Concrete → fold to where the stretch began: the prepared result — or the settled conclusions and basis needed to deliver it without rereading — go in `state`, and `next` is the single action "use `state` to deliver the prepared result to the user" — after an applied fold, follow `next`. Vague → deliver directly and continue. A direct answer with no stretch behind it just goes out.

**Opening a long stretch.** About to pile up raw material — a batch of files, a long investigation, a path that may not survive — set a checkpoint first, named for what you are about to do. That mark is where the stretch begins; when the conclusions are distilled — the same fold test — fold to it. When an attempt dies and what it ruled out is concrete without rereading, travel back to the mark carrying that in `exclusions` and any lasting side effects in `external` — only the conversation detail leaves the working set.

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

**The gauge.** Tool results end with a line like `[ctx 75% budget(400K) · 300K/1M window · boundary · 3pts · fold@turn→24% -38msg · fold@task→11% -92msg]` on a large window, or `[ctx 43% window · 86K/200K · boundary · 3pts · fold@turn→24% -38msg]` on a small one. The leading percentage names the scale it measures, and the fold projections read on that same scale; the raw used/window pair always reports absolute position against the physical window, the hard limit. `budget(400K)` is the span these tools are tuned for — attention quality degrades before a large window fills, so pressure reads against min(window, 400K). On large windows, the budget reading may pass 100%; that is an ordinary reading beyond the 400K span these tools are tuned for. The used/window figure names the hard limit. When the percentage is labeled `window`, it reads directly against that hard limit — 100% there is the wall. Then: the marker `boundary` on the first gauge reading of each user request; save points on this path; and two fold projections on the same scale as the leading percentage, each as remaining pressure followed by the message delta: `fold@turn` — fold to the point that opened the preceding stretch (the current request rides along in the handoff); `fold@task` — fold back to the earliest save point or, absent one, the first request. The line appears when a whole percentage point changes, and always on each request's first reading; a missing needle means it has no independent, estimable reference — the point does not exist yet, coincides with the other needle or the current position, or its projection could not be built this reading.

When `boundary` shows, a request has begun. The previous stretch, if one exists, just became history — a second look at what the delivery moment already asked: run the fold test on it before diving deep. Concrete → fold first and start light, carrying the current request and the conclusions it needs in the handoff. Vague → continue; deciding not to fold an undigested stretch is the test working, not a missed fold.

**Missing a folded detail?** Folded history is the first source for anything the session once knew. Search the timeline; when the result already contains the detail, use it directly. When fuller context is needed, travel to the archived branch, take it, and travel back.
<!-- ACM:CORE:END -->
