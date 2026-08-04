"use strict";

const GptAllClient = require("./gptall-client");

function buildGptAllClient(config) {
    if (!config || !config.gptallAuthToken) {
        throw new Error("GPTALL_AUTH_TOKEN is not configured.");
    }
    return new GptAllClient({
        authToken: config.gptallAuthToken,
        baseUrl: config.gptallBaseUrl,
        cookie: config.gptallCookie,
        fingerprint: config.gptallFingerprint,
        defaultModel: config.gptallDefaultModel,
        deleteGroupAfterResponse: config.gptallDeleteGroupAfterResponse,
        requestTimeoutMs: config.gptallRequestTimeoutMs,
    });
}

let modelCache = {
    models: [],
    timestamp: 0,
    ttl: 1000 * 60 * 5 // 5 minutes cache
};

async function fetchAggregatedModels(client, config, forceRefresh, logger, forAdmin = false) {
    if (!forceRefresh && modelCache.models.length > 0 && Date.now() - modelCache.timestamp < modelCache.ttl) {
        return filterCachedModels(modelCache.models, config, forAdmin);
    }

    let ai8Models = [];
    if (config.ai8Enabled !== false) {
        try {
            const rawAi8Models = await client.fetchModels({ forceRefresh });
            ai8Models = rawAi8Models.map(m => ({ ...m }));
            ai8Models.forEach(m => {
                m._source = "ai8";
                m.origId = m.value.replace(/【AI8直连】$/, ''); 
                m.value = `${m.origId}【AI8直连】`;
                m.label = m.value;
            });
        } catch (e) {
            if (logger) logger.warn("Failed to fetch AI8 models", { error: String(e) });
        }
    }
    
    let allModels = [...ai8Models];

    if (config.gptallEnabled !== false && config.gptallAuthToken) {
        try {
            const gptallClient = buildGptAllClient(config);
            const gptallModels = await gptallClient.fetchModels();
            for (const gptallModel of gptallModels) {
                const origId = String(gptallModel.value || gptallModel.model || "").trim();
                if (origId && !allModels.some(m => m._source === "gptall" && m.origId === origId)) {
                    const modelId = `${origId}【gpt-all】`;
                    allModels.push({
                        label: modelId,
                        value: modelId,
                        origId,
                        channel: "gpt-all",
                        attr: { providerName: "gpt-all" },
                        _source: "gptall",
                        _actualModel: origId,
                        _isToolSupported: gptallModel.isToolSupported === true,
                    });
                }
            }
        } catch (e) {
            if (logger) logger.warn("Failed to fetch gpt-all models", { error: String(e) });
        }
    }

    for (const channel of (config.customChannels || [])) {
        if (!channel.enabled) continue;
        
        let safeBase = channel.baseUrl.trim().replace(/\/+$/, "");
        if (safeBase.endsWith("/chat/completions")) {
            safeBase = safeBase.replace("/chat/completions", "");
        }
        
        try {
            const endpoint = safeBase.endsWith("/v1") ? `${safeBase}/models` : `${safeBase}/v1/models`;
            const res = await fetch(endpoint, {
                headers: { "Authorization": `Bearer ${channel.apiKey}` },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.data)) {
                    for (const m of data.data) {
                        const modelId = `${m.id}【${channel.name}】`;
                        allModels.push({
                            label: modelId,
                            value: modelId,
                            origId: m.id,
                            channel: channel.name,
                            attr: { providerName: channel.name },
                            _source: channel.name,
                            _actualModel: m.id
                        });
                    }
                }
            }
        } catch (e) {
            if (logger) logger.warn(`Failed to fetch models for channel ${channel.name}`, { error: String(e) });
        }
    }
    
    modelCache = {
        models: allModels,
        timestamp: Date.now(),
        ttl: modelCache.ttl
    };
    
    return filterCachedModels(allModels, config, forAdmin);
}

function filterCachedModels(models, config, forAdmin) {
    if (forAdmin) return models;
    return models.filter(m => {
        if (m._source === "ai8") {
            const ai8Whitelist = Array.isArray(config.ai8AllowedModels) && config.ai8AllowedModels.length > 0 ? config.ai8AllowedModels : null;
            if (ai8Whitelist !== null && !ai8Whitelist.includes(m.origId)) return false;
            return true;
        }
        if (m._source === "gptall") {
            const gptallWhitelist = Array.isArray(config.gptallAllowedModels) && config.gptallAllowedModels.length > 0 ? config.gptallAllowedModels : null;
            if (gptallWhitelist !== null && !gptallWhitelist.includes(m.origId)) return false;
            return true;
        }
        const channel = (config.customChannels || []).find(c => c.name === m._source);
        if (!channel) return false;
        if (!channel.enabled) return false;
        const whitelist = Array.isArray(channel.models) && channel.models.length > 0 ? channel.models : null;
        if (whitelist !== null && !whitelist.includes(m.origId)) return false;
        return true;
    });
}

