"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { splitPreparedMessages } = require("../lib/message-layout");

function renderMessageText(message) {
    return String(message?.text || "").trim();
}

test("splitPreparedMessages extracts leading assistant preset when no system prompt exists", () => {
    const result = splitPreparedMessages(
        [
            { role: "assistant", text: "你是一名钢铁行业外贸翻译专家" },
            { role: "user", text: "第一句" },
            { role: "assistant", text: "中间回复" },
            { role: "user", text: "第二句" },
        ],
        renderMessageText
    );

    assert.equal(result.systemPrompt, "");
    assert.equal(result.assistantPrompt, "你是一名钢铁行业外贸翻译专家");
    assert.deepEqual(
        result.conversation.map(item => item.text),
        ["第一句", "中间回复", "第二句"]
    );
});

test("splitPreparedMessages keeps leading assistant in conversation when system prompt already exists", () => {
    const result = splitPreparedMessages(
        [
            { role: "system", text: "system preset" },
            { role: "assistant", text: "assistant history" },
            { role: "user", text: "hello" },
        ],
        renderMessageText
    );

    assert.equal(result.systemPrompt, "system preset");
    assert.equal(result.assistantPrompt, "");
    assert.deepEqual(
        result.conversation.map(item => item.text),
        ["assistant history", "hello"]
    );
});
