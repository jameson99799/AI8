"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const GptAllClient = require("../lib/gptall-client");

function createClient() {
    return new GptAllClient({
        authToken: "test-token",
        baseUrl: "https://gpt-all.chat/api",
        cookie: "fl_ua_key=abc%2Fdef",
        fingerprint: "89346554",
    });
}

test("GptAllClient requires an auth token", () => {
    assert.throws(() => new GptAllClient({ baseUrl: "https://gpt-all.chat/api" }), /AuthToken is required/);
});

test("fetchModels flattens modelMaps groups into a model list", async () => {
    const client = createClient();
    const payload = {
        code: 0,
        data: {
            modelMaps: {
                "1": [
                    { model: "doubao-seed-2.0-lite", modelName: "豆包Seed 2.0 Lite", modelType: 1, isToolSupported: true },
                    { model: "gpt-5.4-mini", modelName: "GPT-5.4 Mini", modelType: 1 },
                ],
                "2": [
                    { model: "deepseek-v4", modelName: "DeepSeek V4", modelType: 2 },
                ],
            },
        },
    };

    client._fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
    });

    const models = await client.fetchModels();
    assert.equal(models.length, 3);
    assert.equal(models[0].value, "doubao-seed-2.0-lite");
    assert.equal(models[1].label, "GPT-5.4 Mini");
    assert.equal(models[2].modelType, 2);
});

test("resolveModel matches full id and short name", async () => {
    const client = createClient();
    client.fetchModels = async () => [
        { value: "doubao-seed-2.0-lite", label: "豆包Seed 2.0 Lite", modelType: 1 },
        { value: "other/deepseek-v4", label: "DeepSeek V4", modelType: 1 },
    ];

    const exact = await client.resolveModel("doubao-seed-2.0-lite");
    assert.equal(exact.value, "doubao-seed-2.0-lite");

    const short = await client.resolveModel("deepseek-v4");
    assert.equal(short.value, "other/deepseek-v4");
});

test("resolveModel throws for unknown models and ambiguous short names", async () => {
    const client = createClient();
    client.fetchModels = async () => [
        { value: "a/deepseek-v4", modelType: 1 },
        { value: "b/deepseek-v4", modelType: 1 },
    ];

    await assert.rejects(() => client.resolveModel("deepseek-v4"), /ambiguous/i);
    await assert.rejects(() => client.resolveModel("nope"), /was not found/i);
});

test("streamChatCompletion extracts deltas from NDJSON and final answer from data.llm.response", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "doubao-seed-2.0-lite", label: "豆包Seed 2.0 Lite", modelType: 1 });

    const lines = [
        JSON.stringify({ status: 2, chatId: 1833059 }),
        JSON.stringify({ chatId: 1833059 }),
        JSON.stringify({ status: "starting" }),
        JSON.stringify({ content: [{ type: "text", text: "Under" }], text: "Under" }),
        JSON.stringify({ content: [{ type: "text", text: "stood" }], text: "stood" }),
        JSON.stringify({ agent_content: "", status: "completed", finishReason: "stop", totalTokens: 53 }),
        JSON.stringify({
            content: '{"llm":{"response":"Understood — the current time is **2026/08/04 12:00**."}}',
            reasoning_content: "",
            agent_content: "",
            finishReason: "success",
            chatId: 1833059,
            totalTokens: 53,
            data: {
                llm: { response: "Understood — the current time is **2026/08/04 12:00**." },
                content: '{"llm":{"response":"Understood — the current time is **2026/08/04 12:00**."}}',
            },
            text: '{"llm":{"response":"Understood — the current time is **2026/08/04 12:00**."}}',
            modelType: 1,
        }),
    ];

    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: ReadableStreamFromLines(lines),
        }
    );

    const streamedChunks = [];
    let finalRecord = null;

    const result = await client.streamChatCompletion(
        { model: "doubao-seed-2.0-lite", text: "What time is it?" },
        {
            onText(chunk) {
                streamedChunks.push(chunk);
            },
            onObject(record) {
                finalRecord = record;
            },
        }
    );

    assert.equal(streamedChunks.join(""), "Understood");
    assert.equal(result.chatId, 1833059);
    assert.ok(finalRecord);
    assert.equal(finalRecord.content, "Understood — the current time is **2026/08/04 12:00**.");
    assert.equal(result.record.content, "Understood — the current time is **2026/08/04 12:00**.");
});

test("streamChatCompletion emits error handler for malformed lines and keeps going", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "m", modelType: 1 });

    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: ReadableStreamFromLines([
                "not-json",
                JSON.stringify({ content: [{ type: "text", text: "hi" }], text: "hi" }),
                JSON.stringify({ content: "", finishReason: "success", data: { content: "{}", llm: { response: "hi" } } }),
                "",
            ]),
        }
    );

    const errors = [];
    const result = await client.streamChatCompletion(
        { model: "m", text: "x" },
        { onError(error) { errors.push(error); } }
    );

    assert.equal(errors.length, 1);
    assert.equal(result.record.content, "hi");
});