async function resolveTargetChannel(requestModel, config, client, logger) {
    let actualModel = requestModel;
    let targetChannel = null;

    // 1. Explicitly matched by suffix
    const match = requestModel.match(/^(.*?)【(.*?)】$/);
    if (match) {
        actualModel = match[1];
        const channelName = match[2];
        const customChannels = config.customChannels || [];
        targetChannel = customChannels.find(c => c.name === channelName && c.enabled);
        if (targetChannel) {
            return { targetChannel, actualModel };
        }
        if (channelName === "AI8直连" || channelName === "ai8") {
            return { targetChannel: null, actualModel };
        }
        if (channelName === "gpt-all" || channelName === "gptall") {
            return { targetChannel: { protocol: "gptall", name: "gpt-all" }, actualModel };
        }
    }
    
    // 2. Try to find in cache for unprefixed models
    if (!targetChannel) {
        if (modelCache.models.length === 0 || Date.now() - modelCache.timestamp >= modelCache.ttl) {
            if (client) {
                await fetchAggregatedModels(client, config, false, logger);
            }
        }

        const cached = modelCache.models.find(m => m.value === requestModel || m.origId === requestModel);
        if (cached && cached._source === "gptall") {
            targetChannel = { protocol: "gptall", name: "gpt-all" };
            actualModel = cached._actualModel || requestModel;
        } else if (cached && cached._source !== "ai8") {
            const customChannels = config.customChannels || [];
            targetChannel = customChannels.find(c => c.name === cached._source && c.enabled);
            if (targetChannel) {
                actualModel = cached._actualModel || requestModel;
            }
        }
    }

    return { targetChannel, actualModel };
}

async function proxyToCustomChannel(req, res, targetChannel, actualModel, body, buildErrorPayload, isNativeClaude = false) {
    let safeBase = targetChannel.baseUrl.trim().replace(/\/+$/, "");
    
    if (isNativeClaude) {
        if (safeBase.endsWith("/messages")) safeBase = safeBase.replace("/messages", "");
    } else {
        if (safeBase.endsWith("/chat/completions")) safeBase = safeBase.replace("/chat/completions", "");
    }
    
    let endpoint = "";
    if (isNativeClaude) {
        endpoint = safeBase.endsWith("/v1") ? `${safeBase}/messages` : (safeBase.endsWith("/") ? `${safeBase}v1/messages` : `${safeBase}/v1/messages`);
    } else {
        endpoint = safeBase.endsWith("/v1") ? `${safeBase}/chat/completions` : (safeBase.endsWith("/") ? `${safeBase}v1/chat/completions` : `${safeBase}/v1/chat/completions`);
    }
    
    const proxyBody = { ...body, model: actualModel };
    
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    try {
        const reqHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${targetChannel.apiKey}`
        };
        if (isNativeClaude) {
            reqHeaders["x-api-key"] = targetChannel.apiKey;
            reqHeaders["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
            if (req.headers["anthropic-beta"]) {
                reqHeaders["anthropic-beta"] = req.headers["anthropic-beta"];
            }
        }
    
        const upstreamRes = await fetch(endpoint, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(proxyBody),
            signal: abortController.signal
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            res.status(upstreamRes.status).send(errText);
            return;
        }

        if (body.stream) {
            res.status(upstreamRes.status);
            const ct = upstreamRes.headers.get("content-type");
            if (ct) res.setHeader("content-type", ct);
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            if (typeof res.flushHeaders === "function") {
                res.flushHeaders();
            }
            
            const reader = upstreamRes.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        res.write(Buffer.from(value));
                    }
                }
            } finally {
                reader.releaseLock();
            }
            res.end();
        } else {
            const rawText = await upstreamRes.text();
            res.status(upstreamRes.status);
            const ct = upstreamRes.headers.get("content-type");
            if (ct) res.setHeader("content-type", ct);
            try {
                const data = JSON.parse(rawText);
                res.json(data);
            } catch (jsonErr) {
                res.send(rawText);
            }
        }
    } catch (e) {
        if (abortController.signal.aborted) return res.end();
        if (!res.headersSent) {
            const errJson = typeof buildErrorPayload === "function" 
                ? buildErrorPayload(502, `Error proxying to channel: ${e.message}`, "server_error")
                : { error: { message: e.message }};
            res.status(502).json(errJson);
        }
    }
}

module.exports = { buildGptAllClient, fetchAggregatedModels, proxyToCustomChannel, resolveTargetChannel };
