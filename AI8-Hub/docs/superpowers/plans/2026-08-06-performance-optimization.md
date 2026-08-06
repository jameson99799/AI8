# AI8-Hub Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add incremental low-risk performance optimizations to AI8-Hub (upstream connection pooling, response compression, cache pre-warm, SSE parser micro-optimization, TCP_NODELAY, request log throttling) without changing any existing API/behavior.

**Architecture:** Six independent optimizations applied to the existing single-process Express gateway. A new `lib/http-pool.js` module sets a global undici Agent (applies to every `fetch` in the process). `compression` middleware compresses only non-SSE JSON responses. Cache pre-warm runs fire-and-forget at startup and after config saves. SSE parsers in both upstream clients switch from string-concatenation to index-cursor buffering. Streaming responses enable `setNoDelay`. Request logging becomes throttled behind a new env knob.

**Tech Stack:** Node 24 (built-in `fetch`/undici), Express 4, new deps `undici` and `compression`, `node:test` for tests.

## Global Constraints

- Do NOT change any existing route path, response shape, header contract, or streaming chunk format.
- All 69 existing tests must stay green after every task.
- Config defaults must preserve current behavior exactly (`LOG_SLOW_THRESHOLD_MS` unset => log everything, same as today).
- New env vars must be documented in `.env.example`.
- New deps go in `package.json` `dependencies` via `npm install`.
- Commit after each task with a clear message.

---

### Task 1: Add `undici` and `compression` dependencies + connection pool module

**Files:**
- Modify: `package.json` (deps)
- Create: `lib/http-pool.js`
- Test: `tests/http-pool.test.js`

**Interfaces:**
- Consumes: nothing (self-contained), `process.env.HTTP_POOL_CONNECTIONS`, `process.env.HTTP_KEEPALIVE_TIMEOUT`, `process.env.HTTP_CONNECT_TIMEOUT`
- Produces: `lib/http-pool.js` exports `function initHttpPool()` that installs a global undici dispatcher and returns the Agent instance.

- [x] **Step 1: Install dependencies**

Run: `npm install undici compression`
Expected: `package.json` gains `"undici": "^7.x"` and `"compression": "^1.x"` under `dependencies`.

- [x] **Step 2: Write the failing test**

Create `tests/http-pool.test.js`:

```js
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
```

- [x] **Step 3: Run test to verify it fails**

Run: `node --test tests/http-pool.test.js`
Expected: FAIL with `Cannot find module '../lib/http-pool'`

- [x] **Step 4: Write minimal implementation**

Create `lib/http-pool.js`:

```js
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
```

- [x] **Step 5: Run test to verify it passes**

