// Production-candidate matrix for the post-merge ACM optimization round.
//
// The rehydrate cells measure the exact remaining failure surface: navigating
// an existing archive/return pair without reusing either alias as a new backup.
// The regression cells keep the ordinary pivot and clean-cycle restraint
// contracts visible because backupCurrentHeadAs is part of every travel schema.

const rehydrateModels = [
  ["deepseek-flash", "local-openai/deepseek-v4-flash", "high", 6],
  ["gpt-mini", "local-responses/gpt-5.4-mini", "medium", 6],
  ["sol", "local-responses/gpt-5.6-sol", "high", 3],
  ["opus", "local-claude/claude-opus-4-8", "high", 3],
  ["haiku", "local-claude/claude-haiku-4-5", "medium", 3],
];

const regressionModels = [
  ["deepseek-flash", "local-openai/deepseek-v4-flash", "high", 2],
  ["gpt-mini", "local-responses/gpt-5.4-mini", "medium", 2],
  ["sol", "local-responses/gpt-5.6-sol", "high", 1],
  ["opus", "local-claude/claude-opus-4-8", "high", 1],
  ["haiku", "local-claude/claude-haiku-4-5", "medium", 1],
  ["gemini", "local-openai/gemini-3.5-flash", "medium", 1],
];

export const matrix = {
  id: "acm-rehydrate-pointer-production-v1",
  cells: [
    ...rehydrateModels.map(([id, model, thinking, repeats]) => ({
      id: `${id}-rehydrate`,
      model,
      thinking,
      environment: "product-isolated",
      scenarios: ["rehydrate-round-trip"],
      repeats,
      contextWindow: 100000,
      experimentalVariable: "production rehydrate pointer and origin-alias semantics",
    })),
    ...regressionModels.map(([id, model, thinking, repeats]) => ({
      id: `${id}-ordinary-regression`,
      model,
      thinking,
      environment: "product-isolated",
      scenarios: ["unprompted-fold-on-pivot", "restraint-clean-new-cycle"],
      repeats,
      experimentalVariable: "non-rehydrate behavior regression",
    })),
  ],
};

export default matrix;
