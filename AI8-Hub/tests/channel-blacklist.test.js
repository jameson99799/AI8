"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { clearResolutionCache, filterCachedModels, isBlacklisted, resolveTargetChannel } = require("../lib/channel-manager");

function makeModels() {
    return [
        { origId: "ai8-a", _source: "ai8", attr: { providerName: "ai8" } },
        { origId: "ai8-b", _source: "ai8", attr: { providerName: "ai8" } },
        { origId: "gpt1", _source: "gptall", attr: { providerName: "gpt-all" } },
        { origId: "gpt2", _source: "gptall", attr: { providerName: "gpt-all" } },
        { origId: "deep1", _source: "custom1", attr: { providerName: "custom1" } },
        { origId: "deep2", _source: "custom1", attr: { providerName: "custom1" } },
    ];
}

test("filterCachedModels returns all models for admin regardless of filters", () => {
    const config = {
        blacklistedModels: ["deep1"],
        ai8BlacklistedModels: ["ai8-a"],
        gptallBlacklistedModels: ["gpt1"],
        customChannels: [{ name: "custom1", enabled: true, blacklistedModels: ["deep2"] }],
    };
    const result = filterCachedModels(makeModels(), config, true);
    assert.equal(result.length, 6);
});

test("filterCachedModels applies global blacklist by aggregated id", () => {
    const config = {
        blacklistedModels: ["deep1【custom1】"],
        ai8BlacklistedModels: [],
        gptallBlacklistedModels: [],
        customChannels: [{ name: "custom1", enabled: true }],
    };
    const models = makeModels().map(m => ({ ...m, value: m._source === "custom1" ? `${m.origId}【custom1】` : m.origId }));
    const result = filterCachedModels(models, config, false);
    assert.ok(!result.some(m => m.origId === "deep1"));
    assert.ok(result.some(m => m.origId === "deep2"));
});

test("filterCachedModels applies ai8 blacklist", () => {
    const config = {
        ai8BlacklistedModels: ["ai8-a"],
        gptallBlacklistedModels: [],
        customChannels: [],
    };
    const result = filterCachedModels(makeModels(), config, false);
    assert.ok(!result.some(m => m.origId === "ai8-a"));
    assert.ok(result.some(m => m.origId === "ai8-b"));
});

test("filterCachedModels applies gptall blacklist", () => {
    const config = {
        ai8BlacklistedModels: [],
        gptallBlacklistedModels: ["gpt1"],
        customChannels: [],
    };
    const result = filterCachedModels(makeModels(), config, false);
    assert.ok(!result.some(m => m.origId === "gpt1"));
    assert.ok(result.some(m => m.origId === "gpt2"));
});

test("filterCachedModels applies custom channel blacklist while keeping channel models", () => {
    const config = {
        ai8BlacklistedModels: [],
        gptallBlacklistedModels: [],
        customChannels: [{ name: "custom1", enabled: true, blacklistedModels: ["deep1"] }],
    };
    const result = filterCachedModels(makeModels(), config, false);
    assert.ok(!result.some(m => m.origId === "deep1"));
    assert.ok(result.some(m => m.origId === "deep2"));
});

test("filterCachedModels removes channel models when channel disabled", () => {
    const config = {
        ai8BlacklistedModels: [],
        gptallBlacklistedModels: [],
        customChannels: [{ name: "custom1", enabled: false, blacklistedModels: [] }],
    };
    const result = filterCachedModels(makeModels(), config, false);
    assert.ok(!result.some(m => m.origId === "deep1"));
    assert.ok(!result.some(m => m.origId === "deep2"));
});

test("isBlacklisted checks custom channel blacklist", () => {
    const config = { gptallBlacklistedModels: [], ai8BlacklistedModels: [] };
    const channel = { name: "custom1", blacklistedModels: ["deep1"] };
    assert.equal(isBlacklisted("deep1", config, channel), true);
    assert.equal(isBlacklisted("deep2", config, channel), false);
});

test("isBlacklisted checks gpt-all blacklist by channel name", () => {
    const config = { gptallBlacklistedModels: ["gpt1"], ai8BlacklistedModels: [] };
    const channel = { name: "gpt-all", protocol: "gptall" };
    assert.equal(isBlacklisted("gpt1", config, channel), true);
    assert.equal(isBlacklisted("gpt2", config, channel), false);
});

test("isBlacklisted checks ai8 blacklist when no target channel", () => {
    const config = { gptallBlacklistedModels: [], ai8BlacklistedModels: ["ai8-a"] };
    assert.equal(isBlacklisted("ai8-a", config, null), true);
    assert.equal(isBlacklisted("ai8-b", config, null), false);
});

test("isBlacklisted is case-agnostic to empty blacklists", () => {
    const config = { gptallBlacklistedModels: [], ai8BlacklistedModels: [] };
    assert.equal(isBlacklisted("anything", config, null), false);
    const channel = { name: "custom1" };
    assert.equal(isBlacklisted("anything", config, channel), false);
});

test("resolveTargetChannel caches results across repeated calls", async () => {
    clearResolutionCache();
    let fetchCount = 0;
    const fakeClient = {
        fetchModels: async () => {
            fetchCount += 1;
            return [{ value: "openai_chat::gpt-4.1-mini【AI8直连】" }];
        },
    };
    const config = {
        ai8Enabled: true,
        ai8BlacklistedModels: [],
        ai8AllowedModels: [],
        blacklistedModels: [],
        gptallEnabled: false,
        gptallBlacklistedModels: [],
        customChannels: [],
    };

    const first = await resolveTargetChannel("openai_chat::gpt-4.1-mini", config, fakeClient);
    const second = await resolveTargetChannel("openai_chat::gpt-4.1-mini", config, fakeClient);
    assert.deepEqual(first, second);
    assert.equal(fetchCount, 1, "second call should hit the resolution cache");
});
