# Agentic Context Management

Pi-context helps a coding agent continuously improve the representation in its live context while preserving precise recovery paths.

## Language

**Working set**:
The live, task-sufficient representation used for the next stretch of reasoning. It carries settled knowledge, faithful uncertainty, constraints, hot detail, and provenance rather than replaying the transcript.
_Avoid_: recent messages, full transcript

**Representation**:
The current model of the work: knowns, unknowns, competing hypotheses, attribution, constraints, external effects, excluded directions, parked fronts, and the next discriminator or action.
_Avoid_: summary text, progress recap

**Uncertainty fidelity**:
The property that unresolved questions remain accurately unresolved after compression, with hypotheses, evidence, attribution gaps, and discriminators intact.
_Avoid_: keeping all raw evidence live, guessing a conclusion

**Evidence chain**:
The measurements, baselines, deltas, causal links, and provenance that make attribution checkable. It may survive as sufficient statistics plus direct evidence pointers.
_Avoid_: result dump, unsupported conclusion

**Hot set**:
Exact detail likely to be reused in the next stretch of work. Carry it through a fold at low loss so the agent does not immediately reread what it just archived.
_Avoid_: every recent detail, all raw process

**Compression cadence**:
The rhythm of continuous cognitive compression and batched explicit folds. Cadence follows durable representation gain and recoverability value rather than action count or fixed phases.
_Avoid_: one-step-one-fold, global tool frequency

**Recoverability**:
The option to return to a valuable prior state or recover archived precision through a durable pointer.
_Avoid_: retaining everything live, backup alone

**Checkpoint**:
A semantic label attached to history when the value of a return state materially changes. It creates recoverability without changing the working set.
_Avoid_: workflow state, mandatory task marker, fold

**Receipt**:
The structured outcome attached to one matching tool request. The call expresses intent; the receipt reports applied, not applied, or indeterminate fact.
_Avoid_: assistant claim, parameters, planned action

**Compression seam**:
A point where the process behind an anchor can be replaced by a better representation. It may occur during unresolved work and does not require task or phase completion.
_Avoid_: closed boundary, checkpoint location

**Handoff**:
The authoritative representation that survives a fold through the seven-slot wire shell. It carries the hot set, faithful uncertainty, evidence pointers, external state, exclusions, recovery, and an executable next action.
_Avoid_: transcript digest, completion report

**Continuation fidelity**:
The standard that a fresh agent can continue the current cognition from the handoff and direct pointers without rereading the folded process.
_Avoid_: completed task, structurally valid only, cold-start finality

**Archive**:
Raw history intentionally moved off the active path and retained behind a recovery pointer.
_Avoid_: deleted history, authoritative handoff

**Fold**:
A recoverable context transition that commits one batched representation update at a compression seam.
_Avoid_: checkpoint, mandatory phase transition

**Rehydrate**:
Recover exact archived detail for a precise decision, then integrate the resulting knowledge back into the authoritative representation.
_Avoid_: resuming ordinary work on the archive branch

**Rebase**:
A fold that retires repeated or competing handoff layers into one authoritative representation at the earliest safe base.
_Avoid_: automatic root travel, token reset

**Representation competition**:
Ambiguity or duplicated authority created when handoff layers repeat, conflict, or leave fronts without one authoritative home. Summary depth is evidence, not the condition itself.
_Avoid_: context pressure, token count alone

**Sediment**:
Replaceable process left in the working set after a better representation exists.
_Avoid_: any long task, unresolved work

**Compression thrash**:
Repeated low-yield folds, recalls, or rereads caused by tiny representation deltas or failure to carry the hot set.
_Avoid_: all frequent folds, any rehydration

**Anchor gravity**:
The tendency to choose the nearest, root, or conveniently named history anchor instead of the last clean anchor before the process being replaced.
_Avoid_: recency as verdict

**Front**:
One coherent line of work that can be active, parked, or complete while other work continues in the same session.
_Avoid_: tool step, arbitrary task-list item
