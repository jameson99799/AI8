# Design: gpt-all.chat native channel (GPTALL direct)

Date: 2026-08-04
Status: Approved (in conversation)

## Goal

Add `gpt-all.chat` as a first-class native upstream channel in AI8-Hub, exactly parallel to the
existing native AI8 channel, so clients can call it through the local OpenAI/Anthropic-compatible
API (`/v1/chat/completions`, `/v1/models`, ...).

## Verified upstream protocol (reverse-engineered from the site frontend)

All requests authenticate with:

- Header `Authorization: Bearer <JWT>`
- Header `fingerprint: <value>`
- Header `x-website-domain: https://gpt-all.chat`
- Cookie `fl_ua_key=...`

Endpoints:

| Purpose               | Method + path                     | Notes                                                                 |
|-----------------------|------------------------------------|-----------------------------------------------------------------------|
| Model list            | `GET /api/models/list`             | `data.modelMaps` = object of arrays; each item: `{model, modelName, modelType, keyType, ...}` |
| Chat (streaming)      | `POST /api/chatgpt/chat-process`   | body below; returns NDJSON stream (JSON lines, `application/octet-stream`) |
| Group create          | `POST /api/group/create`           | body `{appId:0}` → `data.id` = groupId (holds conversation history) |
| Chat log list         | `GET /api/chatlog/chatList?groupId=`| paged records                          |

`/api/chatgpt/chat-process` request body (mirrors the web client):

```json
{
  "model": "doubao-seed-2.0-lite",
  "modelName": "doubao-seed-2.0-lite（免费）",
  "modelType": 1,
  "prompt": "<user text / transcript>",
  "imageUrl": "", "videoUrl": "", "fileUrl": "",
  "appId": 0,
  "options": { "groupId": 0, "fileParsing": false, "usingDeepThinking": false, "usingTool": false },
  "extraParam": null
}
```

NDJSON stream line types (verified):

- `{"status":2,"modelType":1,"modelName":"…","chatId":1833059}`
- incremental answer: `{"content":[{"type":"text","text":"Under"}],"text":"Under"}`
- thinking: `reasoning_content` field
- final: `{"finishReason":"success", "reasoning_content":"", "content":"…(workflow json)", "data":{"llm":{"response":"<answer>"}}, "text":"…", "totalTokens":N, …}`
- failure: `finishReason:"fallback_failed"` + `fallbackNotice` / `fallbackReasonText` ("模型额度或次数已用尽", etc.)

Answer extraction: prefer `data.llm.response` on the final record; otherwise concatenate
incremental `text`/`content[].text` chunks. Usage from `totalTokens`/`data.tokenUsage`.

## Design

### New file: `lib/gptall-client.js`

Mirrors `lib/ai8-client.js` (same style, no shared state):

- `constructor({ baseUrl, authToken, cookie, fingerprint, defaultModel, requestTimeoutMs, modelCacheTtlMs })`
- `fetchModels({ forceRefresh })` → flatten `modelMaps` into items `{ value, label, modelType, modelName, meta }`, cached TTL
- `resolveModel(model)` → exact or short-name match over cached models (like AI8Client.resolveModel)
- `streamChatCompletion({ text, model, signal })` → POST `/api/chatgpt/chat-process`, parse NDJSON,
  `handlers.onText(delta)`, `handlers.onObject(parsed)`, returns `{ record, chatId, taskId }`
- NDJSON parsing: split on line breaks, JSON.parse each non-empty line
- `_normalizeError` maps `fallback_failed` / quota / auth messages to HTTP-ish statuses (401/429/502)
- `_buildError` helper

### Config (`lib/runtime-config.js`)

New editable + normalized fields:

```
gptallEnabled:          bool (default false)
gptallBaseUrl:          string (default https://gpt-all.chat/api)
gptallAuthToken:        string (JWT, required when enabled)
gptallCookie:           string (fl_ua_key=…)
gptallFingerprint:      string
gptallDefaultModel:     string
gptallAllowedModels:    CSV whitelist (optional)
gptallRequestTimeoutMs: number (default 300000)
```

- `EDITABLE_FIELDS` += new keys
- `normalizeConfig` + `getEditableConfig` updated

## Routing (`lib/channel-manager.js`)

- `fetchAggregatedModels`: if `config.gptallEnabled !== false`, build a GptAllClient from config and
  append its models tagged `_source:"gpt-all"`, value suffixed `${modelId}【gpt-all】`, `origId` = raw model id.
- `filterCachedModels`: gpt-all models filtered by `config.gptallAllowedModels` whitelist (when set).
- `resolveTargetChannel`: match `【gptall】` suffix → `{ targetChannel: { protocol: "gptall" }, actualModel }`.

### Server (`server.js`)

- Keep a small `getGptAllClient()` gated on `gptallEnabled` + `gptallAuthToken`, invalidated on config change (mirror `getClient`).
- `/v1/chat/completions`: after `resolveTargetChannel`, when `targetChannel.protocol === "gptall"` call
  `handleGptAllChatCompletion` (stream + non-stream) instead of native AI8 path.
  - reuse `prepareMessages` + `resolveSessionPrompt` to produce the transcript prompt
  - upstream call via `gptallClient.streamChatCompletion`
  - translate NDJSON → OpenAI `chat.completion` / `chat.completion.chunk` bodies
  - expose `x-gptall-chat-id` header; fallback_failed → 502 with `fallbackNotice`
- `/v1/models` picks up gpt-all models automatically via aggregate.
- Runtime/effective summary + GET `/` overload: include gptall status (enabled, model count, ready).

> Anthropic `/v1/messages` support: the existing script rewrites to `/v1/chat/completions`, so gptall
> parity for Claude-forwarding works there for free. Document as supported.

### Admin UI (`admin/index.html`, `admin/app.js`)

- Config form: add a "GPT-ALL 直连" section with base URL, token (password field), cookie, fingerprint,
  default model, enabled toggle.
- Channels tab: add a virtual `GPT-ALL 直连` row like the existing AI8 row (disabled + show state).

### Tests (`tests/gptall-client.test.js`)

- NDJSON parser: mixed lines → correct events/final record
- answer extraction from final record (`data.llm.response`)
- fallback_failed → normalized error (quota message)
- model list flatten (fixture)
- resolveModel exact + short name

## Decision / trade-offs

- Multi-turn: v1 is stateless — the whole OpenAI message history is merged into the gpt-all `prompt`
  transcript (same as AI8's non-reuse path). Simpler + avoids server-side session cleanup. group create /
  `chatlog` used later if turn continuity is needed.
- Images/files: out of scope v1 (gpt-all supports fileUrl/imageUrl but adds parity surface).
- No `no` streaming:` still supported — client collapses stream and returns full `data`.
- Claude protocol parity: inherits from the existing `/v1/messages` → `/v1/chat/completions` rewrite.