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

    const fetchTasks = [];

    if (config.ai8Enabled !== false) {
        fetchTasks.push(
            client.fetchModels({ forceRefresh })
                .then(rawAi8Models => rawAi8Models.map(m => ({ ...m })))
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch AI8 models", { error: String(e) });
                    return [];
                })
        );
    }

    if (config.gptallEnabled !== false && config.gptallAuthToken) {
        fetchTasks.push(
            buildGptAllClient(config).fetchModels()
                .then(gptallModels => gptallModels || [])
                .catch(e => {
                    if (logger) logger.warn("Failed to fetch gpt-all models", { error: String(e) });
                    return [];
                })
        );
    }

    const customChannelTasks = (config.customChannels || [])
        .filter(channel => channel.enabled)
        .map(channel => {
            let safeBase = channel.baseUrl.trim().replace(/\/+$/, "");
            if (safeBase.endsWith("/chat/completions")) {
                safeBase = safeBase.replace("/chat/completions", "");
            }
            const endpoint = safeBase.endsWith("/v1") ? `${safeBase}/models` : `${safeBase}/v1/models`;
            return fetch(endpoint, {
                headers: { "Authorization": `Bearer ${channel.apiKey}` },
                signal: AbortSignal.timeout(5000)
            })
                .then(res => (res.ok ? res.json() : null))
                .then(data => ({
                    channel,
                    models: (data && Array.isArray(data.data)) ? data.data : [],
                }))
                .catch(e => {
                    if (logger) logger.warn(`Failed to fetch models for channel ${channel.name}`, { error: String(e) });
                    return { channel, models: [] };
                });
        });

    // Run ai8, gptall and all custom channels in parallel.
    const [ai8Models, gptallModels, ...customResults] = await Promise.all([...fetchTasks, ...customChannelTasks]);

    const allModels = [];

    for (const m of ai8Models) {
        const value = String(m.value || "").trim();
        if (!value) continue;
        allModels.push({
            ...m,
            _source: "ai8",
            origId: value.replace(/【AI8直连】$/, ''),
            value: `${value.replace(/【AI8直连】$/, '')}【AI8直连】`,
            label: `${value.replace(/【AI8直连】$/, '')}【AI8直连】`,
        });
    }

    for (const gptallModel of (gptallModels || [])) {
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

    for (const { channel, models } of customResults) {
        for (const m of models) {
            if (!m || m.id === undefined || m.id === null) continue;
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

    modelCache = {
        models: allModels,
        timestamp: Date.now(),
        ttl: modelCache.ttl
    };

    return filterCachedModels(allModels, config, forAdmin);
}

function filterCachedModels(models, config, forAdmin) {
    if (forAdmin) return models;
    const globalBlacklist = Array.isArray(config.blacklistedModels) && config.blacklistedModels.length > 0 ? config.blacklistedModels : null;
    return models.filter(m => {
        if (globalBlacklist !== null && globalBlacklist.includes(m.value || m.origId)) return false;
        if (m._source === "ai8") {
            const ai8Whitelist = Array.isArray(config.ai8AllowedModels) && config.ai8AllowedModels.length > 0 ? config.ai8AllowedModels : null;
            if (ai8Whitelist !== null && !ai8Whitelist.includes(m.origId)) return false;
            const ai8Blacklist = Array.isArray(config.ai8BlacklistedModels) && config.ai8BlacklistedModels.length > 0 ? config.ai8BlacklistedModels : null;
            if (ai8Blacklist !== null && ai8Blacklist.includes(m.origId)) return false;
            return true;
        }
        if (m._source === "gptall") {
            const gptallWhitelist = Array.isArray(config.gptallAllowedModels) && config.gptallAllowedModels.length > 0 ? config.gptallAllowedModels : null;
            if (gptallWhitelist !== null && !gptallWhitelist.includes(m.origId)) return false;
            const gptallBlacklist = Array.isArray(config.gptallBlacklistedModels) && config.gptallBlacklistedModels.length > 0 ? config.gptallBlacklistedModels : null;
            if (gptallBlacklist !== null && gptallBlacklist.includes(m.origId)) return false;
            return true;
        }
        const channel = (config.customChannels || []).find(c => c.name === m._source);
        if (!channel) return false;
        if (!channel.enabled) return false;
        const whitelist = Array.isArray(channel.models) && channel.models.length > 0 ? channel.models : null;
        if (whitelist !== null && !whitelist.includes(m.origId)) return false;
        const blacklist = Array.isArray(channel.blacklistedModels) && channel.blacklistedModels.length > 0 ? channel.blacklistedModels : null;
        if (blacklist !== null && blacklist.includes(m.origId)) return false;
        return true;
    });
}

function isBlacklisted(requestModel, config, targetChannel) {
    if (targetChannel && targetChannel.name === "gpt-all") {
        const list = Array.isArray(config.gptallBlacklistedModels) ? config.gptallBlacklistedModels : [];
        return list.includes(requestModel);
    }
    if (targetChannel) {
        const list = Array.isArray(targetChannel.blacklistedModels) ? targetChannel.blacklistedModels : [];
        return list.includes(requestModel);
    }
    const ai8List = Array.isArray(config.ai8BlacklistedModels) ? config.ai8BlacklistedModels : [];
    return ai8List.includes(requestModel);
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
                        res.write(value);
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

module.exports = { buildGptAllClient, fetchAggregatedModels, proxyToCustomChannel, resolveTargetChannel, isBlacklisted, filterCachedModels };
