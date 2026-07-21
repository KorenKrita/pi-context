// Post-merge optimization matrix focused on the largest remaining behavioral
// gap: an unprompted task pivot should preserve recoverability, fold at the
// right boundary, and execute the new-front NEXT directly without making
// checkpoint/travel a clean-cycle ritual.

const models = [
  ["gpt-sol-high", "local-responses/gpt-5.6-sol", "high"],
  ["claude-opus-high", "local-claude/claude-opus-4-8", "high"],
  ["glm-high", "local-openai/glm-5.2", "high"],
  ["deepseek-pro-high", "local-openai/deepseek-v4-pro", "high"],
  ["gpt-terra-high", "local-responses/gpt-5.6-terra", "high"],
  ["claude-sonnet-high", "local-claude/claude-sonnet-5", "high"],
  ["deepseek-flash-high", "local-openai/deepseek-v4-flash", "high"],
  ["gpt-mini-medium", "local-responses/gpt-5.4-mini", "medium"],
  ["claude-haiku-medium", "local-claude/claude-haiku-4-5", "medium"],
  ["gemini-flash-medium", "local-openai/gemini-3.5-flash", "medium"],
  ["mimo-medium", "local-openai/mimo-v2.5", "medium"],
];

const environments = ["core-only", "product-isolated"];

export const matrix = {
  id: "acm-pivot-restraint-post-merge-v1",
  cells: models.flatMap(([prefix, model, thinking]) => environments.map((environment) => ({
    id: `${prefix}-${environment}`,
    model,
    thinking,
    environment,
    scenarios: ["unprompted-fold-on-pivot", "restraint-clean-new-cycle"],
    repeats: 2,
    experimentalVariable: "post-merge pivot activation versus clean-cycle restraint",
  }))),
};

export default matrix;
