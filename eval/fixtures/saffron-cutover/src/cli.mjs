export function formatDryRun({ revision, ready }) {
  // Intentional defect: downstream operators need both the decision basis and
  // the external control-plane revision that supplied the decision.
  return JSON.stringify({ kind: "dry-run", revision, ready });
}
