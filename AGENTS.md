# AGENTS.md - pi-context

## What This Is

**pi-context** is a Pi extension that gives agents three tools to manage their conversation context:

| Tool | What it does |
|------|-------------|
| `acm_checkpoint` | Save a named recovery point |
| `acm_timeline` | View session structure, usage, and checkpoints |
| `acm_travel` | Compress old history into a handoff and continue |

## Tech Stack

- TypeScript ESM, strict mode
- Source-first: Pi loads `src/*.ts` directly, no build step
- Tool schemas use `@earendil-works/pi-ai` TypeBox `Type.*`
- Pi dependencies pinned to **`0.82.1`**
- Tests: Bun

## Architecture

```
src/index.ts              — Composition root (register tools + lifecycle)
src/checkpoint-tool.ts    — Checkpoint tool
src/timeline-tool.ts      — Timeline tool  
src/travel-tool.ts        — Travel tool
src/handoff.ts            — Handoff schema + validation
src/context-packet.ts     — Message reconstruction for provider delivery
src/travel-coordinator.ts — Backup → branch → verify → compensate
src/host-bridge.ts        — SessionManager mutation (the only place)
src/runtime.ts            — Per-session state (refresh, gauge, sync)
src/runtime-lifecycle.ts  — Event handlers (tool_result, agent_settled, context, etc.)
src/context-gauge.ts      — Simple [ctx N%] indicator on tool results
src/context-pressure.ts   — Working budget (min(window, 400K)) calculation
src/live-agent-session-adapter.ts — Native AgentSession replacement at settled boundaries
src/fold-estimate.ts      — Fold projection estimation (used by checkpoint/timeline)
src/boundary-ledger.ts    — Passive append-only request/fold counter
src/generated-guidance.ts — Generated from skills/context-management/ (don't edit directly)
```

## Key Rules

- All SessionManager mutations go through `src/host-bridge.ts`
- Travel results are: `applied`, `not_applied`, or `indeterminate`
- Native AgentSession replacement only happens at `agent_settled` (not during the active run)
- The gauge is just numbers — no wording, no thresholds, no advice
- `bun run generate:guidance` regenerates `src/generated-guidance.ts` from the skills/ markdown

## Commands

```bash
bun test                    # Unit tests
bun run generate:guidance   # Regenerate guidance from markdown
bun run typecheck           # TypeScript check
bun run verify:acm          # Full gate (guidance + tests + typecheck + host-fixture)

# Host fixture (tests against real Pi 0.82.1):
cd test/host-fixture
bun install --frozen-lockfile
bun ./build-source.mjs
bun test
```

## Guidance System

The model-facing text comes from:
- `skills/context-management/CORE.md` → injected into system prompt
- `skills/context-management/TOOL-CONTRACTS.md` → tool descriptions, cues, recovery text

Both are compiled to `src/generated-guidance.ts` by the generate script. Edit the markdown, then run `bun run generate:guidance`.
