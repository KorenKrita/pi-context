// Expanded cross-provider/model/effort behavior matrix.
// Live execution is opt-in through `bun eval/run-matrix.mjs --matrix ... --execute`.

const primaryScenarios = [
  "structured-handoff-continuation-and-skill",
  "advanced-pointer-routing",
  "unprompted-fold-on-pivot",
  "restraint-clean-new-cycle",
];

const effortScenarios = [
  "structured-handoff-continuation-and-skill",
  "pressure-keep-live-uncertainty",
];

const primaryModels = [
  ["gpt-sol-high", "local-responses/gpt-5.6-sol", "high"],
  ["claude-opus-high", "local-claude/claude-opus-4-8", "high"],
  ["glm-high", "local-openai/glm-5.2", "high"],
  ["deepseek-pro-high", "local-openai/deepseek-v4-pro", "high"],
  ["kimi-k3-max", "local-openai/kimi-k3", "max"],
  ["gpt-terra-high", "local-responses/gpt-5.6-terra", "high"],
  ["claude-sonnet-high", "local-claude/claude-sonnet-5", "high"],
  ["deepseek-flash-high", "local-openai/deepseek-v4-flash", "high"],
  ["gpt-mini-medium", "local-responses/gpt-5.4-mini", "medium"],
  ["claude-haiku-medium", "local-claude/claude-haiku-4-5", "medium"],
  ["gemini-flash-medium", "local-openai/gemini-3.5-flash", "medium"],
  ["mimo-medium", "local-openai/mimo-v2.5", "medium"],
];

const effortVariants = [
  ["gpt-sol-low", "local-responses/gpt-5.6-sol", "low"],
  ["gpt-sol-max", "local-responses/gpt-5.6-sol", "max"],
  ["deepseek-flash-off", "local-openai/deepseek-v4-flash", "off"],
  ["deepseek-flash-max", "local-openai/deepseek-v4-flash", "max"],
  ["gpt-mini-off", "local-responses/gpt-5.4-mini", "off"],
  ["gpt-mini-high", "local-responses/gpt-5.4-mini", "high"],
  ["claude-haiku-minimal", "local-claude/claude-haiku-4-5", "minimal"],
  ["claude-haiku-high", "local-claude/claude-haiku-4-5", "high"],
];

const environments = ["core-only", "product-isolated"];

export const matrix = {
  id: "acm-expanded-model-effort-v1",
  cells: [
    ...primaryModels.flatMap(([prefix, model, thinking]) => environments.map((environment) => ({
      id: `${prefix}-${environment}`,
      model,
      thinking,
      environment,
      scenarios: primaryScenarios,
      repeats: 1,
      experimentalVariable: "cross-model primary behavior coverage",
    }))),
    ...effortVariants.flatMap(([prefix, model, thinking]) => environments.map((environment) => ({
      id: `${prefix}-${environment}`,
      model,
      thinking,
      environment,
      scenarios: effortScenarios,
      repeats: 1,
      experimentalVariable: "within-family effort sensitivity and floor/ceiling stress",
    }))),
    ...[
      ["topology-sol", "local-responses/gpt-5.6-sol", "high"],
      ["topology-opus", "local-claude/claude-opus-4-8", "high"],
      ["topology-deepseek", "local-openai/deepseek-v4-flash", "high"],
      ["topology-kimi", "local-openai/kimi-k3", "max"],
    ].map(([id, model, thinking]) => ({
      id,
      model,
      thinking,
      environment: "product-isolated",
      scenarios: ["checkpoint-precise-recovery", "rehydrate-round-trip"],
      repeats: 1,
      experimentalVariable: "topology recovery and archive round-trip coverage",
      contextWindow: 100000,
    })),
  ],
};

export default matrix;