test("streamChatCompletion surfaces upstream business errors with code", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "m", modelType: 1 });

    mockGroupFlow(
        client,
        {
            ok: false,
            status: 429,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ code: 429, msg: "额度或次数已用尽" }),
        }
    );

    await assert.rejects(
        () => client.streamChatCompletion({ model: "m", text: "x" }),
        error => {
            assert.equal(error.status, 429);
            assert.match(error.message, /额度|次数/);
            return true;
        }
    );
});

test("requestJson returns data and normalizes non-zero business codes", async () => {
    const client = createClient();

    client._fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 401, msg: "授权登录已过期" }),
    });

    await assert.rejects(
        () => client.requestJson("/models/list"),
        error => {
            assert.equal(error.status, 401);
            return true;
        }
    );
});

test("streamChatCompletion flushes final line without trailing newline and extracts answer from workflow JSON content", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "doubao-seed-2.0-lite", label: "豆包Seed 2.0 Lite", modelType: 1 });

    const workflowFinal = JSON.stringify({
        metadata: { type: "final", workflowId: "intelligent-chat", status: "completed" },
        data: {
            toolExecutions: [],
            llm: { model: "doubao-seed-2.0-lite", response: "4", reasoning: "", executed: true },
            tokenUsage: { totalTokens: 467 },
        },
    });
    const lines = [
        JSON.stringify({ status: 2, chatId: 1833147 }),
        JSON.stringify({ status: "starting" }),
        JSON.stringify({ content: [{ type: "text", text: "How" }], text: "How" }),
        JSON.stringify({ finishReason: "stop", status: "completed" }),
    ];
    const bodyText = `${lines.join("\n")}\n${JSON.stringify({
        content: workflowFinal,
        reasoning_content: "",
        agent_content: "",
        finishReason: "stop",
        chatId: 1833147,
        totalTokens: 467,
        modelType: 1,
    })}`;

    const encoder = new TextEncoder();
    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(bodyText));
                    controller.close();
                },
            }),
        }
    );

    const chunks = [];
    let finalRecord = null;
    const result = await client.streamChatCompletion(
        { model: "doubao-seed-2.0-lite", text: "hi" },
        {
            onText(chunk) { chunks.push(chunk); },
            onObject(record) { finalRecord = record; },
        }
    );

    assert.equal(chunks.join(""), "How");
    assert.equal(result.chatId, 1833147);
    assert.equal(finalRecord.content, "4");
    assert.equal(finalRecord.totalTokens, 467);
});

test("streamChatCompletion marks fallback_failed records while keeping streamed text", async () => {
    const client = createClient();
    client.resolveModel = async () => ({ value: "m", modelType: 1 });

    const lines = [
        JSON.stringify({ content: [{ type: "text", text: "partial" }], text: "partial" }),
        JSON.stringify({
            content: "",
            reasoning_content: "",
            agent_content: "",
            finishReason: "fallback_failed",
            chatId: 999,
            fallbackReasonText: "模型额度或次数已用尽",
            data: { llm: { response: "" } },
            text: "",
            modelType: 1,
        }),
    ];

    const encoder = new TextEncoder();
    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: new ReadableStream({
                start(controller) {
                    for (const line of lines) {
                        controller.enqueue(encoder.encode(`${line}\n`));
                    }
                    controller.close();
                },
            }),
        }
    );

    const chunks = [];
    let finalRecord = null;
    const result = await client.streamChatCompletion(
        { model: "m", text: "x" },
        {
            onText(chunk) { chunks.push(chunk); },
            onObject(record) { finalRecord = record; },
        }
    );

    assert.equal(chunks.join(""), "partial");
    assert.equal(finalRecord.finishReason, "fallback_failed");
    assert.equal(finalRecord.fallbackReasonText, "模型额度或次数已用尽");
    assert.equal(finalRecord.content, "");
    assert.equal(result.record.finishReason, "fallback_failed");
});

function mockGroupFlow(client, chatResponse, capture = null) {
    const okJson = payload => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
    });
    client._fetch = async (path, options = {}) => {
        if (typeof path === "string" && path.includes("/group/create")) {
            return okJson({ code: 0, data: { id: 777 } });
        }
        if (typeof path === "string" && path.includes("/group/update")) {
            return okJson({ code: 200, data: true, success: true });
        }
        if (typeof path === "string" && path.includes("/group/del")) {
            if (capture) capture.deleted = options;
            return okJson({ code: 200, data: "删除成功", success: true });
        }
        if (typeof path === "string" && path.includes("/chatgpt/chat-process")) {
            if (capture) capture.chat = options;
            return chatResponse;
        }
        throw new Error("unexpected path: " + path);
    };
}

