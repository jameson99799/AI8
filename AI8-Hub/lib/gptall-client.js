"use strict";

class GptAllClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || "https://gpt-all.chat/api").replace(/\/+$/, "");
        this.authToken = String(options.authToken || "").trim();
        this.cookie = String(options.cookie || "").trim();
        this.fingerprint = String(options.fingerprint || "89346554").trim();
        this.xWebsiteDomain = String(options.xWebsiteDomain || options.siteOrigin || "").trim();
        this.defaultModel = String(options.defaultModel || "").trim();
        this.deleteGroupAfterResponse = options.deleteGroupAfterResponse !== false;
        this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
            ? Number(options.requestTimeoutMs)
            : 300000;
        this.modelCacheTtlMs = Number.isFinite(Number(options.modelCacheTtlMs))
            ? Number(options.modelCacheTtlMs)
            : 300000;
        this.modelCache = {
            data: null,
            expiresAt: 0,
        };

        if (!this.authToken) {
            throw new Error("gpt-all.AuthToken is required.");
        }
    }

    _resolveOrigin() {
        if (this.xWebsiteDomain) {
            return this.xWebsiteDomain;
        }
        // derive the site origin from the api base url, e.g. https://gpt-all.chat/api -> https://gpt-all.chat
        try {
            const url = new URL(this.baseUrl);
            return url.origin;
        } catch (error) {
            return "https://gpt-all.chat";
        }
    }

    async fetchModels({ forceRefresh = false } = {}) {
        const now = Date.now();
        if (!forceRefresh && this.modelCache.data && now < this.modelCache.expiresAt) {
            return this.modelCache.data;
        }

        const data = await this.requestJson("/models/list");
        const models = this._flattenModels(data);
        this.modelCache = {
            data: models,
            expiresAt: now + this.modelCacheTtlMs,
        };
        return models;
    }

    _flattenModels(data = {}) {
        const maps = data?.modelMaps || {};
        const models = [];
        for (const group of Object.values(maps)) {
            if (!Array.isArray(group)) {
                continue;
            }
            for (const item of group) {
                if (!item || typeof item !== "object") {
                    continue;
                }
                const model = String(item.model || "").trim();
                if (!model) {
                    continue;
                }
                models.push({
                    ...item,
                    label: String(item.modelName || item.model || ""),
                    value: model,
                });
            }
        }
        return models;
    }

    async resolveModel(model) {
        const requested = String(model || this.defaultModel || "").trim();
        if (!requested) {
            throw this._buildError("gptall model name is required.", 400);
        }

        const models = await this.fetchModels();
        const normalizedRequested = requested.toLowerCase();

        const exactMatch = models.find(item => String(item.value || "").toLowerCase() === normalizedRequested);
        if (exactMatch) {
            return exactMatch;
        }

        const shortMatches = models.filter(item => {
            const shortName = String(item.value || "").split("/").pop();
            return shortName && shortName.toLowerCase() === normalizedRequested;
        });

        if (shortMatches.length === 1) {
            return shortMatches[0];
        }

        if (shortMatches.length > 1) {
            throw this._buildError(`Model "${requested}" is ambiguous on gpt-all. Use the full model id instead.`, 400);
        }

        throw this._buildError(`Model "${requested}" was not found on gpt-all.`, 400);
    }

    async streamChatCompletion(options = {}, handlers = {}) {
        const model = await this.resolveModel(options.model);
        const groupId = await this._createGroup();
        let groupUpdated = false;

        try {
            await this._updateGroupModel(groupId, model);
            groupUpdated = true;

            const payload = {
                model: model.value,
                modelName: normalizeGptAllModelName(model),
                modelType: Number(model.modelType) || 1,
                prompt: options.text || "",
                imageUrl: "",
                videoUrl: "",
                fileUrl: "",
                extraParam: {
                    size: "auto",
                    style: "",
                },
                appId: 0,
                options: {
                    groupId,
                    fileParsing: "",
                    usingDeepThinking: Boolean(options.thinking),
                    usingTool: false,
                    imageUrl: "",
                    runtimeSearchTool: false,
                    runtimeSearchToolNonce: "",
                },
                usingPluginId: 0,
                drawId: "",
                usingTool: false,
                runtimeSearchTool: false,
                runtimeSearchToolNonce: "",
            };

            const response = await this._fetch("/chatgpt/chat-process", {
                body: payload,
                method: "POST",
                signal: options.signal,
                timeoutMs: options.timeoutMs,
            });

            if (!response.ok) {
                const responsePayload = await this._readUnexpectedPayload(response);
                throw this._normalizeError(responsePayload, response.status);
            }

            const contentType = String(response.headers.get("content-type") || "");
            if (contentType.startsWith("application/json")) {
                const jsonPayload = await response.json();
                throw this._normalizeError(jsonPayload, response.status || 502);
            }

            const decoder = new TextDecoder();
            let buffer = "";
            let finalRecord = null;
            let chatId = null;
            let lineNumber = 0;

            const processLine = rawLine => {
                if (!rawLine.trim()) {
                    return;
                }

                let parsed;
                try {
                    parsed = JSON.parse(rawLine);
                } catch (error) {
                    if (typeof handlers.onError === "function") {
                        handlers.onError(error, rawLine);
                    }
                    return;
                }

                if (typeof parsed?.chatId === "number" && !chatId) {
                    chatId = parsed.chatId;
                }

                const isFinalLine =
                    parsed?.done === true ||
                    parsed?.finish === true ||
                    parsed?.finishReason === "fallback_failed" ||
                    (typeof parsed?.data?.llm?.response === "string" && parsed.data.llm.response !== "") ||
                    typeof parsed?.data?.content === "string" ||
                    (typeof parsed?.content === "string" && parsed.content !== "");

                if (!isFinalLine) {
                    const delta = extractTextDelta(parsed);
                    if (delta && typeof handlers.onText === "function") {
                        handlers.onText(delta, parsed);
                    }
                }

                if (isFinalLine) {
                    finalRecord = parsed;
                }
            };

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

            if (buffer.slice(readOffset).trim()) {
                lineNumber += 1;
                processLine(buffer.slice(readOffset).trim());
            }

            if (typeof handlers.onDone === "function") {
                handlers.onDone();
            }

            const record = extractAnswerRecord(finalRecord);
            if (record && typeof handlers.onObject === "function") {
                handlers.onObject(record, finalRecord);
            }

            return {
                chatId,
                groupId,
                record,
            };
        } finally {
            if (groupUpdated && this.deleteGroupAfterResponse) {
                this._deleteGroup(groupId).catch(() => {});
            }
        }
    }

    async _createGroup() {
        const data = await this.requestJson("/group/create", {
            body: { appId: 0 },
            method: "POST",
        });
        const groupId = Number(data?.id);
        if (!Number.isFinite(groupId) || groupId <= 0) {
            throw this._buildError("gpt-all failed to create a chat group.", 502);
        }
        return groupId;
    }

    async _updateGroupModel(groupId, model) {
        const data = await this.requestJson("/group/update", {
            body: {
                groupId: String(groupId),
                config: JSON.stringify({ modelInfo: model }),
            },
            method: "POST",
        });
        return data;
    }

    async _deleteGroup(groupId) {
        const data = await this.requestJson("/group/del", {
            body: { groupId },
            method: "POST",
        });
        return data;
    }

    async requestJson(path, options = {}) {
        const response = await this._fetch(path, options);
        const text = await response.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            throw this._buildError(`gpt-all returned a non-JSON response for ${path}: ${text}`, 502);
        }

        const code = Number(payload?.code);
        if (!response.ok || (Number.isFinite(code) && code !== 0 && code !== 200)) {
            throw this._normalizeError(payload, response.status);
        }

        return payload?.data;
    }

    async _fetch(path, options = {}) {
        const {
            body,
            headers = {},
            method = "GET",
            query,
            signal,
            timeoutMs = this.requestTimeoutMs,
        } = options;

        const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`);
        if (query && typeof query === "object") {
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined || value === null || value === "") {
                    continue;
                }
                url.searchParams.set(key, String(value));
            }
        }

        const origin = this._resolveOrigin();
        const requestHeaders = {
            accept: "application/json, text/plain, */*",
            authorization: `Bearer ${this.authToken}`,
            "content-type": "application/json; charset=utf-8",
            origin,
            referer: `${origin}/`,
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
            "x-website-domain": origin,
            ...(this.cookie ? { cookie: this.cookie } : {}),
            ...(this.fingerprint ? { fingerprint: this.fingerprint } : {}),
            ...headers,
        };

        let requestBody = body;
        if (body && typeof body === "object" && !Buffer.isBuffer(body) && typeof body.pipe !== "function") {
            requestBody = JSON.stringify(body);
        }

        const mergedSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);

        return fetch(url, {
            body: requestBody,
            headers: requestHeaders,
            method,
            signal: mergedSignal,
        });
    }

    async _readUnexpectedPayload(response) {
        const text = await response.text();
        return text;
    }

    _normalizeError(source, status = 500) {
        if (source instanceof Error) {
            source.status = source.status || status;
            return source;
        }

        let message = "";
        if (typeof source === "string") {
            message = source;
        } else if (source && typeof source === "object") {
            message =
                source.err ||
                source.msg ||
                source.message ||
                source.error?.message ||
                source.fallbackNotice ||
                source.fallbackReasonText ||
                `gpt-all request failed with status ${status}`;
        }

        const resolvedStatus = this._resolveErrorStatus(source || message, status, message);
        const error = this._buildError(message || "gpt-all request failed.", resolvedStatus);
        if (source && typeof source === "object") {
            if (source.code !== undefined) {
                error.code = source.code;
            }
            error.upstream = source;
        }
        return error;
    }

    _resolveErrorStatus(source, status, message) {
        const numericStatus = Number(status);
        if (Number.isFinite(numericStatus) && numericStatus >= 400 && numericStatus < 600) {
            return numericStatus;
        }

        const text = String(message || "").trim().toLowerCase();
        if (!text) {
            return 502;
        }

        if (
            text.includes("授权") ||
            text.includes("登录") ||
            text.includes("鉴权") ||
            text.includes("token") ||
            text.includes("key") ||
            text.includes("unauthorized") ||
            text.includes("invalid")
        ) {
            return 401;
        }

        if (
            text.includes("额度") ||
            text.includes("次数") ||
            text.includes("quota") ||
            text.includes("rate limit") ||
            text.includes("exhausted")
        ) {
            return 429;
        }

        return 502;
    }

    _buildError(message, status = 500) {
        const error = new Error(message);
        error.status = status;
        return error;
    }
}

function normalizeGptAllModelName(model) {
    const raw = String(model?.modelName || model?.label || model?.value || "");
    return raw
        .replace(/（免费）|\(免费\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractTextDelta(parsed) {
    if (typeof parsed?.text === "string" && parsed.text) {
        return parsed.text;
    }

    if (Array.isArray(parsed?.content)) {
        const parts = [];
        for (const part of parsed.content) {
            if (part?.type === "text" && typeof part.text === "string" && part.text) {
                parts.push(part.text);
            }
        }
        if (parts.length > 0) {
            return parts.join("");
        }
    }

    return "";
}

function extractAnswerRecord(record) {
    if (!record || typeof record !== "object") {
        return record;
    }

    const finalRecord = { ...record };

    const llmResponse = record?.data?.llm?.response;
    if (typeof llmResponse === "string" && llmResponse) {
        finalRecord.content = llmResponse;
        finalRecord.text = llmResponse;
    } else if (typeof record?.content === "string" && record.content) {
        try {
            const workflow = JSON.parse(record.content);
            const llm = workflow?.data?.llm || workflow?.llm;
            const workflowResponse = typeof llm?.response === "string" && llm.response ? llm.response : "";
            if (workflowResponse) {
                finalRecord.content = workflowResponse;
                finalRecord.text = workflowResponse;
            }
            const workflowTokens = Number(workflow?.data?.tokenUsage?.totalTokens);
            if (Number.isFinite(workflowTokens) && workflowTokens > 0 && !Number.isFinite(Number(finalRecord.totalTokens))) {
                finalRecord.totalTokens = workflowTokens;
            }
            if (typeof llm?.reasoning === "string" && llm.reasoning) {
                finalRecord.reasoning_content = llm.reasoning;
            }
        } catch (error) {
            // content is plain text, keep as-is
        }
    }

    if (!finalRecord.content && record?.content && typeof record.content === "string") {
        finalRecord.content = record.content;
    }

    if (finalRecord.content && typeof record?.data?.llm?.reasoning === "string") {
        finalRecord.reasoning_content = record.data.llm.reasoning || "";
    }

    return finalRecord;
}

module.exports = GptAllClient;