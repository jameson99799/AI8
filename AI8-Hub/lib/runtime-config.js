"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EDITABLE_FIELDS = [
    "adminToken",
    "ai8AuthToken",
    "ai8BaseUrl",
    "ai8DefaultModel",
    "ai8DefaultThinking",
    "ai8RequestTimeoutMs",
    "ai8MinOutputTokens",
    "ai8DeleteSessionAfterResponse",
    "ai8ReuseSessionInjectSystemPrompt",
    "ai8UseSharedSession",
    "ai8SharedSessionId",
    "ai8XAppVersion",
    "apiKeys",
    "mediaFetchTimeoutMs",
    "publicBaseUrl",
    "requestBodyLimit",
    "ai8ImageModels",
    "ai8AllowedModels",
    "ai8BlacklistedModels",
    "blacklistedModels",
    "customChannels",
    "gptallEnabled",
    "gptallBaseUrl",
    "gptallAuthToken",
    "gptallCookie",
    "gptallFingerprint",
    "gptallDefaultModel",
    "gptallAllowedModels",
    "gptallBlacklistedModels",
    "gptallRequestTimeoutMs",
    "gptallDeleteGroupAfterResponse",
];

class RuntimeConfigStore {
    constructor(options = {}) {
        this.envPath = path.resolve(options.envPath || path.resolve(process.cwd(), ".env"));
        this.storePath = path.resolve(
            options.storePath || process.env.AI8_CONFIG_PATH || path.resolve(process.cwd(), "data", "config.json")
        );
        this.generatedAdminToken = null;
        this.baseRawConfig = this._buildBaseRawConfig(options.defaults || {});
        this.overrideRawConfig = this._readOverrideFile();
        this.runtimeConfig = this._resolveRuntimeConfig();
    }

    getConfig() {
        return { ...this.runtimeConfig };
    }

    getStorePath() {
        return this.storePath;
    }

    getAdminTokens() {
        const tokens = [];
        if (this.runtimeConfig.adminToken) {
            tokens.push(this.runtimeConfig.adminToken);
        }

        for (const apiKey of this.runtimeConfig.apiKeys) {
            tokens.push(apiKey);
        }

        if (tokens.length === 0) {
            if (!this.generatedAdminToken) {
                this.generatedAdminToken = crypto.randomBytes(18).toString("hex");
            }
            tokens.push(this.generatedAdminToken);
        }

        return [...new Set(tokens.filter(Boolean))];
    }

    getAdminAuthMode() {
        if (this.runtimeConfig.adminToken) {
            return "admin_token";
        }

        if (this.runtimeConfig.apiKeys.length > 0) {
            return "api_key";
        }

        return "generated_token";
    }

    getEditableConfig() {
        return {
            adminToken: this.runtimeConfig.adminToken,
            ai8AuthToken: this.runtimeConfig.ai8AuthToken,
            ai8BaseUrl: this.runtimeConfig.ai8BaseUrl,
            ai8DefaultModel: this.runtimeConfig.ai8DefaultModel,
            ai8DefaultThinking: this.runtimeConfig.ai8DefaultThinking,
            ai8RequestTimeoutMs: this.runtimeConfig.ai8RequestTimeoutMs,
            ai8MinOutputTokens: this.runtimeConfig.ai8MinOutputTokens,
            ai8DeleteSessionAfterResponse: this.runtimeConfig.ai8DeleteSessionAfterResponse,
            ai8ReuseSessionInjectSystemPrompt: this.runtimeConfig.ai8ReuseSessionInjectSystemPrompt,
            ai8UseSharedSession: this.runtimeConfig.ai8UseSharedSession,
            ai8SharedSessionId: this.runtimeConfig.ai8SharedSessionId,
            ai8XAppVersion: this.runtimeConfig.ai8XAppVersion,
            apiKeys: this.runtimeConfig.apiKeys.join(","),
            mediaFetchTimeoutMs: this.runtimeConfig.mediaFetchTimeoutMs,
            publicBaseUrl: this.runtimeConfig.publicBaseUrl,
            requestBodyLimit: this.runtimeConfig.requestBodyLimit,
            ai8ImageModels: this.runtimeConfig.ai8ImageModels.join(","),
            ai8AllowedModels: this.runtimeConfig.ai8AllowedModels.join(","),
            ai8BlacklistedModels: this.runtimeConfig.ai8BlacklistedModels.join(","),
            blacklistedModels: this.runtimeConfig.blacklistedModels.join(","),
            customChannels: this.runtimeConfig.customChannels,
            gptallEnabled: this.runtimeConfig.gptallEnabled,
            gptallBaseUrl: this.runtimeConfig.gptallBaseUrl,
            gptallAuthToken: this.runtimeConfig.gptallAuthToken,
            gptallCookie: this.runtimeConfig.gptallCookie,
            gptallFingerprint: this.runtimeConfig.gptallFingerprint,
            gptallDefaultModel: this.runtimeConfig.gptallDefaultModel,
            gptallAllowedModels: this.runtimeConfig.gptallAllowedModels.join(","),
            gptallBlacklistedModels: this.runtimeConfig.gptallBlacklistedModels.join(","),
            gptallRequestTimeoutMs: this.runtimeConfig.gptallRequestTimeoutMs,
            gptallDeleteGroupAfterResponse: this.runtimeConfig.gptallDeleteGroupAfterResponse,
        };
    }

