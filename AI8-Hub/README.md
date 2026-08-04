# AI8 Adapter

`AI8/` is a standalone Node/Express adapter that exposes an OpenAI-compatible API for `ai8.rcouyi.com`.

## What It Supports

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /ai8/sessions`
- `POST /ai8/sessions`
- `GET /ai8/records/:sessionId`
- `GET /admin`
- `GET /admin/api/runtime`
- `GET /admin/api/config`
- `PUT /admin/api/config`
- `GET /admin/api/models`
- `POST /admin/api/test-upstream`
- `GET /admin/api/logs`

Current chat features:

- text chat
- image upload
- image understanding
- image generation result extraction
- runtime web console
- Docker deployment
- persisted config and log files

## Privacy Boundary

This adapter does not provide a chat frontend.
Requests and responses go through the API only.

Local behavior:

- the admin console is only for config, logs, and runtime inspection
- the local log file records request metadata, not chat message bodies
- the adapter itself does not create a local conversation UI or local chat history

Upstream boundary:

- AI8 may still keep server-side sessions or records on its own platform
- this adapter cannot disable upstream retention unless AI8 provides such a mode

## Environment

Copy `.env.example` to `.env`.

Minimum required value:

```env
AI8_AUTH_TOKEN=your_ai8_token
```

Common settings:

```env
PORT=7862
API_KEYS=your-local-api-key
ADMIN_TOKEN=your-admin-token
AI8_BASE_URL=https://ai8.rcouyi.com/api
AI8_DEFAULT_MODEL=openai_chat::gpt-4.1-mini
AI8_DEFAULT_THINKING=false
AI8_REQUEST_TIMEOUT_MS=300000
AI8_SHARED_SESSION_ID=
MEDIA_FETCH_TIMEOUT_MS=60000
REQUEST_BODY_LIMIT=50mb
PUBLIC_BASE_URL=
AI8_CONFIG_PATH=./data/config.json
AI8_LOG_PATH=./logs/ai8-adapter.log
```

Optional gpt-all channel (independent channel, models get the `【gpt-all】` suffix):

```env
GPTALL_ENABLED=true
GPTALL_AUTH_TOKEN=your_gptall_jwt
GPTALL_COOKIE=fl_ua_key=...
GPTALL_FINGERPRINT=89346554
GPTALL_BASE_URL=https://gpt-all.chat/api
GPTALL_DEFAULT_MODEL=doubao-seed-2.0-lite
GPTALL_ALLOWED_MODELS=doubao-seed-2.0-lite,gpt-5.4-mini
GPTALL_REQUEST_TIMEOUT_MS=300000
```

Notes:

- `API_KEYS` protects your local OpenAI-compatible API.
- `ADMIN_TOKEN` protects `/admin/api/*`.
- If `ADMIN_TOKEN` is empty, the admin console accepts one of `API_KEYS`.
- If both `ADMIN_TOKEN` and `API_KEYS` are empty, the server generates a temporary admin token and prints it into the log.
- Changes made in the web console are persisted into `data/config.json`.
- If `AI8_SHARED_SESSION_ID` is set, chat requests reuse that AI8 session by default instead of creating a new AI8 conversation each time.

## Run Locally

From the repo root:

```bash
node AI8/server.js
```

Or use the standalone folder:

```bash
cd AI8
npm install
npm start
```

Windows one-click local startup:

```bat
AI8\run-local.bat
```

Server deployment guide:

- `AI8/SERVER_DEPLOY_CN.md`

## Docker

Build and run:

```bash
cd AI8
docker compose up -d --build
```

Persistent paths:

- `./data` -> `/app/data`
- `./logs` -> `/app/logs`

The compose file mounts both directories so runtime config changes and logs survive container restarts.

## Admin Console

Open:

```text
http://YOUR_HOST:7862/admin
```

The console can:

- view effective runtime settings
- update AI8 token, local API keys, admin token, timeouts, default model, and public base URL
- configure the gpt-all channel (token, cookie, fingerprint, default model, whitelist)
- fetch the current upstream model list
- test upstream connectivity
- inspect persisted log output
- show the current OpenAI-compatible base URL derived from the request host or `PUBLIC_BASE_URL`

## OpenAI-Compatible Usage

Get models:

```bash
curl http://127.0.0.1:7862/v1/models \
  -H "Authorization: Bearer your-local-api-key"
```

Chat:

```bash
curl http://127.0.0.1:7862/v1/chat/completions \
  -H "Authorization: Bearer your-local-api-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"openai_chat::gpt-4.1-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly OK\"}]}"
```

Image understanding:

```json
{
  "model": "openai_chat::gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe the image in one short sentence." },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ]
}
```

Image generation still uses `POST /v1/chat/completions`.
When AI8 returns generated images, the adapter exposes them in `choices[0].message.ai8_images`.

## Response Headers

- `x-ai8-session-id`
- `x-ai8-task-id`
- `x-ai8-image-count`
