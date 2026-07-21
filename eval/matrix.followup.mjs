// Focused follow-up for the expanded matrix.
//
// Re-runs only the cells whose first corrected pass was obscured by:
// - pressure/topology scorer calibration;
// - transient local provider connection failures.
//
// Execute serially to avoid conflating model behavior with the local gateway:
//   bun eval/run-matrix.mjs --matrix eval/matrix.followup.mjs --execute --concurrency 1

const environments = ["core-only", "product-isolated"];

const pressureVariants = [
  ["gpt-sol-low", "local-responses/gpt-5.6-sol", "low"],
  ["gpt-sol-max", "local-responses/gpt-5.6-sol", "max"],
  ["deepseek-flash-off", "local-openai/deepseek-v4-flash", "off"],
  ["deepseek-flash-max", "local-openai/deepseek-v4-flash", "max"],
  ["gpt-mini-off", "local-responses/gpt-5.4-mini", "off"],
  ["gpt-mini-high", "local-responses/gpt-5.4-mini", "high"],
  ["claude-haiku-minimal", "local-claude/claude-haiku-4-5", "minimal"],
  ["claude-haiku-high", "local-claude/claude-haiku-4-5", "high"],
];

const topologyVariants = [
  ["topology-sol", "local-responses/gpt-5.6-sol", "high"],
  ["topology-opus", "local-claude/claude-opus-4-8", "high"],
  ["topology-deepseek", "local-openai/deepseek-v4-flash", "high"],
  ["topology-kimi", "local-openai/kimi-k3", "max"],
];

export const matrix = {
  id: "acm-expanded-followup-v1",
  cells: [
    ...pressureVariants.flatMap(([prefix, model, thinking]) => environments.map((environment) => ({
      id: `${prefix}-${environment}-pressure-followup`,
      model,
      thinking,
      environment,
      scenarios: ["pressure-keep-live-uncertainty"],
      repeats: 1,
      experimentalVariable: "calibrated pressure-restraint outcome scoring",
    }))),
    ...topologyVariants.map(([id, model, thinking]) => ({
      id: `${id}-followup`,
      model,
      thinking,
      environment: "product-isolated",
      scenarios: ["checkpoint-precise-recovery", "rehydrate-round-trip"],
      repeats: 1,
      experimentalVariable: "calibrated topology timing and archive round-trip behavior",
      contextWindow: 100000,
    })),
    {
      id: "claude-opus-high-product-primary-retry",
      model: "local-claude/claude-opus-4-8",
      thinking: "high",
      environment: "product-isolated",
      scenarios: [
        "structured-handoff-continuation-and-skill",
        "advanced-pointer-routing",
        "unprompted-fold-on-pivot",
        "restraint-clean-new-cycle",
      ],
      repeats: 1,
      experimentalVariable: "serial retry after local gateway connection refusal",
    },
    {
      id: "gpt-sol-max-product-structured-retry",
      model: "local-responses/gpt-5.6-sol",
      thinking: "max",
      environment: "product-isolated",
      scenarios: ["structured-handoff-continuation-and-skill"],
      repeats: 1,
      experimentalVariable: "serial retry after local gateway connection refusal",
    },
  ],
};

export default matrix;