    updateConfig(patch = {}) {
        const sanitizedPatch = sanitizeEditablePatch(patch);
        this.overrideRawConfig = {
            ...this.overrideRawConfig,
            ...sanitizedPatch,
            updatedAt: new Date().toISOString(),
        };

        this._writeOverrideFile(this.overrideRawConfig);
        this.runtimeConfig = this._resolveRuntimeConfig();
        return this.getConfig();
    }

    _buildBaseRawConfig(defaults) {
        return {
            adminToken: process.env.ADMIN_TOKEN,
            ai8AuthToken: process.env.AI8_AUTH_TOKEN,
            ai8BaseUrl: process.env.AI8_BASE_URL,
            ai8DefaultModel: process.env.AI8_DEFAULT_MODEL,
            ai8DefaultThinking: process.env.AI8_DEFAULT_THINKING,
            ai8RequestTimeoutMs: process.env.AI8_REQUEST_TIMEOUT_MS,
            ai8MinOutputTokens: process.env.AI8_MIN_OUTPUT_TOKENS,
            ai8DeleteSessionAfterResponse: process.env.AI8_DELETE_SESSION_AFTER_RESPONSE,
            ai8ReuseSessionInjectSystemPrompt: process.env.AI8_REUSE_SESSION_INJECT_SYSTEM_PROMPT,
            ai8UseSharedSession: process.env.AI8_USE_SHARED_SESSION,
            ai8SharedSessionId: process.env.AI8_SHARED_SESSION_ID,
            ai8XAppVersion: process.env.AI8_X_APP_VERSION,
            apiKeys: process.env.API_KEYS,
            mediaFetchTimeoutMs: process.env.MEDIA_FETCH_TIMEOUT_MS,
            port: process.env.PORT,
            logSlowThresholdMs: process.env.LOG_SLOW_THRESHOLD_MS,
            publicBaseUrl: process.env.PUBLIC_BASE_URL,
            requestBodyLimit: process.env.REQUEST_BODY_LIMIT,
            ai8ImageModels: process.env.AI8_IMAGE_MODELS,
            ai8AllowedModels: process.env.AI8_ALLOWED_MODELS,
            ai8BlacklistedModels: process.env.AI8_BLACKLISTED_MODELS,
            blacklistedModels: process.env.BLACKLISTED_MODELS,
            customChannels: [],
            gptallEnabled: process.env.GPTALL_ENABLED,
            gptallBaseUrl: process.env.GPTALL_BASE_URL,
            gptallAuthToken: process.env.GPTALL_AUTH_TOKEN,
            gptallCookie: process.env.GPTALL_COOKIE,
            gptallFingerprint: process.env.GPTALL_FINGERPRINT,
            gptallDefaultModel: process.env.GPTALL_DEFAULT_MODEL,
            gptallAllowedModels: process.env.GPTALL_ALLOWED_MODELS,
            gptallBlacklistedModels: process.env.GPTALL_BLACKLISTED_MODELS,
            gptallRequestTimeoutMs: process.env.GPTALL_REQUEST_TIMEOUT_MS,
            gptallDeleteGroupAfterResponse: process.env.GPTALL_DELETE_GROUP_AFTER_RESPONSE,
            ...defaults,
        };
    }

