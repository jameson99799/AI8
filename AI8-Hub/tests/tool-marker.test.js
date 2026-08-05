"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildToolInstructionBlock,
    createToolStreamParser,
    parseToolCallsFromText,
    stripToolMarkers,
} = require("../lib/tool-marker");

const WEATHER_TOOLS = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "查询指定城市的天气",
            parameters: {
                type: "object",
                properties: {
                    city: { type: "string", description: "城市名" },
                },
                required: ["city"],
            },
        },
    },
];

test("buildToolInstructionBlock emits marker instructions with tool defs", () => {
    const block = buildToolInstructionBlock(WEATHER_TOOLS);

    assert.match(block, /<\|tool▁calls▁begin\|>/);
    assert.match(block, /<\|tool▁calls▁end\|>/);
    assert.match(block, /get_weather/);
    assert.match(block, /查询指定城市的天气/);

    const lines = block.split("\n");
    const defsIndex = lines.findIndex(line => line.includes("可用工具定义"));
    const defs = JSON.parse(lines[defsIndex + 1]);
    assert.equal(defs[0].type, "function");
    assert.equal(defs[0].function.name, "get_weather");
    assert.deepEqual(defs[0].function.parameters.required, ["city"]);
});

test("buildToolInstructionBlock returns empty string for empty input", () => {
    assert.equal(buildToolInstructionBlock([]), "");
    assert.equal(buildToolInstructionBlock(undefined), "");
    assert.equal(buildToolInstructionBlock([{ type: "none" }]), "");
});

test("streaming parser recognizes full format split across chunks", () => {
    const parser = createToolStreamParser();
    const chunks = [
        "根据天气信息回复用户。",
        "<|tool",
        "▁cal",
        "ls▁begin|>",
        '[{"name": "get_weather", "arguments": {"city": "北京"}}',
        ',{"name":"x","arguments":{}}]',
        "<|tool▁calls▁end|>",
        "今天北京晴天。",
    ];

    let text = "";
    let calls = [];
    for (const chunk of chunks) {
        const result = parser.processChunk(chunk);
        text += result.text;
        calls = calls.concat(result.calls);
    }

    assert.equal(text, "根据天气信息回复用户。今天北京晴天。");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].index, 0);
    assert.equal(calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "北京" });
    assert.equal(calls[1].function.name, "x");
    assert.equal(calls[1].index, 1);
});

test("streaming parser handles plain underscore variant without ▁", () => {
    const parser = createToolStreamParser();
    const chunk = "<|tool_calls_begin|>[{\"name\":\"a\",\"arguments\":{}}]<|tool_calls_end|>";
    const result = parser.processChunk(chunk);

    assert.equal(result.text, "");
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "a");
});

test("streaming parser handles <tool_use> variant", () => {
    const parser = createToolStreamParser();
    const result = parser.processChunk(
        '<tool_use>[{"name":"search","arguments":{"q":"hello"}}]</tool_use>extra'
    );

    assert.equal(result.text, "extra");
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "search");
});

test("streaming parser tolerates stray angle brackets in normal text", () => {
    const parser = createToolStreamParser();
    const result = parser.processChunk("a < b, c > d");

    assert.equal(result.text, "a < b, c > d");
    assert.equal(result.calls.length, 0);
});

test("streaming parser leaves partial unmatched tag as text on finish", () => {
    const parser = createToolStreamParser();
    const result = parser.processChunk("hello <div class=");
    assert.equal(result.text, "hello <div class=");
    assert.equal(result.calls.length, 0);

    const finish = parser.finish();
    assert.equal(finish.text, "");
    assert.equal(finish.calls.length, 0);
});

test("parseToolCallsFromText one-shot parse strips markers and returns calls", () => {
    const result = parseToolCallsFromText(
        '回答：<|tool_calls_begin|>[{"name":"get_weather","arguments":{"city":"上海"}}]<|tool_calls_end|>'
    );

    assert.equal(result.text, "回答：");
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "get_weather");
    assert.equal(JSON.parse(result.calls[0].function.arguments).city, "上海");
});

test("parseToolCallsFromText handles <invoke name=...> variant", () => {
    const result = parseToolCallsFromText(
        '<invoke name="get_weather"><parameter name="city">广州</parameter></invoke>'
    );

    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { city: "广州" });
});

test("parseToolCallsFromText handles GLM <tool_call> dialect", () => {
    const result = parseToolCallsFromText(
        "<tool_call>get_weather▁cmd▁params▁{\"city\":\"深圳\"}</tool_call>"
    );

    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { city: "深圳" });
});

test("parseToolCallsFromText strips code fences around tool JSON", () => {
    const result = parseToolCallsFromText(
        '<|tool_calls_begin|>```json\n[{"name":"a","arguments":{"x":1}}]\n```<|tool_calls_end|>'
    );

    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "a");
});

test("parseToolCallsFromText handles unquoted keys and single quotes", () => {
    const result = parseToolCallsFromText(
        "<|tool_calls_begin|>[{name: 'a', arguments: {x: 1}}]<|tool_calls_end|>"
    );

    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, "a");
});

test("parseToolCallsFromText returns passthrough when no markers", () => {
    const result = parseToolCallsFromText("普通文本，没有工具调用。");

    assert.equal(result.text, "普通文本，没有工具调用。");
    assert.equal(result.calls.length, 0);
});

test("streaming parser flushes unclosed marker buffer instead of swallowing the stream", () => {
    const parser = createToolStreamParser();
    const opening = "<|tool_calls_begin|>";
    const filler = "正文内容，模型其实没有输出工具调用而是直接回答。".repeat(1200);
    const tail = "剩下的回复内容";
    const result = parser.processChunk(`${opening}${filler}${tail}`);

    assert.ok(result.text.length > 10000, `expected text flush, got ${result.text.length} chars`);
    assert.ok(result.text.includes("正文内容"), "buffered text should be flushed as-is");
    assert.ok(result.text.endsWith(tail), "stream tail should not be swallowed");
    assert.equal(result.calls.length, 0);
});

test("stripToolMarkers removes markers but keeps surrounding text", () => {
    const text = stripToolMarkers(
        '<|tool_calls_begin|>[{"name":"a","arguments":{}}]<|tool_calls_end|>正文'
    );
    assert.equal(text, "正文");
});
