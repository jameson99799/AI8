"use strict";

function randomId(prefix) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeUsage(record = null) {
    const promptTokens = toFiniteNumber(record?.promptTokens);
    const completionTokens = toFiniteNumber(record?.completionTokens);
    const totalTokens = toFiniteNumber(record?.useTokens, promptTokens + completionTokens);

    return {
        completion_tokens: completionTokens,
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
    };
}

function toDisplayModelId(value) {
    const text = String(value || "").trim();
    if (!text) {
        return text;
    }

    const parts = text.split("::");
    return parts[parts.length - 1] || text;
}

function buildModelsList(models) {
    const created = Math.floor(Date.now() / 1000);

    return {
        data: models.map(model => ({
            created,
            id: toDisplayModelId(model.value),
            object: "model",
            owned_by: model?.attr?.providerName || "ai8",
        })),
        object: "list",
    };
}

function buildAdminModelsList(models) {
    return models.map(model => ({
        ...model,
        display_value: toDisplayModelId(model?.value || ""),
    }));
}

function buildChatCompletion({ content, created, id, images = [], metadata = null, model, usage }) {
    const message = {
        content: content || "",
        role: "assistant",
    };

    if (Array.isArray(images) && images.length > 0) {
        message.ai8_images = images;
    }

    if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
        message.ai8 = metadata;
    }

    return {
        choices: [
            {
                finish_reason: "stop",
                index: 0,
                message,
            },
        ],
        created: created || Math.floor(Date.now() / 1000),
        id: id || randomId("chatcmpl"),
        model,
        object: "chat.completion",
        usage: usage || normalizeUsage(),
    };
}

function buildChatCompletionChunk({ created, delta = {}, finishReason = null, id, index = 0, model, usage }) {
    const chunk = {
        choices: [
            {
                delta,
                finish_reason: finishReason,
                index,
            },
        ],
        created: created || Math.floor(Date.now() / 1000),
        id: id || randomId("chatcmpl"),
        model,
        object: "chat.completion.chunk",
    };

    if (usage) {
        chunk.usage = usage;
    }

    return chunk;
}

function buildImageGeneration({ created, images = [] }) {
    return {
        created: created || Math.floor(Date.now() / 1000),
        data: images.map(img => {
            const dataObj = { url: img.original_url || img.url };
            if (img.url && img.url.startsWith("data:")) {
                dataObj.b64_json = img.url.split(",")[1];
                // Still provide original URL if it was an HTTP URL fetched to base64
                if (!img.original_url) dataObj.url = img.url; 
            }
            return dataObj;
        }),
    };
}

function buildErrorPayload(status, message, type = "invalid_request_error", code = null, details = null) {
    const error = {
        code: code || String(status || 500),
        message,
        param: null,
        type,
    };

    if (details && typeof details === "object") {
        error.details = details;
    }

    return {
        error,
    };
}

module.exports = {
    buildAdminModelsList,
    buildChatCompletion,
    buildChatCompletionChunk,
    buildErrorPayload,
    buildImageGeneration,
    buildModelsList,
    normalizeUsage,
    randomId,
    toDisplayModelId,
};
