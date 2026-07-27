// ACM guidance strings — hand-edited for the simple branch.

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";

export const ACM_CORE = `## Context Management Tools

You have three tools for managing conversation context:

- **acm_checkpoint** — Save a named bookmark at the current point so you can return later.
- **acm_timeline** — View session structure: what's active, what's saved, usage stats.
- **acm_travel** — Compress old conversation into a handoff summary and continue from a clean point. The old history stays archived in the tree, always recoverable.

### When to save a checkpoint

Before risky operations, before large file reads you might fold away later, at good stopping points. Checkpoints are cheap and never change anything.

### When to travel (fold)

Travel when you've finished a chunk of work and can summarize what you learned. The bar: can you write a handoff that a fresh agent could continue from? If yes, fold. If you'd need to re-read the details right after, you're not ready — finish extracting first.

### The handoff

Travel takes a structured handoff with 7 fields. All must be filled; use "none" for empty supporting fields.

\`\`\`json
{
  "goal": "What you're trying to accomplish",
  "state": "What you know, what's uncertain, key files/values/identifiers",
  "evidence": "File paths, commands, IDs that back up your state (or 'none')",
  "external": "Files changed, processes started, side effects (or 'none')",
  "exclusions": "Dead ends, things not to repeat (or 'none')",
  "recover": "Checkpoint name to return to if needed (or 'none')",
  "next": "The exact next action — concrete and immediately executable"
}
\`\`\`

### After travel

Execute \`next\` directly. The handoff is your new working state. Don't re-derive what it already settled. If the tree holds something you need, search with acm_timeline or travel back to it.`;

export const TOOL_DESCRIPTIONS = {
  "checkpoint": "Save a named bookmark at a point in the session. Omit target to mark the latest completed message; pass a checkpoint name or node ID to mark an older point.",
  "timeline": "View session state. Views: active (current messages), checkpoints (saved bookmarks), search (find by name/ID/content), tree (full structure). Shows usage stats.",
  "travel": "Compress old conversation into a handoff summary and continue from a clean point. Provide a 7-field handoff (goal, state, evidence, external, exclusions, recover, next). Old history stays archived. Must run alone — no other tools in the same batch."
} as const;

export const PROMPT_SNIPPETS = {
  "checkpoint": "Save a named bookmark",
  "timeline": "View session structure and usage",
  "travel": "Compress history into a handoff and continue"
} as const;

export const PROMPT_GUIDELINES = {
  "checkpoint": "acm_checkpoint is cheap and safe. Use before risky steps or at natural boundaries.",
  "timeline": "Use acm_timeline to check usage and find saved points. Views: active, checkpoints, search, tree.",
  "travel": "acm_travel compresses history. Deliver any pending answer to the user first, then fold. The handoff's next field carries unfinished work forward."
} as const;

export const GUIDANCE_CUES = {
  "checkpoint": "Checkpoint saved. Context unchanged.",
  "travel": "Travel complete. Execute NEXT from the handoff directly.",
  "rebaseCheck": "Multiple summary layers — consider rebasing to an earlier point.",
  "advancedTargetPointer": "Target ambiguous. Use acm_timeline search or tree to find the right node.",
  "advancedExceptionalPointer": "Something went wrong. Check acm_timeline and retry.",
  "timelineActive": "Current messages. Fold old completed work to free space.",
  "timelineCheckpoints": "Saved bookmarks. Pick a travel target by what comes after it.",
  "timelineSearch": "Search full tree. Use node IDs from results as travel targets.",
  "timelineTree": "Full tree topology. Don't travel into the range you're folding."
} as const;

export const TREE_SUMMARY_INSTRUCTIONS = `Summarize this abandoned conversation branch as a handoff.

Write these seven fields, one per line:

Goal: what this branch was working on.
State: what was figured out, what's still uncertain. Include specific files and values.
Evidence: paths, commands, IDs that can be verified. Write 'none' if empty.
External: files changed, processes started. Write 'none' if empty.
Exclusions: things tried that failed — don't repeat. Write 'none' if empty.
Recover: checkpoint or node ID to return to. Write 'none' if empty.
NEXT: the one concrete action to resume with.

Keep exact file paths, function names, and numbers. Be concise.`;

export const RECOVERY_GUIDANCE = {
  "nameCollision": "That name already exists. Pick a different one (add a number or date).",
  "hostCapability": "Host capability unavailable. Cannot proceed.",
  "rollbackFailed": "Backup label remains in the tree. Note its ID before retrying.",
  "branchRolledBack": "Branch creation failed and was rolled back. Fix the issue before retrying.",
  "rollbackSkipped": "Auto rollback was unsafe. Check the backup pointer and active leaf manually.",
  "refreshPending": "Travel succeeded but context rebuild is pending. Summary entry is your fallback.",
  "restoredHistory": "Restored old branch. Execute NEXT. To return, use the recover pointer as travel target.",
  "refreshExhausted": "Context rebuild failed after retries. Reload and check timeline."
} as const;
