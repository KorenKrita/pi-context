import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

describe("ACM tool description contract", () => {
    test("describes checkpoints as structurally lightweight without claiming zero cost", () => {
        expect(source).toContain("Structurally lightweight: creates no branch or handoff and does not change the active context.");
        expect(source).not.toContain("Zero cost: no branch, no handoff, no context change.");
    });

    test("keeps task-end travel conditional on meaningful structural saving", () => {
        expect(source).toContain("when the preview shows meaningful structural saving");
        expect(source).toContain("if it shows almost no saving, create a unique '-done' checkpoint and answer directly");
        expect(source).toContain("Boundary decides whether folding is semantically appropriate; preview only measures savings.");
        expect(source).not.toContain("At task end, set backupCurrentHeadAs to '<task>-done', travel");
    });

    test("states the scope of checkpoint estimates and large-tree target discovery", () => {
        expect(source).toContain("displayed matching anchors when usage data is available; display limits still apply");
        expect(source).toContain("On large trees use acm_timeline with list_checkpoints or search");
        expect(source).toContain("Mode precedence: list_checkpoints > search > full_tree > default active path.");
    });

    test("keeps repository guidance aligned with the runtime wording", () => {
        expect(agents).toContain("Boundary decides whether folding is semantically appropriate; preview only measures savings.");
        expect(agents).toContain("preview 几乎无 saving 时只创建唯一的 `<task>-done` checkpoint 后直接回答");
    });
});
