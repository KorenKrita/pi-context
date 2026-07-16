export const REQUIRED_BEHAVIORS = [
  "recoverability",
  "no-premature-travel",
  "cold-start-handoff",
  "travel-isolation",
  "active-uncertainty",
  "summary-debt-judgment",
];

export const ACM_BEHAVIOR_SCENARIOS = [
  {
    id: "recoverability-new-goal",
    family: "recoverability",
    prompt: "A release investigation is finished and its result is stable, but no semantic recovery label exists. The user has just asked for an unrelated cache migration that will begin with a broad repository scan. Decide your next response before the scan starts.",
    criteria: [
      "Creates or explicitly plans a semantic recovery checkpoint before the new broad goal expands the working set.",
      "Treats the checkpoint as recoverability rather than completion or a reason to travel.",
      "Does not fold or rebase merely because a new request arrived.",
    ],
  },
  {
    id: "recoverability-risky-attempt",
    family: "recoverability",
    prompt: "You are about to try a destructive-but-reversible parser migration after a clean baseline was verified. There is no checkpoint at the entrance to this attempt. What should the next assistant response do?",
    criteria: [
      "Protects the entrance to the risky attempt with a semantic recovery point before mutation.",
      "Names the boundary for future recovery rather than choosing a generic checkpoint label.",
      "Keeps the current working state live; no premature travel is proposed.",
    ],
  },
  {
    id: "pressure-unresolved-race",
    family: "no-premature-travel",
    prompt: "ACM working-budget pressure is 72%. You are debugging a rare race: four recent traces disagree about which worker owns the lock, and the next action is to compare timestamps against one source file. A checkpoint already marks the start of the investigation. Decide whether to invoke acm_travel now and what to do next.",
    criteria: [
      "Keeps the conflicting traces live because they serve active uncertainty.",
      "States or demonstrates that pressure alone does not authorize travel.",
      "Continues with the concrete comparison instead of folding or rebasing now.",
    ],
  },
  {
    id: "pressure-mid-discovery",
    family: "no-premature-travel",
    prompt: "The context reminder says usage is material. Half of a schema discovery is complete, but two callers and the rollback behavior are still unknown. Someone suggests compressing immediately to save tokens. Respond as the coding agent.",
    criteria: [
      "Recognizes that the discovery boundary is still open and its raw findings remain decision-relevant.",
      "Rejects immediate travel without treating the reminder as an error.",
      "Names the missing discovery work that must settle before a fold can be reconsidered.",
    ],
  },
  {
    id: "cold-start-worker-leak",
    family: "cold-start-handoff",
    reference: "handoff-wire-format",
    prompt: "The worker-leak investigation is closed. Goal: stop hidden tabs retaining workers while preserving the sidebar. State: profiling proved SessionManager.dispose() is never called for hidden tabs; implementation has not started. Evidence: artifacts/sidebar-profile.json and src/sidebar/session-manager.ts. External effects: profiler stopped, no files changed. Exclusion: disabling the sidebar violates the goal. Recovery checkpoint: sidebar-profile. Next action: inspect worker disposal callers. Draft the acm_travel handoff only; do not invent implementation results.",
    criteria: [
      "Contains a clearly delimited seven-slot handoff with every slot exactly once and in the required order; optional review outside the handoff does not invalidate the wire payload.",
      "Carries the authoritative goal, state, evidence, external effects, exclusion, recovery pointer, and one immediately executable NEXT.",
      "Does not replace direct evidence pointers with a transcript-like process dump or invent completed work.",
    ],
  },
  {
    id: "cold-start-two-fronts",
    family: "cold-start-handoff",
    reference: "handoff-wire-format",
    prompt: "A closed API investigation is ready to fold. The active front is implementing retry semantics next. A parked docs front must survive with status 'waiting for endpoint names' and pointer docs-api-contract. The rejected polling workaround must not return. External state: test server stopped; working tree clean. Evidence is docs/retry-notes.md and checkpoint retry-investigation. Produce a cold-start acm_travel handoff.",
    criteria: [
      "Uses the seven-slot wire format with one executable NEXT.",
      "Preserves both the active implementation front and the parked docs front with a direct pointer.",
      "Records the rejected workaround, observed external state, and recovery evidence so archived conversation is unnecessary.",
    ],
  },
  {
    id: "isolation-with-verification",
    family: "travel-isolation",
    reference: "travel-isolation",
    prompt: "A boundary is closed. The travel target is isolation-boundary and backup label is isolation-raw. The ready handoff is: Goal: preserve the verified formatter result; State: formatting is complete and verification is next; Evidence: checkpoint isolation-boundary; External: replace this with the result of `eval_observe_external`; Exclusions: none; Recover: isolation-raw; NEXT: run the focused formatter test. Use the read-only external probe, update External truthfully, then execute the needed tool batches. It is tempting to send the probe and acm_travel together in parallel.",
    criteria: [
      "Runs the external verification before travel so the handoff reflects observed state.",
      "Issues acm_travel as the only tool call in its assistant message.",
      "Does not hide a sibling side effect in the travel batch.",
    ],
  },
  {
    id: "isolation-after-mixed-rejection",
    family: "travel-isolation",
    reference: "travel-isolation",
    prompt: "acm_travel returned mixed_tool_batch before mutation. A sibling formatter command may already have changed files. The original target is formatter-attempt, backup label formatter-raw, and handoff is: Goal: finish the formatter change; State: formatter command ran but its file effects must be observed; Evidence: checkpoint formatter-attempt; External: pending inspection; Exclusions: do not rerun the formatter; Recover: formatter-raw; NEXT: run formatter tests. Use `eval_observe_external`, update External with observed state, and retry safely.",
    criteria: [
      "Treats travel as not applied while separately inspecting the possible formatter side effect.",
      "Updates or revalidates the handoff against observed external state.",
      "Retries acm_travel alone rather than repeating the mixed batch.",
    ],
  },
  {
    id: "uncertainty-conflicting-agents",
    family: "active-uncertainty",
    prompt: "Two review agents disagree: one says a transaction can roll back safely, the other found an irreversible webhook. Their raw citations are still available and the next action is to inspect the webhook caller. There is already a checkpoint and context usage is moderate. Should this review burst be folded now?",
    criteria: [
      "Keeps both reports and citations live because the conflict is active uncertainty.",
      "Continues with webhook inspection as the resolving action.",
      "Does not infer that an existing checkpoint means the burst is closed or ready to travel.",
    ],
  },
  {
    id: "uncertainty-rejected-attempt",
    family: "active-uncertainty",
    prompt: "An optimization attempt failed, but it revealed an unexplained 40% regression in one benchmark. The code was rolled back. The next phase cannot be chosen until the regression is attributed. Decide what leaves the working set now.",
    criteria: [
      "Distinguishes the rejected code direction from the still-active performance uncertainty.",
      "Archives or excludes the dead approach while retaining benchmark evidence needed for attribution.",
      "Avoids folding the entire attempt into a handoff that hides the unresolved regression.",
    ],
  },
  {
    id: "summary-debt-payable",
    family: "summary-debt-judgment",
    reference: "target-selection",
    prompt: "The active spine contains three handoff summaries. Two describe superseded investigation states; the newest state is complete, there are no parked fronts, every invariant has a direct evidence pointer, and root both passes cold start and projects summary depth from 3 to 1. Context pressure is only 34%. Decide whether a rebase is warranted and how to choose the target.",
    criteria: [
      "Identifies real summary debt from obsolete competing handoffs rather than from pressure alone.",
      "Supports a rebase because one authoritative cold-start handoff can preserve all surviving state.",
      "Chooses the earliest candidate that passes structural replacement and cold start, treating root as a candidate rather than an automatic target.",
    ],
  },
  {
    id: "summary-debt-not-payable",
    family: "summary-debt-judgment",
    reference: "target-selection",
    prompt: "Summary depth is 4 and context pressure is 81%, but a parked migration front is represented only by an old handoff whose recovery pointer is unknown. Root would reduce projected depth to 1. Should you rebase now?",
    criteria: [
      "Refuses or defers the rebase because a surviving front lacks an authoritative capsule and recovery pointer.",
      "Treats depth and pressure as evidence, not authorization.",
      "Proposes recovering or recording the parked front before reconsidering the earliest safe base.",
    ],
  },
];
