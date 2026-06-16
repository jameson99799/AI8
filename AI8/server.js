"use strict";

const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");

const packageJson = require("./package.json");
const AI8Client = require("./lib/ai8-client");
const { splitPreparedMessages } = require("./lib/message-layout");
const RuntimeConfigStore = require("./lib/runtime-config");
const RuntimeLogger = require("./lib/runtime-logger");
const { resolveSessionPrompt } = require("./lib/request-prompt");
    contentPartToAi8File,
    extractAi8Images,
    isProbablyImageFile,
    normalizeAi8FileInput,
} = require("./lib/media-utils");
const {
    buildAdminModelsList,
    buildChatCompletion,
    buildChatCompletionChunk,
    buildErrorPayload,
    buildImageGeneration,
    buildModelsList,
    normalizeUsage,
    randomId,
    toDisplayModelId,
} = require("./lib/openai-format");

const APP_NAME = "ai8-adapter";
const STARTED_AT = new Date();
const ADMIN_DIR = path.resolve(__dirname, "admin");

const configStore = new RuntimeConfigStore({
    envPath: path.resolve(__dirname, ".env"),
    storePath: process.env.AI8_CONFIG_PATH || path.resolve(__dirname, "data", "config.json"),
});

const logger = new RuntimeLogger({
    logPath: process.env.AI8_LOG_PATH || path.resolve(__dirname, "logs", "ai8-adapter.log"),
});

const clientState = {
    instance: null,
    signature: "",
};

registerProcessLogging();
announceAdminAccess("startup");

const app = express();
app.disable("x-powered-by");

app.use(dynamicJsonBodyParser);
app.use(requestLoggerMiddleware);

app.get("/", (req, res) => {
    const runtime = buildRuntimeSnapshot(req);
    res.json({
        admin_path: "/admin",
        endpoints: ["/health", "/admin", "/admin/api/runtime", "/v1/models", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits", "/ai8/sessions", "/ai8/records/:sessionId"],
        name: APP_NAME,
        runtime,
        status: "ok",
        version: packageJson.version,
    });
});

app.get("/health", (req, res) => {
    const config = getConfig();
    const preferredBaseUrl = buildBaseUrlCandidates(req, config)[0] || "";

    res.json({
        admin_auth_mode: configStore.getAdminAuthMode(),
        api_keys_configured: config.apiKeys.length,
        ok: true,
        openai_base_url: preferredBaseUrl ? `${preferredBaseUrl}/v1` : "",
        started_at: STARTED_AT.toISOString(),
        upstream_ready: Boolean(config.ai8AuthToken),
        version: packageJson.version,
    });
});

app.get("/admin/api/runtime", requireAdminAuth, (req, res) => {
    res.json(buildRuntimeSnapshot(req));
});

app.get("/admin/api/config", requireAdminAuth, (req, res) => {
    res.json({
        config: configStore.getEditableConfig(),
        effective: buildEffectiveConfigSummary(getConfig()),
    });
});

app.put("/admin/api/config", requireAdminAuth, (req, res) => {
    const patch = req.body || {};
    const changedKeys = Object.keys(patch || {}).filter(Boolean);
    const previousToken = extractAdminToken(req);
    const nextConfig = configStore.updateConfig(patch);

    invalidateClient();
    announceAdminAccess("config_update");

    logger.info("Runtime config updated", {
        adminAuthMode: configStore.getAdminAuthMode(),
        apiKeyCount: nextConfig.apiKeys.length,
        changedKeys,
        publicBaseUrlConfigured: Boolean(nextConfig.publicBaseUrl),
        upstreamReady: Boolean(nextConfig.ai8AuthToken),
    });

    const currentAdminTokens = configStore.getAdminTokens();
    res.json({
        config: configStore.getEditableConfig(),
        effective: buildEffectiveConfigSummary(nextConfig),
        ok: true,
        token_still_valid: Boolean(previousToken && currentAdminTokens.includes(previousToken)),
    });
});

app.get("/admin/api/models", requireAdminAuth, asyncHandler(async (req, res) => {
    const client = getClient();
    const models = await client.fetchModels({
        forceRefresh: parseBoolean(req.query.refresh, false),
    });

    res.json({
        count: models.length,
        data: buildAdminModelsList(models),
        default_model: toDisplayModelId(getConfig().ai8DefaultModel),
        object: "list",
        openai: buildModelsList(models),
    });
}));

app.post("/admin/api/test-upstream", requireAdminAuth, asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const config = getConfig();
    const client = getClient();
    const models = await client.fetchModels({
        forceRefresh: true,
    });

    let resolvedDefaultModel = null;
    let resolvedDefaultModelError = null;

    try {
        resolvedDefaultModel = (await client.resolveModel(config.ai8DefaultModel)).value;
    } catch (error) {
        resolvedDefaultModelError = error.message;
    }

    res.json({
        ai8_base_url: config.ai8BaseUrl,
        latency_ms: Date.now() - startedAt,
        model_count: models.length,
        ok: true,
        resolved_default_model: resolvedDefaultModel,
        resolved_default_model_error: resolvedDefaultModelError,
        sample_models: models.slice(0, 20).map(model => ({
            label: model?.label || model?.value || "",
            provider: model?.attr?.providerName || "ai8",
            value: toDisplayModelId(model?.value || ""),
        })),
        upstream_ready: Boolean(config.ai8AuthToken),
    });
}));