test("streamChatCompletion creates a group, sets the model, sends groupId, and deletes the group afterwards", async () => {
    const client = createClient();
    client.resolveModel = async () => ({
        value: "gemini-3.5-flash-low",
        label: "gemini-3.5-flash（免费）",
        modelName: "gemini-3.5-flash（免费）",
        modelType: 1,
    });

    const encoder = new TextEncoder();
    const lines = [
        JSON.stringify({ content: [{ type: "text", text: "4" }], text: "4" }),
        JSON.stringify({ content: "{}", finishReason: "success", chatId: 42, data: { content: "{}", llm: { response: "4" } } }),
    ];
    const capture = {};
    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: new ReadableStream({
                start(controller) {
                    for (const line of lines) {
                        controller.enqueue(encoder.encode(`${line}\n`));
                    }
                    controller.close();
                },
            }),
        },
        capture
    );

    const result = await client.streamChatCompletion({ model: "gemini-3.5-flash-low", text: "2+2?" }, {});

    const chatBody = capture.chat.body;
    assert.equal(chatBody.model, "gemini-3.5-flash-low");
    assert.equal(chatBody.modelName, "gemini-3.5-flash");
    assert.equal(chatBody.options.groupId, 777);
    assert.equal(chatBody.options.fileParsing, "");
    assert.equal(chatBody.extraParam.size, "auto");
    assert.equal(chatBody.usingPluginId, 0);
    assert.equal(chatBody.usingTool, false);
    assert.equal(result.groupId, 777);
    assert.equal(result.record.content, "4");
    assert.ok(capture.deleted, "group should be deleted after the response");
    assert.equal(capture.deleted.body.groupId, 777);
});

test("deleteGroupAfterResponse=false keeps the group", async () => {
    const client = createClient();
    client.deleteGroupAfterResponse = false;
    client.resolveModel = async () => ({ value: "m", modelType: 1 });

    const encoder = new TextEncoder();
    const capture = {};
    mockGroupFlow(
        client,
        {
            ok: true,
            status: 200,
            headers: { get: () => "application/octet-stream" },
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(`${JSON.stringify({ content: "{}", finishReason: "success", data: { content: "{}", llm: { response: "ok" } } })}\n`));
                    controller.close();
                },
            }),
        },
        capture
    );

    const result = await client.streamChatCompletion({ model: "m", text: "x" }, {});
    assert.equal(result.record.content, "ok");
    assert.equal(capture.deleted, undefined);
});

test("gpt-all newline parser consumes a long stream split across many chunks", async () => {
    const GptAllClient = require("../lib/gptall-client");
    const client = new GptAllClient({
        authToken: "tok",
        baseUrl: "https://gpt-all.chat/api",
        fingerprint: "1",
        defaultModel: "test-model",
        deleteGroupAfterResponse: false,
    });

    const lines = [];
    for (let i = 0; i < 1500; i += 1) {
        lines.push(JSON.stringify({ chatId: 7, text: `line${i}` }));
    }
    const bodyText = lines.join("\n") + "\n";

    const jsonHeaders = { get(name) { return String(name).toLowerCase() === "content-type" ? "application/json" : null; } };
    const streamHeaders = { get(name) { return String(name).toLowerCase() === "content-type" ? "text/event-stream" : null; } };

    function jsonResponse(payload) {
        return {
            ok: true,
            status: 200,
            headers: jsonHeaders,
            async json() { return payload; },
            async text() { return JSON.stringify(payload); },
        };
    }

    const streamResponse = {
        ok: true,
        status: 200,
        headers: streamHeaders,
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
    globalThis.fetch = async (url) => {
        const path = String(url.pathname || url);
        if (path.includes("/models/list")) {
            return jsonResponse({ code: 0, data: { modelMaps: { g: [{ model: "test-model", modelName: "test-model", modelType: 1 }] } } });
        }
        if (path.includes("/group/create")) {
            return jsonResponse({ code: 0, data: { id: 1 } });
        }
        if (path.includes("/group/update")) {
            return jsonResponse({ code: 0, data: {} });
        }
        return streamResponse;
    };
    try {
        const texts = [];
        await client.streamChatCompletion(
            { text: "hi", model: "test-model" },
            { onText(chunk) { texts.push(chunk); }, onDone() {} }
        );
        assert.equal(texts.length, 1500);
        assert.equal(texts[0], "line0");
        assert.equal(texts[1499], "line1499");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function ReadableStreamFromLines(lines) {
    const encoder = new TextEncoder();
    const chunks = lines.map(line => encoder.encode(`${line}\n`));
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
}
