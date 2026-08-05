"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { anthropicToOpenAiRequest } = require("../lib/anthropic-format");

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
