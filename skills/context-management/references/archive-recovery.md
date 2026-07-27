# Getting a detail back from folded history

When you need one exact value/error/decision from history you already folded:

1. `acm_checkpoint` the current position first, e.g. `resume-here`.
2. `acm_travel` to the archive pointer (checkpoint or node ID from your handoff's recover field). Handoff: next = "look up X", recover = "resume-here".
3. Read the detail you came for. Don't do other work on the old branch.
4. Immediately `acm_travel` back to `resume-here`, carrying the detail in the new handoff.
5. If the return result says applied, continue your original work.

The common mistake is staying on the old branch and working there by accident. Grab the detail, go back. Stay only if you deliberately decide the old branch is the new working state — and say so.
