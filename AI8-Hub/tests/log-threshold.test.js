"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const RuntimeConfigStore = require("../lib/runtime-config");

function loadStore(envValue) {
    const previous = process.env.LOG_SLOW_THRESHOLD_MS;
    if (envValue === undefined) delete process.env.LOG_SLOW_THRESHOLD_MS;
    else process.env.LOG_SLOW_THRESHOLD_MS = envValue;

    const store = new RuntimeConfigStore({
        envPath: "nonexistent.env",
        storePath: "nonexistent-config.json",
        defaults: { apiKeys: ["k"], ai8AuthToken: "tok" },
    });

    if (previous === undefined) delete process.env.LOG_SLOW_THRESHOLD_MS;
    else process.env.LOG_SLOW_THRESHOLD_MS = previous;
    return store;
}

test("logSlowThresholdMs defaults to 0", () => {
    const store = loadStore(undefined);
    assert.equal(store.getConfig().logSlowThresholdMs, 0);
});

test("logSlowThresholdMs parses positive env value", () => {
    const store = loadStore("1500");
    assert.equal(store.getConfig().logSlowThresholdMs, 1500);
});
