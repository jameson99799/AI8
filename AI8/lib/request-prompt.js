"use strict";

function resolvePreparedPrompt(preparedMessages) {
    const systemPrompt = normalizePrompt(preparedMessages?.systemPrompt);
    if (systemPrompt) {
        return {
            source: "messages.system_or_developer",
            value: systemPrompt,
        };
    }

    const assistantPrompt = normalizePrompt(preparedMessages?.assistantPrompt);
    if (assistantPrompt) {
        return {
            source: "messages.leading_assistant",
            value: assistantPrompt,
        };
    }

    return {
        source: "messages.system_or_developer",
        value: "",
    };
}

function resolveSessionPrompt(body, preparedMessages) {
    const directCandidates = [
        {
            source: "metadata.ai8_session_prompt",
            value: body?.metadata?.ai8_session_prompt,
        },
        {
            source: "metadata.session_prompt",
            value: body?.metadata?.session_prompt,
        },
        {
            source: "metadata.prompt",
            value: body?.metadata?.prompt,
        },
        {
            source: "instructions",
            value: body?.instructions,
        },
        {
            source: "prompt",
            value: body?.prompt,
        },
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizePrompt(candidate.value);
        if (normalized) {
            return {
                source: candidate.source,
                value: normalized,
            };
        }
    }

    return resolvePreparedPrompt(preparedMessages);
}

function normalizePrompt(value) {
    if (typeof value !== "string") {
        return "";
    }

    const text = extractEmbeddedRolePrompt(value.trim());
    return text || "";
}

function extractEmbeddedRolePrompt(text) {
    if (!text) {
        return "";
    }

    const normalizedText = text.replace(/\r\n/g, "\n");
    const activationMarker = "You are now activated. Await my input.";
    const activationIndex = normalizedText.lastIndexOf(activationMarker);
    const roleIndex = normalizedText.lastIndexOf("# Role:");

    if (roleIndex === -1) {
        return normalizedText.trim();
    }

    if (activationIndex !== -1 && roleIndex < activationIndex) {
        return normalizedText.slice(roleIndex, activationIndex + activationMarker.length).trim();
    }

    return normalizedText.slice(roleIndex).trim();
}

module.exports = {
    resolveSessionPrompt,
    resolvePreparedPrompt,
};
