"use strict";

// Tool-marker protocol for the AI8 (rcouyi) platform family.
//
// The upstream wire protocol (/api/chat/session + /api/chat/completions) carries
// NO tools field. Tool-capable models express tool intent as text markers in the
// SSE text stream, e.g.:
//   <|tool▁calls▁begin|>
//   [{"name": "get_weather", "arguments": {"city": "北京"}}]
//   <|tool▁calls▁end|>
// or <tool_use>...</tool_use>, or GLM-style <tool_call>Name▁command▁params▁{json}.
//
// This module provides:
//  - buildToolInstructionBlock(tools): serialize OpenAI-style tool defs into the
//    prompt text that makes models emit the markers (verified against the live
//    upstream with openai_chat::gpt-5-nano).
//  - createToolStreamParser(): incremental chunk parser (for SSE streaming).
//  - parseToolCallsFromText(text): one-shot parse + marker strip (for non-stream
//    responses and final-record aiText).

const TOOL_CALL_START = "<|tool_calls_begin|>";
const TOOL_CALL_END = "<|tool_calls_end|>";
const TOOL_USE_OPEN = "<tool_use>";
const TOOL_USE_CLOSE = "</tool_use>";
const GLM_TOOL_CALL_OPEN = "<tool_call>";
const GLM_TOOL_CALL_CLOSE = "</tool_call>";

function normalizeChar(ch) {
    switch (ch) {
        case "\u2581": // ▁ (underscore variant used by the platform)
            return "_";
        case "\uFF5C": // ｜ fullwidth pipe
            return "|";
        case "\uFF1C": // ＜ fullwidth <
            return "<";
        case "\uFF1E": // ＞ fullwidth >
            return ">";
        default:
            return ch;
    }
}

function normalizeText(text) {
    let out = "";
    for (const ch of text) {
        out += normalizeChar(ch);
    }
    return out;
}

const START_TAGS = [TOOL_CALL_START, TOOL_USE_OPEN, GLM_TOOL_CALL_OPEN];
const END_TAGS = [TOOL_CALL_END, TOOL_USE_CLOSE, GLM_TOOL_CALL_CLOSE];

function isPrefixOfTag(buf, tags) {
    const normalized = normalizeText(buf);
    return tags.some(tag => tag.startsWith(normalized));
}

function isFullTag(buf, tags) {
    const normalized = normalizeText(buf);
    return tags.includes(normalized);
}

function isAnyStartTag(buf) {
    return isFullTag(buf, START_TAGS);
}

function isAnyEndTag(buf) {
    return isFullTag(buf, END_TAGS);
}

