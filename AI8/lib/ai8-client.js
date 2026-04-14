"use strict";

class AI8Client {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || "https://ai8.rcouyi.com/api").replace(/\/+$/, "");
        this.authToken = String(options.authToken || "").trim();
        this.xAppVersion = String(options.xAppVersion || "3.0.1").trim();
        this.defaultModel = String(options.defaultModel || "").trim();
        this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
            ? Number(options.requestTimeoutMs)
            : 300000;
        this.modelCacheTtlMs = Number.isFinite(Number(options.modelCacheTtlMs))
            ? Number(options.modelCacheTtlMs)
            : 300000;
        this.templateCache = {
            data: null,
            expiresAt: 0,
        };

        if (!this.authToken) {
            throw new Error("AI8_AUTH_TOKEN is required.");
        }
    }

    async fetchTemplate({ forceRefresh = false } = {}) {
        const now = Date.now();
        if (!forceRefresh && this.templateCache.data && now < this.templateCache.expiresAt) {
            return this.templateCache.data;
        }

        const data = await this.requestJson("/chat/tmpl");
        this.templateCache = {
            data,
            expiresAt: now + this.modelCacheTtlMs,
        };
        return data;
    }

    async fetchModels(options = {}) {
        const template = await this.fetchTemplate(options);
        return Array.isArray(template?.models) ? template.models : [];
    }

    async listSessions(query = {}) {
        return this.requestJson("/chat/session", {
            query,
        });
    }

    async listRecords(sessionId, query = {}) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        return this.requestJson(`/chat/record/${normalizedSessionId}`, {
            query,
        });
    }

    async deleteSession(sessionId) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        return this.requestJson(`/chat/session/${normalizedSessionId}`, {
            method: "DELETE",
        });
    }

    async resolveModel(model) {
        const requested = String(model || this.defaultModel || "").trim();
        if (!requested) {
            throw this._buildError("AI8 model is required.", 400);
        }

        const models = await this.fetchModels();
        const normalizedRequested = requested.toLowerCase();

        const exactMatch = models.find(item => String(item?.value || "").toLowerCase() === normalizedRequested);
        if (exactMatch) {
            return exactMatch;
        }

        const shortMatches = models.filter(item => {
            const shortName = String(item?.value || "").split("::").pop();
            return shortName && shortName.toLowerCase() === normalizedRequested;
        });

        if (shortMatches.length === 1) {
            return shortMatches[0];
        }

        if (shortMatches.length > 1) {
            throw this._buildError(
                `Model "${requested}" is ambiguous on AI8. Use the full provider-qualified model id instead.`,
                400
            );
        }

        throw this._buildError(`Model "${requested}" was not found on AI8.`, 400);
    }

    async createSession(options = {}) {
        const resolvedModel = await this.resolveModel(options.model);
        const payload = {
            mcp: Array.isArray(options.mcp) ? options.mcp : [],
            model: resolvedModel.value,
            plugins: options.plugins ?? null,
            rags: Array.isArray(options.rags) ? options.rags : [],
        };

        if (typeof options.name === "string" && options.name.trim()) {
            payload.name = options.name.trim();
        }

        if (typeof options.prompt === "string" && options.prompt.trim()) {
            payload.prompt = options.prompt;
        }

        if (Number.isFinite(Number(options.temperature))) {
            payload.temperature = Number(options.temperature);
        }

        if (Number.isFinite(Number(options.contextCount))) {
            payload.contextCount = Number(options.contextCount);
        }

        if (Number.isFinite(Number(options.maxToken))) {
            payload.maxToken = Number(options.maxToken);
        }

        return this.requestJson("/chat/session", {
            body: payload,
            method: "POST",
        });
    }

    buildSessionUpdatePayload(session, patch = {}) {
        return {
            contextCount: Number.isFinite(Number(patch.contextCount ?? session?.contextCount))
                ? Number(patch.contextCount ?? session?.contextCount)
                : 0,
            created: session?.created || "",
            frequencyPenalty: Number.isFinite(Number(patch.frequencyPenalty ?? session?.frequencyPenalty))
                ? Number(patch.frequencyPenalty ?? session?.frequencyPenalty)
                : 0,
            icon: patch.icon ?? session?.icon ?? "",
            id: Number(session?.id),
            localPlugins: patch.localPlugins ?? session?.localPlugins ?? null,
            maxToken: Number.isFinite(Number(patch.maxToken ?? session?.maxToken))
                ? Number(patch.maxToken ?? session?.maxToken)
                : 0,
            mcp: Array.isArray(patch.mcp) ? patch.mcp : Array.isArray(session?.mcp) ? session.mcp : [],
            model: String(patch.model ?? session?.model ?? "").trim(),
            name: String(patch.name ?? session?.name ?? "").trim(),
            plugins: patch.plugins ?? session?.plugins ?? null,
            presencePenalty: Number.isFinite(Number(patch.presencePenalty ?? session?.presencePenalty))
                ? Number(patch.presencePenalty ?? session?.presencePenalty)
                : 0,
            prompt: String(patch.prompt ?? session?.prompt ?? "").trim(),
            rags: Array.isArray(patch.rags) ? patch.rags : Array.isArray(session?.rags) ? session.rags : [],
            temperature: Number.isFinite(Number(patch.temperature ?? session?.temperature))
                ? Number(patch.temperature ?? session?.temperature)
                : 0.7,
            topSort: Number.isFinite(Number(patch.topSort ?? session?.topSort))
                ? Number(patch.topSort ?? session?.topSort)
                : 0,
            uid: Number(session?.uid),
            updated: session?.updated || "",
            useAppId: Number.isFinite(Number(patch.useAppId ?? session?.useAppId))
                ? Number(patch.useAppId ?? session?.useAppId)
                : 0,
        };
    }

    async updateSession(session, patch = {}) {
        const sessionId = Number(session?.id);
        if (!Number.isFinite(sessionId)) {
            throw this._buildError("AI8 session id must be numeric.", 400);
        }

        const payload = this.buildSessionUpdatePayload(session, patch);
        return this.requestJson(`/chat/session/${sessionId}`, {
            body: payload,
            method: "PUT",
        });
    }

    async streamChatCompletion(options = {}, handlers = {}) {
        const payload = {
            files: Array.isArray(options.files)
                ? options.files
                      .map(file => ({
                          data: file?.data,
                          name: file?.name,
                      }))
                      .filter(file => typeof file.data === "string" && file.data && typeof file.name === "string" && file.name)
                : [],
            sessionId: options.sessionId,
            text: options.text || "",
            thinking: Boolean(options.thinking),
        };

        if (typeof options.systemPrompt === "string" && options.systemPrompt.trim()) {
            payload.systemPrompt = options.systemPrompt.trim();
        }

        const response = await this._fetch("/chat/completions", {
            body: payload,
            method: "POST",
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });

        const contentType = String(response.headers.get("content-type") || "");
        if (!response.ok) {
            const responsePayload = await this._readUnexpectedPayload(response);
            throw this._normalizeError(responsePayload, response.status);
        }

        if (contentType.startsWith("application/json")) {
            const jsonPayload = await response.json();
            if (jsonPayload?.code !== 0) {
                throw this._normalizeError(jsonPayload, response.status);
            }

            if (typeof handlers.onObject === "function") {
                handlers.onObject(jsonPayload.data, jsonPayload);
            }

            if (typeof handlers.onDone === "function") {
                handlers.onDone();
            }

            return {
                record: jsonPayload.data || null,
                taskId: jsonPayload?.data?.taskId || null,
            };
        }

        if (contentType.startsWith("text/plain")) {
            throw this._buildError(await response.text(), response.status || 502);
        }

        if (!contentType.startsWith("text/event-stream")) {
            throw this._buildError(`Unexpected AI8 response content-type: ${contentType || "unknown"}`, 502);
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let finalRecord = null;
        let taskId = response.headers.get("x-chat-task-id") || null;

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });

            for (;;) {
                const boundary = this._findEventBoundary(buffer);
                if (!boundary) {
                    break;
                }

                const rawEvent = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary.length);

                const data = this._readEventData(rawEvent);
                if (!data) {
                    continue;
                }

                if (data === "[DONE]") {
                    if (typeof handlers.onDone === "function") {
                        handlers.onDone();
                    }

                    return {
                        record: finalRecord,
                        taskId,
                    };
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (error) {
                    throw this._buildError(`Failed to parse AI8 SSE payload: ${error.message}`, 502);
                }

                if (parsed?.code !== 0) {
                    throw this._normalizeError(parsed, response.status || 502);
                }

                if (parsed?.id && !taskId) {
                    taskId = parsed.id;
                }

                if (typeof parsed?.data === "string") {
                    if (typeof handlers.onText === "function") {
                        handlers.onText(parsed.data, parsed);
                    }
                    continue;
                }

                if (parsed?.data && typeof parsed.data === "object") {
                    finalRecord = parsed.data;
                    if (parsed.data.taskId && !taskId) {
                        taskId = parsed.data.taskId;
                    }

                    if (typeof handlers.onObject === "function") {
                        handlers.onObject(parsed.data, parsed);
                    }
                }
            }
        }

        if (typeof handlers.onDone === "function") {
            handlers.onDone();
        }

        return {
            record: finalRecord,
            taskId,
        };
    }

    async requestJson(path, options = {}) {
        const response = await this._fetch(path, options);
        const payload = await response.json().catch(async () => {
            throw this._buildError(`AI8 returned a non-JSON response for ${path}: ${await response.text()}`, 502);
        });

        if (!response.ok || payload?.code !== 0) {
            throw this._normalizeError(payload, response.status);
        }

        return payload.data;
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

        const requestHeaders = {
            Authorization: this.authToken,
            "X-APP-VERSION": this.xAppVersion,
            ...headers,
        };

        let requestBody = body;
        if (
            body &&
            typeof body === "object" &&
            !Buffer.isBuffer(body) &&
            !(body instanceof ArrayBuffer) &&
            typeof body.pipe !== "function"
        ) {
            requestBody = JSON.stringify(body);
            if (!requestHeaders["Content-Type"]) {
                requestHeaders["Content-Type"] = "application/json";
            }
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
        const contentType = String(response.headers.get("content-type") || "");
        if (contentType.startsWith("application/json")) {
            return response.json().catch(() => response.text());
        }

        return response.text();
    }

    _normalizeError(source, status = 500) {
        if (source instanceof Error) {
            source.status = source.status || status;
            return source;
        }

        if (typeof source === "string") {
            return this._buildError(source, status);
        }

        const message =
            source?.err ||
            source?.msg ||
            source?.message ||
            source?.error?.message ||
            `AI8 request failed with status ${status}`;

        const error = this._buildError(message, this._resolveErrorStatus(source, status, message));
        if (source?.code !== undefined) {
            error.code = source.code;
        }
        if (source && typeof source === "object") {
            error.upstream = source;
        }
        return error;
    }

    _resolveErrorStatus(source, status, message) {
        const numericStatus = Number(status);
        if (Number.isFinite(numericStatus) && numericStatus >= 400) {
            return numericStatus;
        }

        const text = String(message || "").trim().toLowerCase();
        if (!text) {
            return 502;
        }

        if (
            text.includes("授权登陆已过期") ||
            text.includes("重新登陆") ||
            text.includes("重新登录") ||
            text.includes("login expired") ||
            text.includes("token expired") ||
            text.includes("unauthorized")
        ) {
            return 401;
        }

        if (text.includes("无权限") || text.includes("forbidden") || text.includes("permission denied")) {
            return 403;
        }

        if (
            text.includes("rate limit") ||
            text.includes("too many requests") ||
            text.includes("请求过于频繁") ||
            text.includes("频率过高")
        ) {
            return 429;
        }

        if (
            text.includes("invalid") ||
            text.includes("参数") ||
            text.includes("格式") ||
            text.includes("not found") ||
            text.includes("不存在") ||
            text.includes("ambiguous")
        ) {
            return 400;
        }

        return 502;
    }

    _buildError(message, status = 500) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    _findEventBoundary(buffer) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match) {
            return null;
        }

        return {
            index: match.index,
            length: match[0].length,
        };
    }

    _readEventData(rawEvent) {
        const lines = rawEvent.split(/\r?\n/);
        const dataLines = [];

        for (const line of lines) {
            if (!line.startsWith("data:")) {
                continue;
            }

            dataLines.push(line.slice(5).trimStart());
        }

        return dataLines.join("\n");
    }
}

module.exports = AI8Client;