app.get("/admin/api/logs", requireAdminAuth, (req, res) => {
    const limit = parseNumber(req.query.limit, 200);
    res.json({
        buffered_entries: logger.getEntries(limit),
        log_path: logger.getLogPath(),
        ok: true,
        tail_lines: logger.readFileTail(limit),
    });
});

app.use("/admin", express.static(ADMIN_DIR, { index: "index.html" }));

app.use("/v1", requireLocalApiAuth);
app.use("/ai8", requireLocalApiAuth);

app.get("/ai8/sessions", asyncHandler(async (req, res) => {
    const sessions = await getClient().listSessions({
        page: req.query.page || 1,
        search: req.query.search || undefined,
    });

    res.json(sessions);
}));

app.post("/ai8/sessions", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const config = getConfig();
    const session = await getClient().createSession({
        contextCount: body.context_count,
        maxToken: body.max_tokens,
        mcp: body.mcp,
        model: body.model || config.ai8DefaultModel,
        name: body.name,
        plugins: body.plugins,
        prompt: body.prompt,
        rags: body.rags,
        temperature: body.temperature,
    });

    res.status(201).json(session);
}));

app.get("/ai8/records/:sessionId", asyncHandler(async (req, res) => {
    const records = await getClient().listRecords(req.params.sessionId, {
        page: req.query.page || 1,
    });

    res.json(decorateRecordsPayload(records));
}));

app.get("/v1/models", asyncHandler(async (req, res) => {
    const models = await getClient().fetchModels();
    res.json(buildModelsList(models));
}));

app.post("/v1/chat/completions", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const config = getConfig();
    const client = getClient();

    if (body.n && Number(body.n) !== 1) {
        throw createHttpError(400, "AI8 adapter currently supports only n=1.");
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
        throw createHttpError(400, "AI8 adapter does not support OpenAI tool calls yet.");
    }

    const requestModel = String(body.model || config.ai8DefaultModel).trim();
    const resolvedModel = await client.resolveModel(requestModel);
    const existingSessionId = null;
    const preparedMessages = await prepareMessages(body.messages, false, {
        injectSystemPromptOnReuse: config.ai8ReuseSessionInjectSystemPrompt,
        mediaFetchTimeoutMs: config.mediaFetchTimeoutMs,
    });
    const sessionPrompt = resolveSessionPrompt(body, preparedMessages);
    const created = Math.floor(Date.now() / 1000);
    const completionId = randomId("chatcmpl");
    const thinking = resolveThinking(req, body, config.ai8DefaultThinking);

    const isEphemeralSession = true;
    let session = await client.createSession({
        maxToken: body.max_tokens,
        model: resolvedModel.value,
        prompt: sessionPrompt.value,
        temperature: body.temperature,
    });

    if (sessionPrompt.value) {
        session = await client.updateSession(session, {
            prompt: sessionPrompt.value,
        });
    }

    res.setHeader("x-ai8-session-id", String(session.id));
    res.setHeader("x-ai8-session-prompt-source", String(sessionPrompt.source || "none"));
    res.setHeader("x-ai8-session-prompt-present", sessionPrompt.value ? "true" : "false");

    if (body.stream) {
        await handleStreamingChatCompletion(req, res, {
            client,
            completionId,
            created,
            deleteSessionAfterResponse: Boolean(config.ai8DeleteSessionAfterResponse && isEphemeralSession),
            model: resolvedModel.value,
            preparedMessages,
            sessionId: session.id,
            streamIncludeUsage: Boolean(body?.stream_options?.include_usage),
            thinking,
        });
        return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    let content = "";
    let finalRecord = null;

    const streamResult = await client.streamChatCompletion(
        {
            files: preparedMessages.files,
            sessionId: session.id,
            signal: abortController.signal,
            text: preparedMessages.text,
            thinking,
        },
        {
            onObject(record) {
                finalRecord = record;
                if (typeof record?.aiText === "string" && record.aiText) {
                    content = record.aiText;
                }
            },
            onText(chunk) {
                content += chunk;
            },
        }
    );

    if (streamResult?.taskId) {
        res.setHeader("x-ai8-task-id", String(streamResult.taskId));
    }

    const finalContent = resolveFinalContent(finalRecord || streamResult?.record, content);
    const images = extractAi8Images(finalContent);
    if (images.length > 0) {
        res.setHeader("x-ai8-image-count", String(images.length));
    }

    res.json(
        buildChatCompletion({
            content: finalContent,
            created,
            id: completionId,
            images,
            metadata: buildAi8Metadata({
                imageCount: images.length,
                sessionId: session.id,
                taskId: streamResult?.taskId || null,
            }),
            model: resolvedModel.value,
            usage: normalizeUsage(finalRecord || streamResult?.record),
        })
    );

    if (config.ai8DeleteSessionAfterResponse && isEphemeralSession) {
        scheduleSessionDeletion(client, session.id, "non_stream_response");
    }
}));

