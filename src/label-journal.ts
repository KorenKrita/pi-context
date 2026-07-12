import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface LabelMaps {
  labelToEntryId: Map<string, string>;
  entryToLabels: Map<string, string[]>;
}

/** Replay the label journal into the complete case-sensitive alias index. */
export function buildLabelMaps(entries: SessionEntry[]): LabelMaps {
  const labelToEntryId = new Map<string, string>();
  const entryToLabels = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    const { targetId, label } = entry;
    if (label === null || label === undefined) {
      const existingLabels = entryToLabels.get(targetId);
      if (existingLabels) for (const existing of existingLabels) labelToEntryId.delete(existing);
      entryToLabels.delete(targetId);
      continue;
    }
    const previousOwner = labelToEntryId.get(label);
    if (previousOwner && previousOwner !== targetId) {
      const previousLabels = entryToLabels.get(previousOwner);
      if (previousLabels) {
        const filtered = previousLabels.filter((existing) => existing !== label);
        if (filtered.length === 0) entryToLabels.delete(previousOwner);
        else entryToLabels.set(previousOwner, filtered);
      }
    }
    labelToEntryId.set(label, targetId);
    const existing = entryToLabels.get(targetId) ?? [];
    if (!existing.includes(label)) entryToLabels.set(targetId, [...existing, label]);
  }
  return { labelToEntryId, entryToLabels };
}
