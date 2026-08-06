"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const AI8Client = require("../lib/ai8-client");

function createClient() {
    return new AI8Client({
        authToken: "test-token",
        baseUrl: "https://example.com/api",
    });
}

test("AI8 auth-expired business errors are normalized to 401 even when upstream HTTP status is 200", () => {
    const client = createClient();

    const error = client._normalizeError(
        {
            code: 1001,
            msg: "授权登陆已过期，请重新登陆",
        },
        200
    );

    assert.equal(error.status, 401);
    assert.equal(error.code, 1001);
    assert.equal(error.message, "授权登陆已过期，请重新登陆");
});

test("generic AI8 business errors on HTTP 200 are normalized to 502 and keep upstream payload", () => {
    const client = createClient();

    const error = client._normalizeError(
        {
            code: 3007,
            data: {
                reason: "upstream failed",
            },
            msg: "生成失败",
        },
        200
    );

    assert.equal(error.status, 502);
    assert.equal(error.code, 3007);
    assert.deepEqual(error.upstream, {
        code: 3007,
        data: {
            reason: "upstream failed",
        },
        msg: "生成失败",
    });
});

test("buildSessionUpdatePayload merges returned session with prompt patch", () => {
    const client = createClient();
    const payload = client.buildSessionUpdatePayload(
        {
            contextCount: 8,
            created: "2026-04-14 10:36:58",
            frequencyPenalty: 0,
            icon: "",
            id: 519673,
            localPlugins: null,
            maxToken: 0,
            mcp: [],
            model: "openai_chat::gpt-5.1",
            name: "新对话",
            plugins: null,
            presencePenalty: 0,
            prompt: "",
            rags: [],
            temperature: 0.7,
            topSort: 0,
            uid: 2491,
            updated: "2026-04-14 10:36:58",
            useAppId: 0,
        },
        {
            prompt: "assistant preset",
        }
    );

    assert.equal(payload.id, 519673);
    assert.equal(payload.prompt, "assistant preset");
    assert.equal(payload.model, "openai_chat::gpt-5.1");
    assert.equal(payload.contextCount, 8);
});

test("_splitThinkingChunk streams reasoning until </think> then switches to answer", () => {
    const client = createClient();
    const state = { mode: "answer", buffer: "", reasoning: "", text: "" };

    const open = client._splitThinkingChunk("<think> 首先", state);
    assert.equal(open.reasoning, "");
    assert.equal(open.text, "");
    assert.equal(state.mode, "reasoning");
    assert.equal(state.buffer, " 首先");

    const mid = client._splitThinkingChunk("，然后", state);
    assert.equal(mid.reasoning, "");
    assert.equal(state.mode, "reasoning");
    assert.equal(state.buffer, " 首先，然后");

    const close = client._splitThinkingChunk("\n</think>\n答案是", state);
    assert.equal(close.reasoning, " 首先，然后\n");
    assert.equal(close.text, "\n答案是");
    assert.equal(state.mode, "answer");
    assert.equal(state.reasoning, " 首先，然后\n");

    const after = client._splitThinkingChunk("2", state);
    assert.equal(after.reasoning, "");
    assert.equal(after.text, "2");
});

test("_splitThinkingChunk handles marker split across chunks", () => {
    const client = createClient();
    const state = { mode: "answer", buffer: "", reasoning: "", text: "" };

    const a = client._splitThinkingChunk("<think> think", state);
    assert.equal(a.reasoning, "");

    const b = client._splitThinkingChunk("ing</t", state);
    assert.equal(b.reasoning, " thin");

    const c = client._splitThinkingChunk("hink>\nanswer", state);
    assert.equal(c.reasoning, "king");
    assert.equal(c.text, "\nanswer");
    assert.equal(state.reasoning, " thinking");
    assert.equal(state.mode, "answer");
});

test("_normalizeThinkingRecord strips markers and attaches reasoning_content", () => {
    const client = createClient();
    const state = { mode: "answer", buffer: "", reasoning: "", text: "" };

    const normalized = client._normalizeThinkingRecord(
        {
            aiText: "<think> 推理内容\n</think>\n这是回答",
        },
        state
    );

    assert.equal(normalized.aiText, "\n这是回答");
    assert.equal(normalized.reasoning_content, " 推理内容\n");
});

test("_normalizeThinkingRecord keeps streamed reasoning when record has no aiText markers", () => {
    const client = createClient();
    const state = { mode: "answer", buffer: "", reasoning: "已流式的推理", text: "" };

    const normalized = client._normalizeThinkingRecord({ aiText: "纯回答" }, state);

    assert.equal(normalized.aiText, "纯回答");
    assert.equal(normalized.reasoning_content, "已流式的推理");
});

test("AI8 SSE parser consumes a long stream split across many chunks", async () => {
    const client = createClient();

    const events = [];
    for (let i = 0; i < 2000; i += 1) {
        events.push(`data: {"code":0,"data":"tok${i}"}\n\n`);
    }
    events.push("data: [DONE]\n\n");
    const bodyText = events.join("");

    const fakeHeaders = {
        get(name) {
            const lower = String(name).toLowerCase();
            if (lower === "content-type") return "text/event-stream";
            if (lower === "x-chat-task-id") return null;
            return null;
        },
    };
    const fakeResponse = {
        ok: true,
        status: 200,
        headers: fakeHeaders,
        body: new ReadableStream({
            start(controller) {
                const bytes = new TextEncoder().encode(bodyText);
                for (let i = 0; i < bytes.length; i += 3) {
                    controller.enqueue(bytes.subarray(i, i + 3));
                }
                controller.close();
            },
        }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse;
    try {
        const tokens = [];
        await client.streamChatCompletion(
            { text: "hi", sessionId: 1 },
            {
                onText(chunk) { tokens.push(chunk); },
                onDone() {},
            }
        );
        assert.equal(tokens.length, 2000);
        assert.equal(tokens[0], "tok0");
        assert.equal(tokens[1999], "tok1999");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
