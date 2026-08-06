"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePositiveInt, initHttpPool } = require("../lib/http-pool");

test("parsePositiveInt returns fallback for invalid/zero/negative input", () => {
    assert.equal(parsePositiveInt(undefined, 10), 10);
    assert.equal(parsePositiveInt("abc", 10), 10);
    assert.equal(parsePositiveInt("0", 10), 10);
    assert.equal(parsePositiveInt("-5", 10), 10);
    assert.equal(parsePositiveInt("", 10), 10);
});

test("parsePositiveInt parses positive numbers and floors decimals", () => {
    assert.equal(parsePositiveInt("7", 10), 7);
    assert.equal(parsePositiveInt("12.9", 10), 12);
    assert.equal(parsePositiveInt(42, 10), 42);
});

test("initHttpPool installs a global Agent and returns it", () => {
    const { Agent, getGlobalDispatcher } = require("undici");

    const agent = initHttpPool();
    assert.ok(agent instanceof Agent);
    assert.equal(getGlobalDispatcher(), agent);
});
