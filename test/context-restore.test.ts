import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerACMExtension, { fixOrphanedToolUse } from "../src/index";
import { getMeaningfulSkipReason } from "../src/lib";

const text = (value: string) => [{ type: "text", text: value }];
const toolCall = (id: string) => ({
    type: "toolCall",
    id,
    name: "bash",
    arguments: {},
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function captureHandlers(): Map<string, Handler[]> {
    const handlers = new Map<string, Handler[]>();
    const pi = {
        on(name: string, handler: Handler) {
            const existing = handlers.get(name) ?? [];
            existing.push(handler);
            handlers.set(name, existing);
        },
        registerTool() {},
    };
    registerACMExtension(pi as unknown as ExtensionAPI);
    return handlers;
}

describe("fixOrphanedToolUse", () => {
    it("removes a function call output whose call_id has no preceding tool call", () => {
        const messages = [
            { role: "user", content: text("continue") },
            {
                role: "toolResult",
                toolCallId: "call_YWh6pS6GP3m24vypMGlZkZi7",
                toolName: "bash",
                content: text("orphaned output"),
            },
        ];

        const fixed = fixOrphanedToolUse(messages as Parameters<typeof fixOrphanedToolUse>[0]);
        expect(fixed).toEqual([{ role: "user", content: text("continue") }]);
        expect(messages).toHaveLength(2);
    });

    it("removes results for error assistants that Pi omits from the API request", () => {
        const messages = [
            {
                role: "assistant",
                stopReason: "error",
                content: [toolCall("call_error")],
            },
            {
                role: "toolResult",
                toolCallId: "call_error",
                toolName: "bash",
                content: text("output"),
            },
        ];

        const fixed = fixOrphanedToolUse(messages as Parameters<typeof fixOrphanedToolUse>[0]);
        expect(fixed).toHaveLength(1);
        expect(fixed[0]?.role).toBe("assistant");
        expect(messages).toHaveLength(2);
    });

    it("synthesizes an error result when a surviving tool call lost its output", () => {
        const messages = [
            {
                role: "assistant",
                stopReason: "toolUse",
                content: [toolCall("call_missing_output")],
            },
        ];

        const fixed = fixOrphanedToolUse(messages as Parameters<typeof fixOrphanedToolUse>[0]);
        expect(fixed).toHaveLength(2);
        expect(fixed[1]).toMatchObject({
            role: "toolResult",
            toolCallId: "call_missing_output",
            toolName: "bash",
            isError: true,
        });
    });
});

describe("meaningful entry sanitation", () => {
    it("defensively ignores malformed text blocks without throwing", () => {
        const entry = {
            type: "message",
            id: "assistant-malformed",
            message: { role: "assistant", content: [{ type: "text" }] },
        };

        expect(getMeaningfulSkipReason(entry as Parameters<typeof getMeaningfulSkipReason>[0])).toBe("empty_assistant");
    });
});

describe("restored session context sanitation", () => {
    it("removes a persisted travel tool result after session_start cleared pending state", async () => {
        const handlers = captureHandlers();
        const sessionStart = handlers.get("session_start")?.[0];
        const context = handlers.get("context")?.[0];
        expect(sessionStart).toBeDefined();
        expect(context).toBeDefined();

        const sessionManager = {};
        const ctx = { sessionManager };
        await sessionStart?.({ reason: "resume" }, ctx);

        const callId = "call_WuALCbwjVXJ6Z4O8toPpen9a";
        const messages = [
            {
                role: "branchSummary",
                summary: "Continue from the handoff branch",
            },
            {
                role: "toolResult",
                toolCallId: callId,
                toolName: "acm_travel",
                content: text("Travel complete"),
            },
            { role: "user", content: text("new request after restore") },
        ];

        const result = await context?.({ messages }, ctx);

        expect(result).toEqual({
            messages: [
                {
                    role: "branchSummary",
                    summary: "Continue from the handoff branch",
                },
                { role: "user", content: text("new request after restore") },
            ],
        });
    });
});