app.post("/v1/images/generations", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const config = getConfig();
    const client = getClient();
    const created = Math.floor(Date.now() / 1000);

    const requestModel = String(body.model || config.ai8DefaultModel).trim();
    const resolvedModel = await client.resolveModel(requestModel);
    
    // Construct a single message for image generation
    const messages = [{ role: "user", content: body.prompt }];
    const preparedMessages = await prepareMessages(messages, false, {
        mediaFetchTimeoutMs: config.mediaFetchTimeoutMs,
    });
    
    const sessionPrompt = resolveSessionPrompt(body, preparedMessages);
    let session = await client.createSession({
        model: resolvedModel.value,
        prompt: sessionPrompt.value,
        temperature: body.temperature,
    });

    if (sessionPrompt.value) {
        session = await client.updateSession(session, {
            prompt: sessionPrompt.value,
        });
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    let content = "";
    let finalRecord = null;

    const streamResult = await client.streamChatCompletion(
        {
            files: preparedMessages.files,
            sessionId: session.id,
            signal: abortController.signal,
            text: preparedMessages.text,
        },
        {
            onObject(record) {
                finalRecord = record;
                if (typeof record?.aiText === "string" && record.aiText) {
                    content = record.aiText;
                }
            },
            onText(chunk) {
                content += chunk;
            },
        }
    );

    const finalContent = resolveFinalContent(finalRecord || streamResult?.record, content);
    const images = extractAi8Images(finalContent);

    res.json(buildImageGeneration({ created, images }));

    if (config.ai8DeleteSessionAfterResponse) {
        scheduleSessionDeletion(client, session.id, "image_generation");
    }
}));

app.post("/v1/images/edits", asyncHandler(async (req, res) => {
    let body = req.body || {};
    let files = [];

    if (req.headers["content-type"]?.includes("multipart/form-data")) {
        const parts = await simpleMultipartParser(req);
        body = parts.fields;
        
        if (parts.files.image) {
            files.push(await normalizeAi8FileInput({
                data: parts.files.image.data.toString("base64"),
                mimeType: parts.files.image.mimeType,
                name: parts.files.image.filename,
                prefix: "image"
            }));
        }
        if (parts.files.mask) {
            files.push(await normalizeAi8FileInput({
                data: parts.files.mask.data.toString("base64"),
                mimeType: parts.files.mask.mimeType,
                name: parts.files.mask.filename,
                prefix: "mask"
            }));
        }
    } else {
        // Handle JSON case
        if (body.image) {
            files.push(await contentPartToAi8File({ type: "input_image", data: body.image }, { prefix: "image" }));
        }
        if (body.mask) {
            files.push(await contentPartToAi8File({ type: "input_image", data: body.mask }, { prefix: "mask" }));
        }
    }

    const config = getConfig();
    const client = getClient();
    const created = Math.floor(Date.now() / 1000);

    const requestModel = String(body.model || config.ai8DefaultModel).trim();
    const resolvedModel = await client.resolveModel(requestModel);

    const preparedMessages = {
        files,
        text: body.prompt || "Edit this image per instructions.",
    };

    let session = await client.createSession({
        model: resolvedModel.value,
        temperature: body.temperature,
    });

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    let content = "";
    let finalRecord = null;

    const streamResult = await client.streamChatCompletion(
        {
            files: preparedMessages.files,
            sessionId: session.id,
            signal: abortController.signal,
            text: preparedMessages.text,
        },
        {
            onObject(record) {
                finalRecord = record;
                if (typeof record?.aiText === "string" && record.aiText) {
                    content = record.aiText;
                }
            },
            onText(chunk) {
                content += chunk;
            },
        }
    );

    const finalContent = resolveFinalContent(finalRecord || streamResult?.record, content);
    const images = extractAi8Images(finalContent);

    res.json(buildImageGeneration({ created, images }));

    if (config.ai8DeleteSessionAfterResponse) {
        scheduleSessionDeletion(client, session.id, "image_edit");
    }
}));

