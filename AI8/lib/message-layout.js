"use strict";

function splitPreparedMessages(normalizedMessages, renderMessageText) {
    const systemPrompt = normalizedMessages
        .filter(message => message.role === "system" || message.role === "developer")
        .map(message => renderMessageText(message))
        .join("\n\n")
        .trim();

    let conversation = normalizedMessages.filter(message => !["system", "developer"].includes(message.role));
    let assistantPrompt = "";

    if (!systemPrompt && conversation.length >= 2 && conversation[0]?.role === "assistant") {
        assistantPrompt = renderMessageText(conversation[0]).trim();
        if (assistantPrompt) {
            conversation = conversation.slice(1);
        }
    }

    return {
        assistantPrompt,
        conversation,
        systemPrompt,
    };
}

module.exports = {
    splitPreparedMessages,
};
