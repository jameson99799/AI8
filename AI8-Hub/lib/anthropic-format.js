"use strict";

const { randomId } = require("./openai-format");

function anthropicToOpenAiRequest(body) {
    const messages = [];

    if (body.system) {
        if (typeof body.system === "string") {
            messages.push({ role: "system", content: body.system });
        } else if (Array.isArray(body.system)) {
            const systemContent = body.system.map(part => typeof part === "string" ? part : part.text).join("\n");
            messages.push({ role: "system", content: systemContent });
        }
    }

    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
            let normalizedContent = "";
            let toolCalls = null;
            let toolResults = [];

            if (typeof msg.content === "string") {
                normalizedContent = msg.content;
            } else if (Array.isArray(msg.content)) {
                const textParts = [];
                const mediaParts = [];

                for (const part of msg.content) {
                    if (typeof part === "string") {
                        textParts.push({ type: "text", text: part });
                    } else if (part.type === "text") {
                        textParts.push({ type: "text", text: part.text });
                    } else if (part.type === "image" && part.source && part.source.data) {
                        mediaParts.push({
                            type: "image_url",
                            image_url: { url: `data:${part.source.media_type || 'image/jpeg'};base64,${part.source.data}` }
                        });
                    } else if (part.type === "tool_use") {
                        if (!toolCalls) toolCalls = [];
                        toolCalls.push({
                            id: part.id,
                            type: "function",
                            function: {
                                name: part.name,
                                arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input)
                            }
                        });
                    } else if (part.type === "tool_result") {
                        toolResults.push({
                            role: "tool",
                            tool_call_id: part.tool_use_id,
                            content: typeof part.content === "string" ? part.content : (Array.isArray(part.content) ? JSON.stringify(part.content) : String(part.content || ""))
                        });
                    }
                }

                if (toolCalls && toolCalls.length > 0) {
                    normalizedContent = textParts.length > 0 ? textParts.map(p => p.text).join("\n") : "";
                } else if (mediaParts.length > 0) {
                    normalizedContent = [...textParts, ...mediaParts];
                } else {
                    normalizedContent = textParts.map(p => p.text).join("\n");
                }
            }

            if (msg.role === "assistant") {
                const astMsg = { role: "assistant", content: normalizedContent };
                if (toolCalls) astMsg.tool_calls = toolCalls;
                messages.push(astMsg);
            } else {
                if (toolResults.length > 0) {
                    if (normalizedContent) {
                        messages.push({ role: "user", content: normalizedContent });
                    }
                    messages.push(...toolResults);
                } else {
                    messages.push({
                        role: "user",
                        content: normalizedContent || msg.content
                    });
                }
            }
        }
    }

    const payload = {
        model: body.model,
        messages: messages,
        temperature: body.temperature ?? 0.7,
        max_tokens: body.max_tokens ?? 4096,
        stream: !!body.stream
    };

    if (body.tools && Array.isArray(body.tools)) {
        payload.tools = body.tools.map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema
            }
        }));
    }
    
    if (body.tool_choice) {
        if (body.tool_choice.type === "any") payload.tool_choice = "required";
        else if (body.tool_choice.type === "auto") payload.tool_choice = "auto";
        else if (body.tool_choice.type === "tool") payload.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }

    const metadataThinking =
        body?.metadata && Object.prototype.hasOwnProperty.call(body.metadata, "ai8_thinking")
            ? Boolean(body.metadata.ai8_thinking)
            : null;
    const thinkingEnabled =
        metadataThinking !== null ? metadataThinking : body?.thinking?.type === "enabled";
    if (thinkingEnabled === true || metadataThinking === false) {
        payload.metadata = { ...(body.metadata || {}), ai8_thinking: Boolean(thinkingEnabled) };
    }

    return payload;
}