app.use((error, req, res, next) => {
    const normalizedError = normalizeRequestError(error);
    const status = normalizedError.status;
    const message = normalizedError.message;

    logger[status >= 500 ? "error" : "warn"]("Request failed", {
        message,
        method: req.method,
        path: req.originalUrl,
        stack: status >= 500 ? error?.stack || null : null,
        status,
    });

    if (res.headersSent) {
        res.end();
        return;
    }

    res
        .status(status)
        .json(
            buildErrorPayload(
                status,
                message,
                status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error",
                normalizedError.code,
                normalizedError.details
            )
        );
});

const port = getConfig().port;
app.listen(port, "0.0.0.0", () => {
    logger.info("AI8 adapter listening", {
        adminUrl: "/admin",
        bind: `0.0.0.0:${port}`,
        port,
    });
});

async function handleStreamingChatCompletion(req, res, options) {
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    const {
        client,
        completionId,
        created,
        deleteSessionAfterResponse,
        model,
        preparedMessages,
        sessionId,
        streamIncludeUsage,
        thinking,
    } = options;

    let finalRecord = null;
    let streamedContent = "";

    res.status(200);
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    writeSse(
        res,
        buildChatCompletionChunk({
            created,
            delta: {
                content: "",
                role: "assistant",
            },
            id: completionId,
            model,
        })
    );

    try {
        const streamResult = await client.streamChatCompletion(
            {
                files: preparedMessages.files,
                sessionId,
                signal: abortController.signal,
                text: preparedMessages.text,
                thinking,
            },
            {
                onObject(record) {
                    finalRecord = record;
                },
                onText(chunk) {
                    streamedContent += chunk;
                    writeSse(
                        res,
                        buildChatCompletionChunk({
                            created,
                            delta: {
                                content: chunk,
                            },
                            id: completionId,
                            model,
                        })
                    );
                },
            }
        );

        finalRecord = finalRecord || streamResult?.record || null;
    } catch (error) {
        if (abortController.signal.aborted) {
            res.end();
            return;
        }

        throw error;
    }

    const finalContent = resolveFinalContent(finalRecord, streamedContent);
    const finalDelta = computeStreamFinalDelta(streamedContent, finalContent);
    if (finalDelta) {
        streamedContent += finalDelta;
        writeSse(
            res,
            buildChatCompletionChunk({
                created,
                delta: {
                    content: finalDelta,
                },
                id: completionId,
                model,
            })
        );
    }

    writeSse(
        res,
        buildChatCompletionChunk({
            created,
            delta: {},
            finishReason: "stop",
            id: completionId,
            model,
        })
    );

    if (streamIncludeUsage) {
        writeSse(
            res,
            buildChatCompletionChunk({
                created,
                delta: {},
                finishReason: null,
                id: completionId,
                model,
                usage: normalizeUsage(finalRecord),
            })
        );
    }

    res.write("data: [DONE]\n\n");
    res.end();

    if (deleteSessionAfterResponse) {
        scheduleSessionDeletion(client, sessionId, "stream_response");
    }
}

async function prepareMessages(messages, reuseSession, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw createHttpError(400, "messages must be a non-empty array.");
    }

    const normalized = (await Promise.all(messages.map((message, index) => normalizeMessage(message, index, options)))).filter(
        hasMessagePayload
    );
    const {
        assistantPrompt,
        conversation,
        systemPrompt,
    } = splitPreparedMessages(normalized, renderMessageText);
    if (conversation.length === 0) {
        throw createHttpError(400, "At least one non-system message is required.");
    }

    const lastUserMessage = [...conversation].reverse().find(message => message.role === "user");
    if (!lastUserMessage) {
        throw createHttpError(400, "At least one user message is required.");
    }

    const currentUserText = buildCurrentUserPrompt(lastUserMessage);
    if (reuseSession) {
        return {
            assistantPrompt,
            files: lastUserMessage.files,
            systemPrompt,
            text: options.injectSystemPromptOnReuse ? mergeSystemPromptIntoText(systemPrompt, currentUserText) : currentUserText,
        };
    }

    if (conversation.length === 1 && conversation[0].role === "user") {
        return {
            assistantPrompt,
            files: conversation[0].files,
            systemPrompt,
            text: buildCurrentUserPrompt(conversation[0]),
        };
    }

    const transcript = conversation
        .map(message => `${mapRoleLabel(message.role)}:\n${renderMessageText(message)}`)
        .join("\n\n");

    return {
        assistantPrompt,
        files: lastUserMessage.files,
        systemPrompt,
        text: [
            "Use the transcript below as conversation context and answer the final user message naturally.",
            "",
            transcript,
        ].join("\n"),
    };
}

async function normalizeMessage(message, index, options = {}) {
    if (!message || typeof message !== "object") {
        throw createHttpError(400, `messages[${index}] must be an object.`);
    }

    const role = String(message.role || "").trim();
    if (!role) {
        throw createHttpError(400, `messages[${index}].role is required.`);
    }

    const normalizedContent = await normalizeContent(message.content, index, options);

    return {
        files: normalizedContent.files,
        role,
        text: normalizedContent.text,
    };
}