Run: `node --test tests/http-pool.test.js`
Expected: PASS (3 tests)

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json tests/http-pool.test.js lib/http-pool.js
git commit -m "feat: add undici/compression deps and global HTTP connection pool"
```

---

### Task 2: Enable response compression middleware

**Files:**
- Modify: `server.js` (middleware section, near line 67-71)
- Test: none required (manual verification against live server)

**Interfaces:**
- Consumes: `compression` package
- Produces: gzip compression for JSON responses > 1KB; SSE responses remain uncompressed.

- [x] **Step 1: Add compression middleware import**

In `server.js`, after the existing `require("express")` line (line 7), add:

```js
const compression = require("compression");
```

- [x] **Step 2: Register middleware before routes**

After `app.use(dynamicJsonBodyParser);` (line 70), add:

```js
app.use(compression({
    threshold: 1024,
    filter(req, res) {
        const contentType = String(res.getHeader("Content-Type") || res.getHeader("content-type") || "");
        if (contentType.startsWith("text/event-stream")) {
            return false;
        }
        return compression.filter(req, res);
    },
}));
```

Place it BEFORE `app.use(requestLoggerMiddleware)` so compressed sizes are logged. Order in file:

```js
app.use(compression({ threshold: 1024, filter(req, res) { ... } }));
app.use(dynamicJsonBodyParser);
app.use(requestLoggerMiddleware);
```

- [x] **Step 3: Verify SSE streaming is NOT compressed**

Reasoning (no code change needed beyond Step 2): the custom `filter` explicitly returns `false` for `text/event-stream`, so `handleStreamingChatCompletion` output is never gzip'd regardless of its `Cache-Control` header. This is defense-in-depth on top of the existing `Cache-Control: no-cache, no-transform` (server.js:814).

- [x] **Step 4: Smoke-test locally**

Run: `node server.js` in one terminal; then:

```powershell
$r = Invoke-WebRequest -Uri "http://localhost:7865/v1/models" -Headers @{ Authorization = "Bearer x9981509"; "Accept-Encoding" = "gzip" }
$r.StatusCode
$r.Headers["Content-Encoding"]
```

Expected: `200` and `Content-Encoding: gzip`. Then verify a streaming request still has no `content-encoding` header.

- [x] **Step 5: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: 69 pass, 0 fail

- [x] **Step 6: Commit**

```bash
git add server.js
git commit -m "perf: enable gzip compression for large JSON responses"
```

---

### Task 3: Add `logSlowThresholdMs` config (env-only, not editable)

**Files:**
- Modify: `lib/runtime-config.js` (`_buildBaseRawConfig` ~line 142, `normalizeConfig` ~line 222)
- Modify: `.env.example`
- Test: `tests/config-blacklist.test.js` pattern â€?add a small assertion file OR extend runtime config test if exists.

**Interfaces:**
- Consumes: `process.env.LOG_SLOW_THRESHOLD_MS`
- Produces: `config.logSlowThresholdMs` (number, default `0` = log everything) available via `getConfig()`.

- [x] **Step 1: Add env mapping to base raw config**

In `lib/runtime-config.js` `_buildBaseRawConfig` (after line 158 `port: process.env.PORT,`), add:

```js
logSlowThresholdMs: process.env.LOG_SLOW_THRESHOLD_MS,
```

- [x] **Step 2: Add normalization**

In `normalizeConfig` (after the `port:` entry), add:

```js
logSlowThresholdMs: parseNumber(source.logSlowThresholdMs ?? source.LOG_SLOW_THRESHOLD_MS, 0),
```

- [x] **Step 3: Add to `.env.example`**

Add below `PORT=7865`:

```
# If > 0, only log HTTP requests slower than this many ms (or with status >= 400). 0 = log all.
LOG_SLOW_THRESHOLD_MS=0
```

- [x] **Step 4: Write the test**

Create `tests/log-threshold.test.js`:

```js
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
```

- [x] **Step 5: Run tests to verify**

Run: `node --test tests/log-threshold.test.js`
Expected: PASS (2 tests)

- [x] **Step 6: Run full suite**

Run: `node --test tests/*.test.js`
Expected: 71 pass, 0 fail

- [x] **Step 7: Commit**

```bash
git add lib/runtime-config.js .env.example tests/log-threshold.test.js
git commit -m "feat: add LOG_SLOW_THRESHOLD_MS env for request log throttling"
```

---

### Task 4: Throttle request logging behind the threshold

**Files:**
- Modify: `server.js` `requestLoggerMiddleware` (lines 1465-1481)
- Test: none (behavior verified via unit test in Task 3 + manual)

**Interfaces:**
- Consumes: `getConfig().logSlowThresholdMs`
- Produces: same `logger.info("HTTP request", ...)` for all requests when threshold is 0; only slow/error requests when threshold > 0.

- [x] **Step 1: Read current middleware**

Read `server.js` lines 1465-1481 to confirm the exact block.

- [x] **Step 2: Modify middleware**

Replace the `res.on("finish", ...)` handler body with:

```js
function requestLoggerMiddleware(req, res, next) {
    const startedAt = Date.now();
    res.on("finish", () => {
        if (req.path === "/admin/api/logs") {
            return;
        }

        const durationMs = Date.now() - startedAt;
        const threshold = getConfig().logSlowThresholdMs;
        if (threshold > 0 && durationMs < threshold && res.statusCode < 400) {
            return;
        }

        logger.info("HTTP request", {
            duration_ms: durationMs,
            ip: extractRequestIp(req),
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
        });
    });
    next();
}
```

- [x] **Step 3: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: all pass

- [x] **Step 4: Commit**

```bash
git add server.js
git commit -m "perf: throttle request logging via LOG_SLOW_THRESHOLD_MS"
```

---

### Task 5: Pre-warm model and template caches

**Files:**
- Modify: `server.js` (startup listen callback ~line 783, and `PUT /admin/api/config` ~line 111-135)
- Test: none (fire-and-forget; guarded try/catch)

**Interfaces:**
- Consumes: `getClient()`, `fetchAggregatedModels`, `configStore`
- Produces: warm `channel-manager` model cache and `ai8-client` template cache at startup and after config saves.

- [x] **Step 5.1: Add helper function**

Add near `getClient` (before `invalidateClient`, ~line 1669):

```js
function prewarmCaches() {
    try {
        const config = getConfig();
        if (!config.ai8AuthToken) {
            return;
        }
        const client = getClient();
        Promise.allSettled([
            fetchAggregatedModels(client, config, false, logger, false),
            client.fetchTemplate().catch(() => null),
        ]).then(results => {
            results.forEach(result => {
                if (result.status === "rejected" && logger) {
                    logger.warn("Cache prewarm failed", { error: String(result.reason) });
                }
            });
        });
    } catch (error) {
        if (logger) logger.warn("Cache prewarm skipped", { error: String(error) });
    }
}
```

- [x] **Step 5.2: Call at startup**

In the `app.listen(port, "0.0.0.0", () => { ... })` callback (line 783), add `prewarmCaches();` before the closing brace.

- [x] **Step 5.3: Call after config save**

In `app.put("/admin/api/config", ...)` handler, after `invalidateClient();` (line 117), add:

```js
setImmediate(prewarmCaches);
```

- [x] **Step 5.4: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: all pass

- [x] **Step 5.5: Commit**

```bash
git add server.js
git commit -m "perf: prewarm model and template caches at startup and after config save"
```

---

### Task 6: Optimize AI8 SSE parser to index-cursor buffering

**Files:**
- Modify: `lib/ai8-client.js` (lines 251-327 streaming loop)
- Test: `tests/ai8-client.test.js` (add parser equivalence test)

**Interfaces:**
- Consumes: existing `_findEventBoundary`, `_readEventData`, `_splitThinkingChunk`
- Produces: identical SSE parsing semantics with an index cursor and periodic trim; `finalRecord`/`taskId` output unchanged.

- [x] **Step 6.1: Write the failing test**

Append to `tests/ai8-client.test.js`:

```js
test("AI8 SSE parser consumes a long stream split across many chunks", async () => {
    const client = createClient();

    const events = [];
    for (let i = 0; i < 2000; i += 1) {
        events.push(`data: {"code":0,"data":"tok${i}"}\n\n`);
    }
    events.push("data: [DONE]\n\n");
    const bodyText = events.join("");

    const fakeHeaders = {
        get(name) {
            const lower = String(name).toLowerCase();
            if (lower === "content-type") return "text/event-stream";
            if (lower === "x-chat-task-id") return null;
            return null;
        },
    };
    const fakeResponse = {
        ok: true,
        status: 200,
        headers: fakeHeaders,
        body: new ReadableStream({
            start(controller) {
                const bytes = new TextEncoder().encode(bodyText);
                for (let i = 0; i < bytes.length; i += 3) {
                    controller.enqueue(bytes.subarray(i, i + 3));
                }
                controller.close();
            },
        }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse;
    try {
        const tokens = [];
        await client.streamChatCompletion(
            { text: "hi", sessionId: 1 },
            {
                onText(chunk) { tokens.push(chunk); },
                onDone() {},
            }
        );
        assert.equal(tokens.length, 2000);
        assert.equal(tokens[0], "tok0");
        assert.equal(tokens[1999], "tok1999");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

NOTE: this test fails on the OLD string-concat implementation only if the refactor changes semantics; its real job is to pin the output contract (all 2000 tokens in order, even with 3-byte chunks forcing many partial-boundary reads). Run it BEFORE the refactor to confirm it passes on current code, then again after the refactor â€?both must pass identically.

- [x] **Step 6.2: Refactor the streaming loop**

In `lib/ai8-client.js`, replace the `for await (const chunk of response.body) { buffer += ...; ... }` block (lines 262-327) with:

```js
let readOffset = 0;

const appendAndParse = () => {
    for (;;) {
        const boundary = this._findEventBoundary(buffer, readOffset);
        if (!boundary) {
            break;
        }

        const rawEvent = buffer.slice(readOffset, boundary.index);
        readOffset = boundary.index + boundary.length;

        const data = this._readEventData(rawEvent);
        if (!data) {
            continue;
        }
        // ... existing [DONE] / JSON.parse / onText / onObject handling unchanged ...
    }
};
```

- [x] **Step 6.3: Update `_findEventBoundary` to accept an offset**

Change signature to `_findEventBoundary(buffer, fromIndex = 0)` and use `buffer.indexOf("\n\n", fromIndex)` / `buffer.indexOf("\r\n\r\n", fromIndex)`.

- [x] **Step 6.4: Periodic trim**

After processing each network chunk, if `readOffset > 8192`, do `buffer = buffer.slice(readOffset); readOffset = 0;`.

- [x] **Step 6.5: Run AI8 tests**

Run: `node --test tests/ai8-client.test.js`
Expected: all pass (no behavior change)

- [x] **Step 6.6: Run full suite**

Run: `node --test tests/*.test.js`
Expected: all pass

- [x] **Step 6.7: Commit**

```bash
git add lib/ai8-client.js tests/ai8-client.test.js
git commit -m "perf: use index-cursor buffering in AI8 SSE parser"
```

---

### Task 7: Optimize gpt-all SSE parser to index-cursor buffering

**Files:**
- Modify: `lib/gptall-client.js` (lines 212-226 streaming loop)
- Test: `tests/gptall-client.test.js` (existing suite must pass)

**Interfaces:**
- Consumes: existing `processLine` closure
- Produces: identical newline-delimited JSON parsing; `chatId`, `finalRecord`, `groupUpdated` unchanged.

- [x] **Step 7.1: Write the equivalence test (pin output contract)**

Append to `tests/gptall-client.test.js`:

```js
test("gpt-all newline parser consumes a long stream split across many chunks", async () => {
    const GptAllClient = require("../lib/gptall-client");
    const client = new GptAllClient({
        authToken: "tok",
        baseUrl: "https://gpt-all.chat/api",
        fingerprint: "1",
        defaultModel: "test-model",
        deleteGroupAfterResponse: false,
    });

    const lines = [];
    for (let i = 0; i < 1500; i += 1) {
        lines.push(JSON.stringify({ chatId: 7, text: `line${i}` }));
    }
    const bodyText = lines.join("\n") + "\n";

    const jsonHeaders = { get(name) { return String(name).toLowerCase() === "content-type" ? "application/json" : null; } };
    const streamHeaders = { get(name) { return String(name).toLowerCase() === "content-type" ? "text/event-stream" : null; } };

    function jsonResponse(payload) {
        return {
            ok: true,
            status: 200,
            headers: jsonHeaders,
            async json() { return payload; },
            async text() { return JSON.stringify(payload); },
        };
    }

    const streamResponse = {
        ok: true,
        status: 200,
        headers: streamHeaders,
        body: new ReadableStream({
            start(controller) {
                const bytes = new TextEncoder().encode(bodyText);
                for (let i = 0; i < bytes.length; i += 3) {
                    controller.enqueue(bytes.subarray(i, i + 3));
                }
                controller.close();
            },
        }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const path = String(url.pathname || url);
        if (path.includes("/models/list")) {
            return jsonResponse({ code: 0, data: { modelMaps: { g: [{ model: "test-model", modelName: "test-model", modelType: 1 }] } } });
        }
        if (path.includes("/group/create")) {
            return jsonResponse({ code: 0, data: { id: 1 } });
        }
        if (path.includes("/group/update")) {
            return jsonResponse({ code: 0, data: {} });
        }
        return streamResponse;
    };
    try {
        const texts = [];
        await client.streamChatCompletion(
            { text: "hi", model: "test-model" },
            { onText(chunk) { texts.push(chunk); }, onDone() {} }
        );
        assert.equal(texts.length, 1500);
        assert.equal(texts[0], "line0");
        assert.equal(texts[1499], "line1499");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

Run BEFORE the refactor to confirm it passes on current code; it must pass identically after. Then proceed.

- [x] **Step 7.2: Refactor the newline loop**

In `lib/gptall-client.js`, replace lines 212-226 with:

```js
let readOffset = 0;

for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    for (;;) {
        const index = buffer.indexOf("\n", readOffset);
        if (index === -1) {
            break;
        }
        const newlineLength = index > 0 && buffer[index - 1] === "\r" ? 2 : 1;
        const rawLine = buffer.slice(readOffset, index + (newlineLength === 2 ? -1 : 0));
        readOffset = index + newlineLength;
        lineNumber += 1;
        processLine(rawLine);
    }

    if (readOffset > 8192) {
        buffer = buffer.slice(readOffset);
        readOffset = 0;
    }
}
```

- [x] **Step 7.2: Fix the trailing-buffer check**

After the loop, replace `if (buffer.trim()) {` with `if (buffer.slice(readOffset).trim()) {` and parse the remainder accordingly.

- [x] **Step 7.3: Run gptall tests**

Run: `node --test tests/gptall-client.test.js`
Expected: all pass

- [x] **Step 7.4: Run full suite**

Run: `node --test tests/*.test.js`
Expected: all pass

- [x] **Step 7.5: Commit**

```bash
git add lib/gptall-client.js
git commit -m "perf: use index-cursor buffering in gpt-all SSE parser"
```

---

### Task 8: Enable TCP_NODELAY for streaming responses

**Files:**
- Modify: `server.js` `handleStreamingChatCompletion` (after line 815, before `res.flushHeaders()`)
- Test: none (behavioral; manual verification)

**Interfaces:**
- Consumes: `res.socket`
- Produces: `socket.setNoDelay(true)` on streaming responses for smoother token delivery.

- [x] **Step 1: Add setNoDelay**

In `handleStreamingChatCompletion`, after `res.setHeader("Connection", "keep-alive");` (line 815), add:

```js
if (typeof res.socket?.setNoDelay === "function") {
    res.socket.setNoDelay(true);
}
```

- [x] **Step 2: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: all pass

- [x] **Step 3: Commit**

```bash
git add server.js
git commit -m "perf: enable TCP_NODELAY for streaming responses"
```

---

### Task 9: Final verification and deployment notes

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-performance-optimization-design.md` (mark complete) â€?optional
- Test: full suite

- [x] **Step 1: Run the entire test suite**

Run: `node --test tests/*.test.js`
Expected: all pass (69 original + http-pool + log-threshold tests)

- [x] **Step 2: Verify server boots**

Run: `node server.js` (with a valid config), then check `/health` returns 200 and the model cache is pre-warmed (first `/v1/models` returns instantly).

- [x] **Step 3: Verify compression on live behavior**

Run: `Invoke-WebRequest http://localhost:7865/v1/models` with `Accept-Encoding: gzip` â€?expect `Content-Encoding: gzip`. Confirm streaming chat response has no `content-encoding`.

- [x] **Step 4: Verify log throttling**

With `LOG_SLOW_THRESHOLD_MS=1000`, make fast requests and confirm no `HTTP request` logs; make a slow request and confirm it is logged.

- [x] **Step 5: Push to upstream and note deployment**

```bash
git push upstream main
```

Deployment on server:

```bash
cd ~/AI8-2 && git pull && cd AI8-Hub && npm install && pm2 restart ai8-hub
```

- [x] **Step 6: Commit any final doc tweaks**

```bash
git add -A
git commit -m "chore: finalize performance optimization verification"
```

---

## Self-Review

**Spec coverage:**
- Spec Â§1 (connection pool) â†?Task 1 âœ?- Spec Â§2 (compression) â†?Task 2 âœ?- Spec Â§3 (cache prewarm) â†?Task 5 âœ?- Spec Â§4 (SSE parser) â†?Tasks 6, 7 âœ?- Spec Â§5 (NODELAY) â†?Task 8 âœ?- Spec Â§6 (log throttling) â†?Tasks 3, 4 âœ?- Global constraint "all tests green" â†?Task 2/4/6/7/9 checkpoints âœ?
**Placeholder scan:** No TBD/TODO; every step has concrete code or commands. Step 6.1's NOTE explains the testing limitation and the resolution path. âœ?
**Type consistency:** `initHttpPool` returns Agent and is exported once; `logSlowThresholdMs` spelled identically in Task 3 (config), Task 4 (`getConfig().logSlowThresholdMs`), and tests; `readOffset` used consistently within each parser task. âœ?
