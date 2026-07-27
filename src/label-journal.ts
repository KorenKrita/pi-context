import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface LabelMaps {
  labelToEntryId: Map<string, string>;
  entryToLabel: Map<string, string>;
}

/** Replay the label journal into the host's single-label, case-sensitive index. */
export function buildLabelMaps(entries: SessionEntry[]): LabelMaps {
  const labelToEntryId = new Map<string, string>();
  const entryToLabel = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    const { targetId, label } = entry;
    const previousLabel = entryToLabel.get(targetId);
    if (!label) {
      if (previousLabel !== undefined) labelToEntryId.delete(previousLabel);
      entryToLabel.delete(targetId);
      continue;
    }

    if (previousLabel !== undefined && previousLabel !== label) labelToEntryId.delete(previousLabel);
    const previousOwner = labelToEntryId.get(label);
    if (previousOwner !== undefined && previousOwner !== targetId) entryToLabel.delete(previousOwner);

    labelToEntryId.set(label, targetId);
    entryToLabel.set(targetId, label);
  }
  return { labelToEntryId, entryToLabel };
}