async function normalizeContent(content, index, options = {}) {
    if (typeof content === "string") {
        return {
            files: [],
            text: content.trim(),
        };
    }

    if (!Array.isArray(content)) {
        throw createHttpError(400, `messages[${index}].content must be a string or an array.`);
    }

    const files = [];
    const parts = [];

    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
        const part = content[partIndex];
        if (typeof part === "string") {
            parts.push(part);
            continue;
        }

        if (!part || typeof part !== "object") {
            throw createHttpError(400, `messages[${index}] contains an invalid content part.`);
        }

        if (part.type === "text" || part.type === "input_text") {
            parts.push(String(part.text || "").trim());
            continue;
        }

        if (["image_url", "input_image", "input_file"].includes(part.type)) {
            try {
                files.push(
                    await contentPartToAi8File(part, {
                        messageIndex: index,
                        partIndex,
                        timeoutMs: options.mediaFetchTimeoutMs,
                    })
                );
            } catch (error) {
                throw createHttpError(400, `messages[${index}] ${error.message}`);
            }
            continue;
        }

        throw createHttpError(400, `Unsupported content type: ${part.type || "unknown"}`);
    }

    return {
        files,
        text: parts.filter(Boolean).join("\n").trim(),
    };
}

function dynamicJsonBodyParser(req, res, next) {
    const limit = getConfig().requestBodyLimit || "50mb";
    return express.json({ limit })(req, res, next);
}

function requestLoggerMiddleware(req, res, next) {
    const startedAt = Date.now();
    res.on("finish", () => {
        if (req.path === "/admin/api/logs") {
            return;
        }

        logger.info("HTTP request", {
            duration_ms: Date.now() - startedAt,
            ip: extractRequestIp(req),
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
        });
    });
    next();
}

function buildRuntimeSnapshot(req) {
    const config = getConfig();
    const baseUrlCandidates = buildBaseUrlCandidates(req, config);
    const preferredBaseUrl = baseUrlCandidates[0] || "";
    const localAddresses = listLocalIpv4Addresses();

    return {
        adapter: {
            name: APP_NAME,
            pid: process.pid,
            started_at: STARTED_AT.toISOString(),
            uptime_seconds: Math.round(process.uptime()),
            version: packageJson.version,
        },
        auth: {
            admin_mode: configStore.getAdminAuthMode(),
            api_key_count: config.apiKeys.length,
            local_api_protected: config.apiKeys.length > 0,
            upstream_ready: Boolean(config.ai8AuthToken),
        },
        config: {
            ai8_base_url: config.ai8BaseUrl,
            ai8_delete_session_after_response: config.ai8DeleteSessionAfterResponse,
            ai8_default_model: toDisplayModelId(config.ai8DefaultModel),
            ai8_request_timeout_ms: config.ai8RequestTimeoutMs,
            ai8_reuse_session_inject_system_prompt: config.ai8ReuseSessionInjectSystemPrompt,
            ai8_use_shared_session: config.ai8UseSharedSession,
            ai8_shared_session_id: config.ai8SharedSessionId,
            media_fetch_timeout_ms: config.mediaFetchTimeoutMs,
            public_base_url: config.publicBaseUrl,
            request_body_limit: config.requestBodyLimit,
            x_app_version: config.ai8XAppVersion,
        },
        network: {
            base_url_candidates: baseUrlCandidates,
            hostname: os.hostname(),
            ipv4_candidates: localAddresses,
            openai_base_url: preferredBaseUrl ? `${preferredBaseUrl}/v1` : "",
            preferred_base_url: preferredBaseUrl,
        },
        paths: {
            config_store: configStore.getStorePath(),
            log_file: logger.getLogPath(),
        },
    };
}

function buildEffectiveConfigSummary(config) {
    return {
        admin_auth_mode: configStore.getAdminAuthMode(),
        ai8_auth_configured: Boolean(config.ai8AuthToken),
        ai8_base_url: config.ai8BaseUrl,
        ai8_delete_session_after_response: config.ai8DeleteSessionAfterResponse,
        ai8_default_model: toDisplayModelId(config.ai8DefaultModel),
        ai8_request_timeout_ms: config.ai8RequestTimeoutMs,
        ai8_reuse_session_inject_system_prompt: config.ai8ReuseSessionInjectSystemPrompt,
        ai8_use_shared_session: config.ai8UseSharedSession,
        ai8_shared_session_id: config.ai8SharedSessionId,
        api_key_count: config.apiKeys.length,
        config_store: configStore.getStorePath(),
        log_file: logger.getLogPath(),
        media_fetch_timeout_ms: config.mediaFetchTimeoutMs,
        port: config.port,
        public_base_url: config.publicBaseUrl,
        request_body_limit: config.requestBodyLimit,
        x_app_version: config.ai8XAppVersion,
    };
}

