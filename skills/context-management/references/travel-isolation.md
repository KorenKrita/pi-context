# Travel Isolation

Use this reference when an `acm_travel` call is about to be issued, when other tool work is ready in parallel, or when travel reports `mixed_tool_batch`.

`acm_travel` mutates the session branch that contains its own assistant tool-call message. Run it as the only tool call in that assistant message. Finish independent reads, writes, commands, and external side effects first; then issue travel alone after the compression seam, target, handoff, and recovery pointer describe the observed state.

If a mixed batch is rejected, no travel mutation was attempted. Preserve any sibling side effects that may already have occurred, inspect them directly, and reissue only the isolated travel call when its handoff still represents the observed state.

Isolation is complete when the containing assistant message has one tool call, that call is `acm_travel`, and the matching receipt establishes the selected target, resulting summary leaf, backup outcome, context refresh, and live-sync state before ordinary work resumes.
