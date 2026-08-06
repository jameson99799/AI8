"use strict";

const { Agent, setGlobalDispatcher } = require("undici");

function parsePositiveInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function initHttpPool() {
    const connections = parsePositiveInt(process.env.HTTP_POOL_CONNECTIONS, 64);
    const keepAliveTimeout = parsePositiveInt(process.env.HTTP_KEEPALIVE_TIMEOUT, 60000);
    const connectTimeout = parsePositiveInt(process.env.HTTP_CONNECT_TIMEOUT, 10000);

    const agent = new Agent({
        connections,
        keepAliveTimeout,
        connect: { timeout: connectTimeout },
    });
    setGlobalDispatcher(agent);
    return agent;
}

module.exports = { parsePositiveInt, initHttpPool };