function buildBaseUrlCandidates(req, config) {
    const candidates = [];
    const port = config.port;

    addCandidate(candidates, normalizeBaseUrl(config.publicBaseUrl));

    const forwardedProto = getForwardedValue(req.headers["x-forwarded-proto"]);
    const forwardedHost = getForwardedValue(req.headers["x-forwarded-host"]);
    const host = forwardedHost || String(req.get("host") || "").trim();
    const protocol = forwardedProto || String(req.protocol || "http").trim() || "http";
    if (host) {
        addCandidate(candidates, `${protocol}://${host}`);
    }

    addCandidate(candidates, `http://127.0.0.1:${port}`);
    addCandidate(candidates, `http://localhost:${port}`);

    for (const address of listLocalIpv4Addresses()) {
        addCandidate(candidates, `http://${address}:${port}`);
    }

    return candidates;
}

function addCandidate(list, value) {
    const normalized = normalizeBaseUrl(value);
    if (!normalized || list.includes(normalized)) {
        return;
    }

    list.push(normalized);
}

function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function listLocalIpv4Addresses() {
    const networkInterfaces = os.networkInterfaces();
    const addresses = [];

    for (const entries of Object.values(networkInterfaces)) {
        if (!Array.isArray(entries)) {
            continue;
        }

        for (const entry of entries) {
            if (!entry || entry.internal || entry.family !== "IPv4") {
                continue;
            }

            if (!addresses.includes(entry.address)) {
                addresses.push(entry.address);
            }
        }
    }

    return addresses;
}

function getForwardedValue(headerValue) {
    return String(headerValue || "")
        .split(",")
        .map(item => item.trim())
        .find(Boolean) || "";
}

function getConfig() {
    return configStore.getConfig();
}

function getClient(options = {}) {
    const config = getConfig();
    if (!config.ai8AuthToken) {
        if (options.optional) {
            return null;
        }

        throw createHttpError(503, "AI8 upstream token is not configured. Open /admin and save AI8_AUTH_TOKEN first.");
    }

    const signature = JSON.stringify({
        ai8AuthToken: config.ai8AuthToken,
        ai8BaseUrl: config.ai8BaseUrl,
        ai8DefaultModel: config.ai8DefaultModel,
        ai8RequestTimeoutMs: config.ai8RequestTimeoutMs,
        ai8XAppVersion: config.ai8XAppVersion,
    });

    if (!clientState.instance || clientState.signature !== signature) {
        clientState.instance = new AI8Client({
            authToken: config.ai8AuthToken,
            baseUrl: config.ai8BaseUrl,
            defaultModel: config.ai8DefaultModel,
            requestTimeoutMs: config.ai8RequestTimeoutMs,
            xAppVersion: config.ai8XAppVersion,
        });
        clientState.signature = signature;

        logger.info("AI8 client refreshed", {
            ai8BaseUrl: config.ai8BaseUrl,
            ai8DefaultModel: config.ai8DefaultModel,
            requestTimeoutMs: config.ai8RequestTimeoutMs,
        });
    }

    return clientState.instance;
}

function invalidateClient() {
    clientState.instance = null;
    clientState.signature = "";
}

function announceAdminAccess(reason) {
    if (configStore.getAdminAuthMode() !== "generated_token") {
        return;
    }

    const generatedToken = configStore.getAdminTokens()[0] || "";
    if (!generatedToken) {
        return;
    }

    logger.warn("Admin console is protected by a generated temporary token", {
        adminUrl: "/admin",
        reason,
        token: generatedToken,
    });
}

function requireAdminAuth(req, res, next) {
    const adminTokens = configStore.getAdminTokens();
    const candidate = extractAdminToken(req);

    if (candidate && adminTokens.includes(candidate)) {
        return next();
    }

    res
        .status(401)
        .json(
            buildErrorPayload(
                401,
                "A valid admin token is required. Use ADMIN_TOKEN, one of API_KEYS, or the generated startup token.",
                "authentication_error"
            )
        );
}

function requireLocalApiAuth(req, res, next) {
    const apiKeys = getConfig().apiKeys;
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
        return next();
    }

    const candidate = extractLocalApiToken(req);
    if (candidate && apiKeys.includes(candidate)) {
        return next();
    }

    res.status(401).json(buildErrorPayload(401, "A valid local API key is required.", "authentication_error"));
}

function extractAdminToken(req) {
    const bearerToken = extractBearerToken(req.headers.authorization);
    const headerToken = String(req.headers["x-admin-token"] || "").trim();
    const queryToken = String(req.query.token || req.query.admin_token || "").trim();

    return bearerToken || headerToken || queryToken;
}