function openAiToAnthropicChunk(openaiChunk, state = {}) {
    if (!openaiChunk.choices || openaiChunk.choices.length === 0) return null;
    const choice = openaiChunk.choices[0];
    const delta = choice.delta;
    
    if (state.currentIndex === undefined) state.currentIndex = 0;
    const events = [];
    
    if (delta) {
        const reasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content
            ? delta.reasoning_content
            : (typeof delta.reasoning === "string" && delta.reasoning ? delta.reasoning : "");
        if (reasoning) {
            if (!state.inThink) {
                state.inThink = true;
                events.push({
                    type: "content_block_start",
                    index: state.currentIndex,
                    content_block: { type: "thinking", signature: "ai8_internal", thinking: "" }
                });
            }
            events.push({
                type: "content_block_delta",
                index: state.currentIndex,
                delta: { type: "thinking_delta", thinking: reasoning }
            });
        }
        
        if (delta.content !== undefined && delta.content !== null && delta.content !== "") {
            if (state.inThink) {
                events.push({
                    type: "content_block_delta",
                    index: state.currentIndex,
                    delta: { type: "signature_delta", signature: "ai8_sign" }
                });
                events.push({ type: "content_block_stop", index: state.currentIndex });
                state.inThink = false;
                state.currentIndex++;
            }
            if (!state.hasStartedText) {
                state.hasStartedText = true;
                events.push({
                    type: "content_block_start",
                    index: state.currentIndex,
                    content_block: { type: "text", text: "" }
                });
            }
            events.push({
                type: "content_block_delta",
                index: state.currentIndex,
                delta: { type: "text_delta", text: delta.content }
            });
        }
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tool_call of delta.tool_calls) {
                if (state.activeToolIndex !== tool_call.index) {
                    if (state.inThink) {
                        events.push({
                            type: "content_block_delta",
                            index: state.currentIndex,
                            delta: { type: "signature_delta", signature: "ai8_sign" }
                        });
                        events.push({ type: "content_block_stop", index: state.currentIndex });
                        state.inThink = false;
                        state.currentIndex++;
                    }
                    if (state.hasStartedText) {
                        events.push({ type: "content_block_stop", index: state.currentIndex });
                        state.hasStartedText = false;
                        state.currentIndex++;
                    }
                    if (state.inTool) {
                        events.push({ type: "content_block_stop", index: state.currentIndex });
                        state.currentIndex++;
                    }
                    events.push({
                        type: "content_block_start",
                        index: state.currentIndex,
                        content_block: { type: "tool_use", id: tool_call.id || `call_${Date.now()}`, name: (tool_call.function && tool_call.function.name) || "unknown_tool", input: {} }
                    });
                    state.inTool = true;
                    state.activeToolIndex = tool_call.index;
                }
                if (tool_call.function && tool_call.function.arguments) {
                    events.push({
                        type: "content_block_delta",
                        index: state.currentIndex,
                        delta: { type: "input_json_delta", partial_json: tool_call.function.arguments }
                    });
                }
            }
        }
    }
    
    const msgReasoning =
        typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content
            ? choice.message.reasoning_content
            : (typeof choice.message?.reasoning === "string" && choice.message.reasoning ? choice.message.reasoning : "");
    if (msgReasoning && !state.inThink) {
        state.inThink = true;
        events.push({
            type: "content_block_start",
            index: state.currentIndex,
            content_block: { type: "thinking", signature: "ai8_internal", thinking: "" }
        });
        events.push({
            type: "content_block_delta",
            index: state.currentIndex,
            delta: { type: "thinking_delta", thinking: msgReasoning }
        });
    }

    const msgContent = typeof choice.message?.content === "string" ? choice.message.content : "";
    if (msgContent && !state.hasStartedText) {
        if (state.inThink) {
            events.push({
                type: "content_block_delta",
                index: state.currentIndex,
                delta: { type: "signature_delta", signature: "ai8_sign" }
            });
            events.push({ type: "content_block_stop", index: state.currentIndex });
            state.inThink = false;
            state.currentIndex++;
        }
        state.hasStartedText = true;
        events.push({
            type: "content_block_start",
            index: state.currentIndex,
            content_block: { type: "text", text: "" }
        });
        const deltaText = choice.message.content;
        events.push({
            type: "content_block_delta",
            index: state.currentIndex,
            delta: { type: "text_delta", text: deltaText }
        });
    }

    if (choice.finish_reason) {
        if (state.inThink) {
            events.push({
                type: "content_block_delta",
                index: state.currentIndex,
                delta: { type: "signature_delta", signature: "ai8_sign" }
            });
            events.push({ type: "content_block_stop", index: state.currentIndex });
            state.inThink = false;
            state.currentIndex++;
        }
        if (state.inTool) {
            events.push({ type: "content_block_stop", index: state.currentIndex });
            state.inTool = false;
            state.currentIndex++;
        } else if (!state.hasStartedText) {
            events.push({
                type: "content_block_start",
                index: state.currentIndex,
                content_block: { type: "text", text: "" }
            });
            events.push({ type: "content_block_stop", index: state.currentIndex });
            state.currentIndex++;
        } else {
             events.push({ type: "content_block_stop", index: state.currentIndex });
             state.hasStartedText = false;
             state.currentIndex++;
        }
        
        events.push(
            { type: "message_delta", delta: { stop_reason: choice.finish_reason === "stop" ? "end_turn" : (choice.finish_reason === "tool_calls" ? "tool_use" : "max_tokens") }, usage: { output_tokens: 1 } },
            { type: "message_stop" }
        );
    }
    
    return events.length > 0 ? events : null;
}

function openAiToAnthropicResponse(openaiRes) {
    const choice = openaiRes.choices?.[0] || {};
    const message = choice.message || {};
    const contentArr = [];
    
    const reasoning = message.reasoning_content || message.reasoning;
    if (reasoning) {
        contentArr.push({
            type: "thinking",
            thinking: reasoning,
            signature: "ai8_internal"
        });
    }
    if (message.content) {
        contentArr.push({
            type: "text",
            text: message.content
        });
    }
    
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tool_call of message.tool_calls) {
            let inputArgs = {};
            try {
                inputArgs = JSON.parse(tool_call.function.arguments || "{}");
            } catch(e) {}
            contentArr.push({
                type: "tool_use",
                id: tool_call.id,
                name: tool_call.function.name,
                input: inputArgs
            });
        }
    }
    
    if (contentArr.length === 0) {
        contentArr.push({ type: "text", text: "" });
    }

    return {
        id: "msg_" + randomId(""),
        type: "message",
        role: "assistant",
        model: openaiRes.model,
        content: contentArr,
        stop_reason: choice.finish_reason === "stop" ? "end_turn" : (choice.finish_reason === "tool_calls" ? "tool_use" : "max_tokens"),
        stop_sequence: null,
        usage: {
            input_tokens: openaiRes.usage?.prompt_tokens || 0,
            output_tokens: openaiRes.usage?.completion_tokens || 0
        }
    };
}

module.exports = {
    anthropicToOpenAiRequest,
    openAiToAnthropicChunk,
    openAiToAnthropicResponse
};
