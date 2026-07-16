# ACM Canonical Guidance

This file owns the always-on ACM doctrine. Runtime tool descriptions, prompt guidelines, result cues, and recovery text live in `TOOL-CONTRACTS.md`. Regenerate TypeScript with `bun run generate:guidance`.

<!-- ACM:CORE:START -->
## Agentic Context Management CORE

The CORE is the **way** (道): continuously improve the representation in the **working set**, and let tool mechanics follow that judgment.

### Compression is intelligence

A context window is a working set, not a transcript. Its job is to carry the most useful representation for the next stretch of reasoning: settled knowledge, faithful uncertainty, current constraints, the **hot set** of exact detail likely to be reused soon, and direct provenance for everything archived.

Compression is continuous; explicit **folding is batched**. Integrate observations as reasoning proceeds, then use travel when a coherent representation update offers durable attention gain. Cadence follows **representation change**, not action count, phase names, token thresholds, or a fixed tool sequence.

A **representation** is task-sufficient state: what is known, what remains unknown, competing hypotheses, attribution and evidence, constraints, external effects, excluded directions, parked fronts, and the next discriminator or action. Preserve **uncertainty fidelity**: compress unresolved work into an accurate model of the uncertainty instead of turning unknowns into conclusions or carrying the whole raw process.

An **evidence chain** preserves the measurements, baselines, deltas, causal links, and provenance that make attribution checkable. The representation may compress that chain into sufficient statistics and direct pointers; exact raw evidence belongs in the hot set only while near-term reasoning will reuse it.

### Recoverability and continuation

**Recoverability** makes compression and exploration reversible. A checkpoint preserves a return state whose recovery value has materially changed: a verified baseline, valuable fork, risky attempt entrance, parked front, or durable milestone. Checkpoint cadence follows **recoverability delta**, not every action. A checkpoint changes what can be recovered; its name does not classify workflow state or trigger a fold.

A **compression seam** is any point where the process behind it can be replaced by a better representation. It does not require a completed task, closed phase, or resolved uncertainty. A **handoff** crosses that seam through the seven-slot wire shell while carrying the hot set, faithful uncertainty, evidence pointers, external effects, exclusions, recovery, and one executable `NEXT`. It has **continuation fidelity** when a fresh agent can continue the current cognition from that representation and its direct pointers without rereading the folded process.

A tool call is a **request**; its matching result is the **receipt**. Plans, drafts, parameters, and assistant prose remain intent. Record operation fact only from the receipt: applied, not applied, or indeterminate. The agent owns ACM autonomously by default. An explicit user instruction that the next response or context transition must not travel temporarily suspends travel for that stated scope; checkpoint and timeline remain available.

### Compression cadence

Every explicit fold spends transition friction: tool latency, context reconstruction, possible cache disruption, another summary layer, and the risk of immediate rehydration. A useful fold earns that cost through attention gain that persists across the next stretch of work.

Use these judgments as one integrated compass:

- **Preserve** — checkpoint when the option value of returning to the current state materially increases.
- **Integrate** — continuously turn observations and process into knowns, unknowns, hypotheses, attribution, constraints, and discriminators.
- **Fold** — commit a coherent representation update when its durable attention gain can amortize the transition. Compress integrated process, carry the hot set, and preserve provenance for archived precision.
- **Rehydrate** — recover exact archived detail when the current representation cannot support a precise decision, then integrate only the resulting knowledge that improves the authoritative state.
- **Rebase** — when active handoffs repeat, compete, or split authority, replace obsolete layers with one representation that preserves every surviving front and passes continuation fidelity.
- **Verify** — read each matching receipt. After applied travel, treat the handoff as the working set and confirm the resolved target, recovery pointer, resulting summary, context synchronization, and external effects.

The two cadence failures are **sediment** and **thrash**. Sediment leaves replaceable process in the working set after a better representation exists. Thrash pays transition cost for tiny deltas, then immediately folds again, recalls, or rereads detail that should have stayed hot. Healthy cadence batches a semantic unit large enough to improve attention and stable enough to serve more than the next instant.

Context pressure, summary depth, new requests, agent fan-out, completed commands, rejected approaches, and final answers are observations about compression economics. They invite a representation check; none supplies a universal call count or scripted trajectory. Different models may choose different batch sizes while remaining sound when each fold has attribution integrity, continuation fidelity, recoverability, and durable attention yield.

### Target judgment

A travel target marks where the retained spine begins. **Anchor gravity** pulls toward the nearest label, the root, or the easiest candidate; resist it by naming the compression seam and selecting the last clean anchor before the process being replaced. For a rebase, choose the earliest candidate that retires competing representations without losing the hot set, surviving fronts, invariants, evidence chains, or continuation fidelity. Root is a candidate, never a default.
<!-- ACM:CORE:END -->