function extractLocalApiToken(req) {
    const bearerToken = extractBearerToken(req.headers.authorization);
    const headerToken = String(req.headers["x-api-key"] || "").trim();
    const queryToken = String(req.query.key || req.query.api_key || "").trim();

    return bearerToken || headerToken || queryToken;
}

function extractBearerToken(authorizationHeader) {
    const authorization = String(authorizationHeader || "");
    if (!authorization.toLowerCase().startsWith("bearer ")) {
        return "";
    }

    return authorization.slice(7).trim();
}

function extractRequestIp(req) {
    return getForwardedValue(req.headers["x-forwarded-for"]) || req.ip || "";
}

function extractSessionId(req, body, fallbackSessionId = null) {
    const fromHeader = req.headers["x-ai8-session-id"];
    const fromMetadata = body?.metadata?.ai8_session_id;
    const candidate = fromHeader ?? fromMetadata ?? body?.ai8_session_id ?? fallbackSessionId;

    if (candidate === undefined || candidate === null || candidate === "") {
        return null;
    }

    const numericCandidate = Number(candidate);
    if (Number.isFinite(numericCandidate)) {
        return numericCandidate;
    }

    throw createHttpError(400, "x-ai8-session-id must be numeric.");
}

function resolveThinking(req, body, fallback) {
    const headerValue = req.headers["x-ai8-thinking"];
    if (headerValue !== undefined) {
        return parseBoolean(headerValue, fallback);
    }

    if (body?.metadata && Object.prototype.hasOwnProperty.call(body.metadata, "ai8_thinking")) {
        return Boolean(body.metadata.ai8_thinking);
    }

    return fallback;
}

function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function mapRoleLabel(role) {
    switch (role) {
        case "assistant":
            return "Assistant";
        case "tool":
            return "Tool";
        case "user":
            return "User";
        default:
            return "System";
    }
}

function hasMessagePayload(message) {
    return Boolean(message?.text) || (Array.isArray(message?.files) && message.files.length > 0);
}

function renderMessageText(message) {
    const parts = [];
    if (message?.text) {
        parts.push(message.text);
    }

    const attachmentNote = buildAttachmentNote(message?.files);
    if (attachmentNote) {
        parts.push(attachmentNote);
    }

    return parts.filter(Boolean).join("\n").trim();
}

function buildCurrentUserPrompt(message) {
    const rendered = renderMessageText(message);
    if (rendered) {
        return rendered;
    }

    if (Array.isArray(message?.files) && message.files.length > 0) {
        return "Please review the attached images or files.";
    }

    return "";
}

function mergeSystemPromptIntoText(systemPrompt, userText) {
    const normalizedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    const normalizedUserText = typeof userText === "string" ? userText.trim() : "";

    if (!normalizedSystemPrompt) {
        return normalizedUserText;
    }

    if (!normalizedUserText) {
        return [
            "请严格遵守以下角色设定和系统提示词：",
            normalizedSystemPrompt,
        ].join("\n\n");
    }

    return [
        "请严格遵守以下角色设定和系统提示词：",
        normalizedSystemPrompt,
        "",
        "用户本次消息：",
        normalizedUserText,
    ].join("\n");
}

function buildAttachmentNote(files) {
    if (!Array.isArray(files) || files.length === 0) {
        return "";
    }

    const label = files.every(isProbablyImageFile) ? "Attached images" : "Attached files";
    const names = files
        .map(file => String(file?.name || "").trim())
        .filter(Boolean);

    return names.length > 0 ? `[${label}: ${names.join(", ")}]` : `[${label}: ${files.length}]`;
}

function resolveFinalContent(finalRecord, fallbackContent = "") {
    if (typeof finalRecord?.aiText === "string" && finalRecord.aiText) {
        return finalRecord.aiText;
    }

    return typeof fallbackContent === "string" ? fallbackContent : "";
}

function computeStreamFinalDelta(streamedContent, finalContent) {
    const liveContent = typeof streamedContent === "string" ? streamedContent : "";
    const resolvedContent = typeof finalContent === "string" ? finalContent : "";

    if (!resolvedContent || resolvedContent === liveContent) {
        return "";
    }

    if (resolvedContent.startsWith(liveContent)) {
        return resolvedContent.slice(liveContent.length);
    }

    return liveContent ? `\n\n${resolvedContent}` : resolvedContent;
}

function decorateRecordsPayload(payload) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }

    if (!Array.isArray(payload.records)) {
        return payload;
    }

    return {
        ...payload,
        records: payload.records.map(decorateRecord),
    };
}

function decorateRecord(record) {
    if (!record || typeof record !== "object") {
        return record;
    }

    return {
        ...record,
        ai8_images: extractAi8Images(record.aiText),
        ai8_input_images: Array.isArray(record.useImages) ? record.useImages : [],
    };
}

