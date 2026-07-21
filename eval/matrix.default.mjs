// Broad evaluation declaration. `bun eval/run-matrix.mjs` previews this
// matrix by default; actual provider calls require `--execute`.
//
// The repetition is deliberately modest at declaration time. Increase it
// explicitly when a concrete question needs statistical power rather than
// accidentally paying for a large ambient run.

export const matrix = {
  id: "acm-generalization-v1",
  cells: [
    {
      id: "sol-core-medium",
      model: "local-responses/gpt-5.6-sol",
      thinking: "medium",
      environment: "core-only",
      scenarios: ["spontaneous-checkpoint-before-risk", "pressure-keep-live-uncertainty", "spontaneous-fold-after-distill"],
      repeats: 2,
      experimentalVariable: "CORE-only judgment at medium effort",
      note: "CORE-only judgment across non-identical activation shapes.",
    },
    {
      id: "sol-product-high",
      model: "local-responses/gpt-5.6-sol",
      thinking: "high",
      environment: "product-isolated",
      scenarios: ["directed-travel-handoff", "structured-handoff-continuation-and-skill", "advanced-pointer-routing"],
      repeats: 2,
      experimentalVariable: "product-isolated structured handoff plus advanced Skill",
      note: "Structured continuation and availability-gated advanced Skill path.",
    },
    {
      id: "deepseek-core-high",
      model: "local-openai/deepseek-v4-flash",
      thinking: "high",
      environment: "core-only",
      scenarios: ["directed-checkpoint", "spontaneous-checkpoint-before-risk", "pressure-keep-live-uncertainty"],
      repeats: 3,
      experimentalVariable: "weak-model CORE-only activation floor",
      note: "Mechanical lower-capability floor without unavailable Skill pointers.",
    },
    {
      id: "deepseek-product-high",
      model: "local-openai/deepseek-v4-flash",
      thinking: "high",
      environment: "product-isolated",
      scenarios: ["directed-travel-handoff", "structured-handoff-continuation-and-skill", "advanced-pointer-routing"],
      repeats: 3,
      experimentalVariable: "weak-model product continuation and advanced Skill",
      note: "Weak-model handoff, direct NEXT, and Skill discovery replication.",
    },
  ],
};

export default matrix;
