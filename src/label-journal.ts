import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface LabelMaps {
  labelToEntryId: Map<string, string>;
  entryToLabel: Map<string, string>;
}

/** 实现说明：该处维护既有的结构、状态与错误处理契约。 */
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