function buildAi8Metadata(options = {}) {
    const metadata = {};

    if (Number.isFinite(Number(options.imageCount)) && Number(options.imageCount) > 0) {
        metadata.image_count = Number(options.imageCount);
    }

    if (options.sessionId !== undefined && options.sessionId !== null) {
        metadata.session_id = options.sessionId;
    }

    if (options.taskId) {
        metadata.task_id = options.taskId;
    }

    return Object.keys(metadata).length > 0 ? metadata : null;
}

function scheduleSessionDeletion(client, sessionId, reason) {
    const normalizedSessionId = Number(sessionId);
    if (!Number.isFinite(normalizedSessionId)) {
        return;
    }

    setTimeout(() => {
        client.deleteSession(normalizedSessionId).then(() => {
            logger.info("AI8 session deleted after response", {
                reason,
                sessionId: normalizedSessionId,
            });
        }).catch(error => {
            logger.warn("Failed to delete AI8 session after response", {
                error: error?.message || String(error),
                reason,
                sessionId: normalizedSessionId,
            });
        });
    }, 0);
}

function normalizeRequestError(error) {
    if (error?.type === "entity.too.large") {
        return {
            message: `Request body exceeded REQUEST_BODY_LIMIT (${getConfig().requestBodyLimit}).`,
            status: 413,
        };
    }

    if (error?.type === "entity.parse.failed") {
        return {
            message: "Request body is not valid JSON.",
            status: 400,
        };
    }

    const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
    const message =
        error?.message ||
        (status >= 500 ? "Unexpected server error." : "Request failed.");

    return {
        code: error?.code || null,
        details: error?.upstream || null,
        message,
        status,
    };
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    if (typeof value === "boolean") {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }

    return fallback;
}

function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function isImageModel(modelId, config) {
    const displayId = toDisplayModelId(modelId);
    const configuredModels = config.ai8ImageModels || [];
    return configuredModels.some(m => 
        displayId.toLowerCase() === m.toLowerCase() || 
        modelId.toLowerCase() === m.toLowerCase()
    );
}

/**
 * A robust basic multipart/form-data parser since we don't have multer.
 * Handles binary data accurately and supports common field structures.
 */
async function simpleMultipartParser(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) {
            return reject(new Error("No boundary found in multipart content-type"));
        }
        
        const boundary = "--" + (boundaryMatch[1] || boundaryMatch[2]);
        const chunks = [];
        
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
            try {
                const buffer = Buffer.concat(chunks);
                const parts = { fields: {}, files: {} };
                
                let cursor = 0;
                while (cursor < buffer.length) {
                    // Find the next boundary
                    const start = buffer.indexOf(boundary, cursor);
                    if (start === -1) break;
                    
                    // Check if it's the end boundary
                    if (buffer.toString("utf8", start + boundary.length, start + boundary.length + 2) === "--") {
                        break;
                    }
                    
                    // Move cursor past boundary and the following CRLF
                    const partStart = start + boundary.length + 2; 
                    
                    // Find end of headers
                    const headerEnd = buffer.indexOf("\r\n\r\n", partStart);
                    if (headerEnd === -1) break;
                    
                    const headerText = buffer.toString("utf8", partStart, headerEnd);
                    const contentStart = headerEnd + 4;
                    
                    // Find the start of the next boundary to determine content end
                    const nextStart = buffer.indexOf(boundary, contentStart);
                    if (nextStart === -1) break;
                    
                    // The boundary is preceded by CRLF
                    const contentEnd = nextStart - 2; 
                    const content = buffer.slice(contentStart, contentEnd);
                    
                    const nameMatch = headerText.match(/name="([^"]+)"/i);
                    const filenameMatch = headerText.match(/filename="([^"]+)"/i);
                    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

                    if (nameMatch) {
                        const name = nameMatch[1];
                        if (filenameMatch) {
                            parts.files[name] = {
                                data: content,
                                filename: filenameMatch[1],
                                mimeType: typeMatch ? typeMatch[1].trim() : "application/octet-stream"
                            };
                            logger.info("Parsed file part", { name, filename: filenameMatch[1], size: content.length });
                        } else {
                            parts.fields[name] = content.toString("utf8").trim();
                            logger.info("Parsed field part", { name, length: content.length });
                        }
                    }
                    
                    cursor = nextStart;
                }
                
                resolve(parts);
            } catch (err) {
                logger.error("Multipart parsing failed", { error: err.message });
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function registerProcessLogging() {
    process.on("unhandledRejection", reason => {
        logger.error("Unhandled promise rejection", {
            reason: reason instanceof Error ? reason.stack || reason.message : reason,
        });
    });

    process.on("uncaughtExceptionMonitor", error => {
        logger.error("Uncaught exception", {
            error: error?.stack || error?.message || String(error),
        });
    });
}
