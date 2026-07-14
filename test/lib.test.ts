import { describe, expect, test } from "bun:test";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { resolveTargetId } from "../src/lib.js";

function userEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello", timestamp: 0 },
  } as SessionEntry;
}

function node(entry: SessionEntry, children: SessionTreeNode[] = []): SessionTreeNode {
  return { entry, children };
}

describe("resolveTargetId", () => {
  test("marks the structural root off-path when the active branch starts at another top-level root", () => {
    const firstRoot = userEntry("root-a", null);
    const activeRoot = userEntry("root-b", null);
    const view = {
      getEntries: () => [firstRoot, activeRoot],
      getBranch: () => [activeRoot],
    };

    expect(resolveTargetId(view, [node(firstRoot), node(activeRoot)], "root")).toEqual({
      id: "root-a",
      fromOffPath: true,
    });
  });
});
