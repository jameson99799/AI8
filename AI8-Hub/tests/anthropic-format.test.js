"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { anthropicToOpenAiRequest, estimateInputTokens, openAiToAnthropicChunk, openAiToAnthropicResponse } = require("../lib/anthropic-format");

test("tool_use is converted to assistant tool_calls, never leaked into content", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-5-sonnet",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "What's the weather in Tokyo?" },
                ],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_01",
                        name: "get_weather",
                        input: { city: "Tokyo" },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_01",
                        content: "Sunny, 22C",
                    },
                ],
            },
        ],
    });

    const assistant = result.messages.find(m => m.role === "assistant");
    assert.ok(assistant, "assistant message present");
    assert.ok(Array.isArray(assistant.tool_calls), "assistant carries tool_calls");
    assert.equal(assistant.tool_calls[0].function.name, "get_weather");
    assert.equal(assistant.tool_calls[0].id, "toolu_01");
    // content must never contain the raw tool_use block
    const content = JSON.stringify(assistant.content);
    assert.ok(!content.includes("tool_use"), "assistant content must not leak tool_use blocks");
    assert.equal(assistant.content, "");

    const tool = result.messages.find(m => m.role === "tool");
    assert.ok(tool, "tool_result becomes a tool-role message");
    assert.equal(tool.tool_call_id, "toolu_01");
    assert.equal(tool.content, "Sunny, 22C");
});

test("assistant with text plus tool_use keeps text and tool_calls", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-5-sonnet",
        messages: [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me check." },
                    {
                        type: "tool_use",
                        id: "toolu_02",
                        name: "search",
                        input: { q: "hello" },
                    },
                ],
            },
        ],
    });

    const assistant = result.messages.find(m => m.role === "assistant");
    assert.equal(assistant.content, "Let me check.");
    assert.equal(assistant.tool_calls[0].function.name, "search");
});

test("plain string content and text-only array are unchanged", () => {
    const stringResult = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(stringResult.messages[0].content, "hi");

    const arrayResult = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    assert.equal(arrayResult.messages[0].content, "hello");
});

test("thinking.enabled is forwarded as metadata.ai8_thinking", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-7-sonnet",
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata.ai8_thinking, true);
});

test("metadata.ai8_thinking=false overrides thinking.enabled and persists", () => {
    const result = anthropicToOpenAiRequest({
        model: "claude-3-7-sonnet",
        thinking: { type: "enabled" },
        metadata: { ai8_thinking: false },
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata.ai8_thinking, false);
});

test("no thinking field leaves metadata untouched", () => {
    const result = anthropicToOpenAiRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.metadata, undefined);
});

test("streaming reasoning field (NVIDIA NIM) is converted to thinking block", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    const events = openAiToAnthropicChunk({
        model: "stepfun-ai/step-3.7-flash",
        choices: [{ index: 0, delta: { role: "assistant", reasoning: "让我想想" } }],
    }, state);

    assert.ok(Array.isArray(events));
    const start = events.find(e => e.type === "content_block_start");
    assert.ok(start, "content_block_start emitted");
    assert.equal(start.content_block.type, "thinking");
    const delta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.ok(delta, "thinking_delta emitted");
    assert.equal(delta.delta.thinking, "让我想想");
    assert.equal(state.inThink, true);
});

test("streaming reasoning_content field is honored too", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    const events = openAiToAnthropicChunk({
        model: "m",
        choices: [{ index: 0, delta: { reasoning_content: "推理A" } }],
    }, state);
    const delta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.equal(delta.delta.thinking, "推理A");
});

test("final chunk message reasoning is applied when delta carried no reasoning", () => {
    const state = { inThink: false, hasStartedText: false, currentIndex: 0 };
    openAiToAnthropicChunk({
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant" } }],
    }, state);

    const events = openAiToAnthropicChunk({
        choices: [{ index: 0, delta: {}, message: { reasoning: "完整思考", content: "正文来了" }, finish_reason: "stop" }],
    }, state);

    const thinkingDelta = events.find(e => e.type === "content_block_delta" && e.delta.type === "thinking_delta");
    assert.ok(thinkingDelta, "thinking_delta emitted from message.reasoning");
    assert.equal(thinkingDelta.delta.thinking, "完整思考");
    const textDelta = events.find(e => e.type === "content_block_delta" && e.delta.type === "text_delta");
    assert.ok(textDelta, "text_delta emitted from message.content");
    assert.equal(textDelta.delta.text, "正文来了");
});

test("non-streaming reasoning field (NVIDIA NIM) becomes a thinking block", () => {
    const converted = openAiToAnthropicResponse({
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", reasoning: "思考内容", content: "回答内容" }, finish_reason: "stop" }],
    });
    assert.equal(converted.content[0].type, "thinking");
    assert.equal(converted.content[0].thinking, "思考内容");
    assert.equal(converted.content[1].type, "text");
    assert.equal(converted.content[1].text, "回答内容");
});

test("estimateInputTokens counts latin text as chars/4", () => {
    const n = estimateInputTokens({ messages: [{ role: "user", content: "hello world how are you today" }] });
    assert.ok(n >= 1, "estimate is non-zero");
});

test("estimateInputTokens counts CJK characters as one token each", () => {
    const chineseOnly = estimateInputTokens({ messages: [{ role: "user", content: "你好世界" }] });
    assert.equal(chineseOnly, 4);
    const mixed = estimateInputTokens({
        system: "系统提示",
        messages: [
            { role: "user", content: [{ type: "text", text: "abcd" }] },
        ],
    });
    // 4 CJK + (1 newline + 4 ascii)/4 = ceil(4 + 1.25) = 6
    assert.equal(mixed, 6);
});

test("estimateInputTokens is at least 1 for empty bodies", () => {
    assert.equal(estimateInputTokens(), 1);
    assert.equal(estimateInputTokens({ messages: [] }), 1);
});

test("estimateInputTokens includes tool definitions", () => {
    const withTools = estimateInputTokens({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_weather", input: { city: "Tokyo" } }],
    });
    const withoutTools = estimateInputTokens({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(withTools > withoutTools, "tools contribute to the estimate");
});
