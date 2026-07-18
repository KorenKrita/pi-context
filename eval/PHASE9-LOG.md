# Phase-9 Log — v4 validation: raised ceiling, new floor risk

## Why Phase-9 exists

Phase-8 + replication showed head (v3) wins on consistency but leaves two gaps:
opus's bimodal activation (1/3 zero-ACM) with universal file-backup substitution
(reco ≤ 1 in all 3 samples), and terra's stable-but-sparse nudge-responsive
folding. v4 (db756413) added three evidence-driven, purely additive lines to
CORE — no v3 doctrine sentence touched:

1. **Backup-channel disambiguation** (Save): "File backups protect the disk; a
   checkpoint protects this conversation — they never substitute for each
   other; a risky step deserves both."
2. **Fold self-check** (Fold): "Before traveling, answer in one line: what
   leaves the working set, what pointer recovers it, and what single action is
   NEXT."
3. **Two seam cues** (Cadence): "a final answer coming due — run a rebase
   check; an archived detail needed again — rehydrate".

Phase-9 validates v4 on 10 models (4 internalizers + luna + 5
non-internalizers), then replicates the two ambiguous internalizer cells
(sol, terra) twice more each. Same harness: full-env, 400K window, XL flow,
--timeout-scale 2, judge=opus-4.8 v1. Decision rules pre-registered before
replication: sol conservatism confirmed if ≥2/3 samples ≤2 folds; terra
regression confirmed if ≥2/3 samples task-degraded or churning.

## Results (14 runs; v3 baselines from Phase-8 + replication)

| model | v3 baseline | v4 | verdict |
|---|---|---|---|
| **luna** [max] | pressure-assisted folder, 2/3 | **3/3 — first perfect score in the series**: 5 travels (P1 pure-道 @34K), timing/reco/ceiling all 3 | ✅ big win |
| **glm** [high] | zero / save-only | **first-ever fold** (P10 @31.8%, nudge-responsive, rebase-to-root, handoff 3/3), 2/3 strong | ✅ win |
| **gpt-5.5** [medium] | fold P7 @14% pure-道, 3/3 | pure-道 double fold (P7 @20% + P11 rebase), zero nudges, 2/3 | ≈ core intact |
| **opus-4.8** [medium] | bimodal (2/3 fold P10, 1/3 zero) | fold P10 @32%, handoff 3/3, **reco still 1** (file backups at P3; hallucinated a checkpoint alias, self-corrected via timeline) | ≈ activated; reco unfixed |
| **kimi** [high] | intermittent | save-only, disciplined save-before-risk (8 ckpt), 2/3 mid | ≈ slight gain |
| **sol** [medium] | 6 travels pure-道 + rehydrate, 3/3 | rep1: 1 fold, 2/3 · rep2: 8 travels + 2 root rebases, 3/3 but **P13 folded instead of answering → task 2/3** · rep3: 5 travels + rehydrate, 3/3 | ≈ conservatism was noise; one task-degraded fold |
| **terra** [high] | stable nudge-responsive, 2/3 ×3, task 3/3 ×3 | rep1: P10 churn → task 2/3 · rep2: **3/3 perfect** (rebase-to-root, real restore from backup) · rep3: folded at red tests → task 2/3 | ⚠️ **regression confirmed** |
| **opus-4.6** / **mimo** / **dspro** | zero ACM | zero ACM (opus-4.6 peaked 23%, nudge never fired) | — immune, as theorized |

## Findings

1. **v4's ceiling gains are real.** Two of the three perfect scores in the
   entire series (luna, terra-rep2) landed under v4, plus glm's first fold and
   terra's reco/ceiling jumping to 3. The seam cues demonstrably landed:
   terra used the checkpoints view + projected depth to pick rebase targets;
   multiple models rebased at P11/P14 where v3 runs never did.
2. **v4's regression is real and pre-registered as confirmed.** terra: 2/3
   samples task-degraded (P10 churn; fold at red tests) vs 0/3 under v3.
   Across all v4 internalizer samples, 3/10 task-degraded vs 0/8 under v3.
   The failure shape is consistent: **folding while the current turn's
   obligation is unfulfilled** — red tests (terra-rep3), an unanswered user
   question (sol-rep2), mid-feature churn (terra-rep1).
3. **The mechanism is the fold self-check, not the cues.** The self-check
   ("what leaves, what pointer, what NEXT") is satisfiable mid-obligation —
   NEXT is always writable. It makes folding feel procedurally available at
   exactly the moments v3's doctrine made models pause. The two seam cues
   target *missed* moments (P13/P14) and show no pathology.
4. **The backup-channel line works on some models only.** terra now does
   checkpoint + file backup at every risk (reco 3); opus-4.8, gpt-5.5, sol
   still substitute file backups at P3 (reco ≤ 2). The user's AGENTS.md
   backup rule outweighs one CORE sentence for those models.
5. **Non-internalizers stay immune.** opus-4.6 (3rd zero), mimo, dspro all
   zero-ACM; kimi stays save-only. Text is confirmed again as the wrong lever
   for this group — they need the active signal (nudge), and at 400K the
   terse ones never reach 30%.
6. **sol's rep1 conservatism was noise** (rep2/rep3: 8 and 5 travels) —
   reinforcing the Phase-8 lesson that single cells don't convict.

## Verdict

**v4 as-is is a trade, not a strict improvement: keep the cues, fix the
self-check.** The regression vector is precisely "fold while the current
promise is unfulfilled". v4.1 candidate: extend the self-check with the
missing fourth condition, e.g. "…what single action is NEXT — and never fold
away an unfulfilled promise to the user (red tests, an unanswered question,
a half-landed change)". Validate v4.1 on terra ×3 + sol ×2 before adoption;
acceptance = task-degraded rate back to 0 with luna/glm gains retained.

## Artifacts

- v4 commit: `db756413` (CORE additions + regenerated guidance + length-guard
  6000→6500 with rationale in test)
- Runs: `eval/.runs/2026-07-18T02-17*-flow-*` (10 models, variant p9v4),
  `eval/.runs/2026-07-18T03-33*-flow-{gpt-5.6-sol,gpt-5.6-terra}-p60*`
  (replications, variants p9v4-r2/r3)
- Reproduce: `bun eval/run-flow.mjs --model <spec> --thinking <lvl> --variant p9v4 --full-env --context-window 400000 --flow exprlang-xl-flow --timeout-scale 2`
