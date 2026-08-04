"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RuntimeConfigStore = require("../lib/runtime-config");

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai8-cfg-"));
    const storePath = path.join(dir, "config.json");
    const store = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
    return { store, storePath, dir };
}

test("config round-trips channel blacklists as CSV via getEditableConfig", () => {
    const { store, dir } = makeStore();
    try {
        store.updateConfig({ ai8BlacklistedModels: "model-a,model-b" });
        store.updateConfig({ gptallBlacklistedModels: "gpt-x,gpt-y" });
        store.updateConfig({ blacklistedModels: "m1【gpt-all】,m2【AI8直连】" });

        const editable = store.getEditableConfig();
        assert.equal(editable.ai8BlacklistedModels, "model-a,model-b");
        assert.equal(editable.gptallBlacklistedModels, "gpt-x,gpt-y");
        assert.equal(editable.blacklistedModels, "m1【gpt-all】,m2【AI8直连】");

        const internal = store.getConfig();
        assert.deepEqual(internal.ai8BlacklistedModels, ["model-a", "model-b"]);
        assert.deepEqual(internal.gptallBlacklistedModels, ["gpt-x", "gpt-y"]);
        assert.deepEqual(internal.blacklistedModels, ["m1【gpt-all】", "m2【AI8直连】"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("config reload preserves channel blacklists from disk", () => {
    const { store, storePath, dir } = makeStore();
    try {
        store.updateConfig({ gptallBlacklistedModels: "gpt-x,gpt-y" });
        const reloaded = new RuntimeConfigStore({ storePath, defaults: { adminToken: "test-token" } });
        assert.deepEqual(reloaded.getConfig().gptallBlacklistedModels, ["gpt-x", "gpt-y"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("updating a channel blacklist does not clobber the global blacklist", () => {
    const { store, dir } = makeStore();
    try {
        store.updateConfig({ blacklistedModels: "m1【gpt-all】" });
        store.updateConfig({ gptallBlacklistedModels: "gpt-x" });
        const cfg = store.getConfig();
        assert.deepEqual(cfg.blacklistedModels, ["m1【gpt-all】"]);
        assert.deepEqual(cfg.gptallBlacklistedModels, ["gpt-x"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
