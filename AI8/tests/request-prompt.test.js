"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolvePreparedPrompt, resolveSessionPrompt } = require("../lib/request-prompt");

test("resolveSessionPrompt prefers explicit ai8 session prompt from metadata", () => {
    const prompt = resolveSessionPrompt(
        {
            metadata: {
                ai8_session_prompt: "你是翻译助手",
                prompt: "旧值",
            },
        },
        {
            systemPrompt: "system value",
        }
    );

    assert.equal(prompt.value, "你是翻译助手");
    assert.equal(prompt.source, "metadata.ai8_session_prompt");
});

test("resolveSessionPrompt supports top-level instructions and prompt fields", () => {
    assert.equal(
        resolveSessionPrompt(
            {
                instructions: "top level instructions",
            },
            {
                systemPrompt: "system value",
            }
        ).value,
        "top level instructions"
    );

    assert.equal(
        resolveSessionPrompt(
            {
                prompt: "top level prompt",
            },
            {
                systemPrompt: "system value",
            }
        ).value,
        "top level prompt"
    );
});

test("resolveSessionPrompt falls back to prepared system prompt", () => {
    const prompt = resolveSessionPrompt(
        {},
        {
            systemPrompt: "system value",
        }
    );

    assert.equal(prompt.value, "system value");
    assert.equal(prompt.source, "messages.system_or_developer");
});

test("resolvePreparedPrompt falls back to leading assistant preset when system prompt is empty", () => {
    const prompt = resolvePreparedPrompt({
        assistantPrompt: "assistant preset",
        systemPrompt: "",
    });

    assert.equal(prompt.value, "assistant preset");
    assert.equal(prompt.source, "messages.leading_assistant");
});