function repairJson(raw) {
    const text = raw;
    const stripCodeFences = s => s.replace(/```json/g, "").replace(/```xml/g, "").replace(/```/g, "").trim();
    const tryParse = str => {
        if (!str.trim()) return null;
        try {
            return JSON.parse(str);
        } catch (error) {
            return null;
        }
    };

    const direct = tryParse(text);
    if (direct) return direct;

    const fenced = tryParse(stripCodeFences(text));
    if (fenced) return fenced;

    let singles = text.replace(/'/g, '"');
    const singlesParsed = tryParse(singles);
    if (singlesParsed) return singlesParsed;

    const quotedKeys = singles.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
    const quotedParsed = tryParse(quotedKeys);
    if (quotedParsed) return quotedParsed;

    return null;
}

function jsonToToolCall(value, index) {
    if (!value || typeof value !== "object") return null;
    const name = value.name;
    const argumentsValue = value.arguments;
    if (typeof name !== "string" || !name) return null;

    let argumentsString = "{}";
    if (typeof argumentsValue === "string") {
        argumentsString = argumentsValue;
    } else if (argumentsValue !== undefined && argumentsValue !== null) {
        try {
            argumentsString = JSON.stringify(argumentsValue);
        } catch (error) {
            argumentsString = "{}";
        }
    }

    return {
        index,
        id: `call_${index}`,
        type: "function",
        function: {
            name,
            arguments: argumentsString,
        },
    };
}

function parseToolCallArray(jsonText, indexRef) {
    const calls = [];
    let value = repairJson(jsonText);
    if (!value) return calls;

    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
        const call = jsonToToolCall(item, indexRef.value);
        if (call) {
            calls.push(call);
            indexRef.value += 1;
        }
    }
    return calls;
}

function parseInvokeCalls(text, indexRef) {
    const calls = [];
    let remaining = text;
    for (;;) {
        const invokeStart = remaining.indexOf("<invoke");
        if (invokeStart === -1) break;
        remaining = remaining.slice(invokeStart);
        const tagEnd = remaining.indexOf(">");
        const invokeEnd = remaining.indexOf("</invoke>");
        if (tagEnd === -1 || invokeEnd === -1 || tagEnd >= invokeEnd) break;

        const openTag = remaining.slice(0, tagEnd + 1);
        const inner = remaining.slice(tagEnd + 1, invokeEnd);
        const nameMatch = openTag.match(/\bname\s*=\s*["']([^"']+)["']/);
        const name = nameMatch ? nameMatch[1] : null;
        if (!name) break;

        const args = {};
        let paramRemaining = inner;
        for (;;) {
            const paramStart = paramRemaining.indexOf("<parameter");
            if (paramStart === -1) break;
            paramRemaining = paramRemaining.slice(paramStart);
            const paramNameMatch = paramRemaining.match(/\bname\s*=\s*["']([^"']+)["']/);
            const paramContentStart = paramRemaining.indexOf(">");
            const paramEnd = paramRemaining.indexOf("</parameter>");
            if (!paramNameMatch || paramContentStart === -1 || paramEnd === -1 || paramContentStart >= paramEnd) break;
            args[paramNameMatch[1]] = paramRemaining.slice(paramContentStart + 1, paramEnd).trim();
            paramRemaining = paramRemaining.slice(paramEnd + "</parameter>".length);
        }

        calls.push({
            index: indexRef.value,
            id: `call_${indexRef.value}`,
            type: "function",
            function: {
                name,
                arguments: JSON.stringify(args),
            },
        });
        indexRef.value += 1;
        remaining = remaining.slice(invokeEnd + "</invoke>".length);
    }
    return calls;
}

function parseGlamDialect(text, indexRef) {
    const calls = [];
    const bare = text.replace(/<tool_call>/g, "").replace(/<\/tool_call>/g, "").trim();
    const separator = bare.indexOf("\u2581cmd\u2581params\u2581");
    if (separator === -1) return calls;

    const name = bare.slice(0, separator).split("\u2581")[0].split(" ")[0].trim();
    const jsonPart = bare.slice(separator + "\u2581cmd\u2581params\u2581".length).trim();
    const braceStart = jsonPart.indexOf("{");
    const braceEnd = jsonPart.lastIndexOf("}");
    if (!name || braceStart === -1 || braceEnd === -1) return calls;

    const payload = repairJson(jsonPart.slice(braceStart, braceEnd + 1)) || {};
    calls.push({
        index: indexRef.value,
        id: `call_${indexRef.value}`,
        type: "function",
        function: {
            name,
            arguments: JSON.stringify(payload.arguments ?? payload),
        },
    });
    indexRef.value += 1;
    return calls;
}

// State machine ports of the ouyi ToolCallParser. States:
//   "normal" -> "tag" (after '<') -> "injson" (after a start tag matched) -> "close" (after '<' inside json)
//
// Safety valve: a marker that opens but never closes (truncated model output)
// must not swallow the rest of the stream. If the buffered json grows past
// MAX_JSON_BUFFER characters without a closing tag, the buffer is flushed as
// plain text and parsing resets.
const MAX_JSON_BUFFER = 20000;

class ToolMarkerParser {
    constructor() {
        this.state = "normal";
        this.tagBuf = "";
        this.jsonBuf = "";
        this.toolCallIndex = 0;
        this.parsedCalls = [];
    }

    processChunk(chunk) {
        const text = String(chunk || "");
        let normalText = "";
        const newCalls = [];

        for (const rawChar of text) {
            const ch = normalizeChar(rawChar);
            switch (this.state) {
                case "normal": {
                    if (ch === "<") {
                        this.tagBuf = "<";
                        this.state = "tag";
                    } else {
                        normalText += rawChar;
                    }
                    break;
                }
                case "tag": {
                    this.tagBuf += ch;
                    if (isAnyStartTag(this.tagBuf)) {
                        this.jsonBuf = "";
                        this.state = "injson";
                    } else if (!isPrefixOfTag(this.tagBuf, START_TAGS)) {
                        normalText += this.tagBuf;
                        this.tagBuf = "";
                        this.state = "normal";
                    }
                    break;
                }
                case "injson": {
                    if (ch === "<") {
                        this.tagBuf = "<";
                        this.state = "close";
                    } else {
                        this.jsonBuf += rawChar;
                        if (this.jsonBuf.length > MAX_JSON_BUFFER) {
                            normalText += this.jsonBuf;
                            this.jsonBuf = "";
                            this.state = "normal";
                        }
                    }
                    break;
                }
                case "close": {
                    this.tagBuf += ch;
                    if (isAnyEndTag(this.tagBuf)) {
                        const jsonText = this.jsonBuf;
                        this.jsonBuf = "";
                        const calls = this._parseCallsFromText(jsonText);
                        this.parsedCalls.push(...calls);
                        newCalls.push(...calls);
                        this.tagBuf = "";
                        this.state = "normal";
                    } else if (!isPrefixOfTag(this.tagBuf, END_TAGS)) {
                        this.jsonBuf += this.tagBuf;
                        this.tagBuf = "";
                        this.state = "injson";
                        if (this.jsonBuf.length > MAX_JSON_BUFFER) {
                            normalText += this.jsonBuf;
                            this.jsonBuf = "";
                            this.state = "normal";
                        }
                    }
                    break;
                }
            }
        }

        return {
            text: normalText,
            calls: newCalls,
        };
    }

    _parseCallsFromText(jsonText) {
        const indexRef = { value: this.toolCallIndex };
        const calls = parseToolCallArray(jsonText, indexRef);
        this.toolCallIndex = indexRef.value;
        if (calls.length > 0) return calls;

        const invokeCalls = parseInvokeCalls(jsonText, indexRef);
        this.toolCallIndex = indexRef.value;
        if (invokeCalls.length > 0) return invokeCalls;

        const glmCalls = parseGlamDialect(jsonText, indexRef);
        this.toolCallIndex = indexRef.value;
        return glmCalls;
    }

    finish() {
        if (this.state === "tag") {
            return {
                text: this.tagBuf,
                calls: [],
            };
        }
        if (this.state === "injson" || this.state === "close") {
            return {
                text: this.jsonBuf,
                calls: [],
            };
        }
        return {
            text: "",
            calls: [],
        };
    }
}

function createToolStreamParser() {
    return new ToolMarkerParser();
}

function parseToolCallsFromText(text) {
    const parser = new ToolMarkerParser();
    const result = parser.processChunk(text);
    const remainder = parser.finish();
    const calls = parser.parsedCalls;

    if (calls.length === 0) {
        const indexRef = { value: 0 };
        const invokeCalls = parseInvokeCalls(text, indexRef);
        calls.push(...invokeCalls);
        const glmCalls = parseGlamDialect(text, indexRef);
        calls.push(...glmCalls);
    }

    return {
        text: (result.text + remainder.text).trim(),
        calls,
    };
}

function stripToolMarkers(text) {
    return parseToolCallsFromText(text).text;
}

function buildToolInstructionBlock(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return "";
    }

    const defs = tools
        .filter(tool => tool && (tool.type === "function" || tool.function))
        .map(tool => {
            const fn = tool.function || tool;
            return {
                type: "function",
                function: {
                    name: fn.name || "unknown_tool",
                    description: fn.description || "",
                    parameters: fn.parameters || { type: "object" },
                },
            };
        });

    if (defs.length === 0) {
        return "";
    }

    return [
        "你有以下可用工具，请根据用户请求调用它们。",
        "当需要调用工具时，必须输出如下格式的标记（只输出标记，标记外不要附加解释文字）：",
        "<|tool\u2581calls\u2581begin|>",
        '[{"name": "工具名", "arguments": {"参数名": "参数值"}}]',
        "<|tool\u2581calls\u2581end|>",
        "如果同时需要调用多个工具，在标记内输出一个数组包含全部工具调用。",
        "",
        "可用工具定义（JSON）：",
        JSON.stringify(defs),
        "",
    ].join("\n");
}

module.exports = {
    buildToolInstructionBlock,
    createToolStreamParser,
    parseToolCallsFromText,
    stripToolMarkers,
};