    _readOverrideFile() {
        if (!fs.existsSync(this.storePath)) {
            return {};
        }

        try {
            const content = fs.readFileSync(this.storePath, "utf8");
            const parsed = JSON.parse(content);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    _resolveRuntimeConfig() {
        const mergedRawConfig = {
            ...this.baseRawConfig,
            ...this.overrideRawConfig,
        };

        return normalizeConfig(mergedRawConfig);
    }

    _writeOverrideFile(content) {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        fs.writeFileSync(this.storePath, JSON.stringify(content, null, 2));
    }
}

function sanitizeEditablePatch(patch = {}) {
    const sanitized = {};
    for (const key of EDITABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) {
            continue;
        }

        sanitized[key] = patch[key];
    }

    return sanitized;
}

function normalizeConfig(source = {}) {
    return {
        adminToken: normalizeString(source.adminToken || source.ADMIN_TOKEN),
        ai8AuthToken: normalizeString(source.ai8AuthToken || source.AI8_AUTH_TOKEN),
        ai8BaseUrl: normalizeString(source.ai8BaseUrl || source.AI8_BASE_URL || "https://ai8.rcouyi.com/api"),
        ai8DefaultModel: normalizeString(source.ai8DefaultModel || source.AI8_DEFAULT_MODEL || "openai_chat::gpt-4.1-mini"),
        ai8DefaultThinking: parseBoolean(source.ai8DefaultThinking ?? source.AI8_DEFAULT_THINKING, false),
        ai8RequestTimeoutMs: parseNumber(source.ai8RequestTimeoutMs ?? source.AI8_REQUEST_TIMEOUT_MS, 300000),
        ai8MinOutputTokens: parseNumber(source.ai8MinOutputTokens ?? source.AI8_MIN_OUTPUT_TOKENS, 8192),
        ai8DeleteSessionAfterResponse: parseBoolean(
            source.ai8DeleteSessionAfterResponse ?? source.AI8_DELETE_SESSION_AFTER_RESPONSE,
            false
        ),
        ai8ReuseSessionInjectSystemPrompt: parseBoolean(
            source.ai8ReuseSessionInjectSystemPrompt ?? source.AI8_REUSE_SESSION_INJECT_SYSTEM_PROMPT,
            false
        ),
        ai8UseSharedSession: parseBoolean(
            source.ai8UseSharedSession ?? source.AI8_USE_SHARED_SESSION,
            true
        ),
        ai8SharedSessionId: parseOptionalNumber(source.ai8SharedSessionId ?? source.AI8_SHARED_SESSION_ID),
        ai8XAppVersion: normalizeString(source.ai8XAppVersion || source.AI8_X_APP_VERSION || "3.0.1"),
        apiKeys: parseCsv(source.apiKeys ?? source.API_KEYS),
        mediaFetchTimeoutMs: parseNumber(source.mediaFetchTimeoutMs ?? source.MEDIA_FETCH_TIMEOUT_MS, 60000),
        port: parseNumber(process.env.PORT, 7865),
        logSlowThresholdMs: parseNumber(source.logSlowThresholdMs ?? source.LOG_SLOW_THRESHOLD_MS, 0),
        publicBaseUrl: normalizeString(source.publicBaseUrl || source.PUBLIC_BASE_URL),
        requestBodyLimit: normalizeString(source.requestBodyLimit || source.REQUEST_BODY_LIMIT || "50mb"),
        ai8ImageModels: parseCsv(source.ai8ImageModels ?? source.AI8_IMAGE_MODELS ?? "gpt-image-1,gpt-image-2,dall-e-3"),
        ai8AllowedModels: parseCsv(source.ai8AllowedModels ?? source.AI8_ALLOWED_MODELS ?? ""),
        ai8BlacklistedModels: parseCsv(source.ai8BlacklistedModels ?? source.AI8_BLACKLISTED_MODELS ?? ""),
        blacklistedModels: parseCsv(source.blacklistedModels ?? source.BLACKLISTED_MODELS ?? ""),
        customChannels: Array.isArray(source.customChannels) ? source.customChannels : [],
        gptallEnabled: parseBoolean(source.gptallEnabled ?? source.GPTALL_ENABLED, false),
        gptallBaseUrl: normalizeString(source.gptallBaseUrl || source.GPTALL_BASE_URL || "https://gpt-all.chat/api"),
        gptallAuthToken: normalizeString(source.gptallAuthToken || source.GPTALL_AUTH_TOKEN),
        gptallCookie: normalizeString(source.gptallCookie || source.GPTALL_COOKIE),
        gptallFingerprint: normalizeString(source.gptallFingerprint || source.GPTALL_FINGERPRINT || "89346554"),
        gptallDefaultModel: normalizeString(source.gptallDefaultModel || source.GPTALL_DEFAULT_MODEL),
        gptallAllowedModels: parseCsv(source.gptallAllowedModels ?? source.GPTALL_ALLOWED_MODELS ?? ""),
        gptallBlacklistedModels: parseCsv(source.gptallBlacklistedModels ?? source.GPTALL_BLACKLISTED_MODELS ?? ""),
        gptallRequestTimeoutMs: parseNumber(
            source.gptallRequestTimeoutMs ?? source.GPTALL_REQUEST_TIMEOUT_MS,
            300000
        ),
        gptallDeleteGroupAfterResponse: parseBoolean(
            source.gptallDeleteGroupAfterResponse ?? source.GPTALL_DELETE_GROUP_AFTER_RESPONSE,
            true
        ),
    };
}

function normalizeString(value) {
    return String(value || "").trim();
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

function parseCsv(value) {
    if (Array.isArray(value)) {
        return value.map(item => normalizeString(item)).filter(Boolean);
    }

    return String(value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function parseOptionalNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

module.exports = RuntimeConfigStore;
