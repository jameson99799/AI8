"use strict";

// One-shot verification: checks whether NVIDIA NIM models expose reasoning
// (thinking) through both OpenAI (/v1/chat/completions) and Anthropic
// (/v1/messages) formats via this adapter.
//
// Usage:
//   node verify-thinking.js [BASE_URL] [comma,separated,models] [API_KEY]
//   Examples:
//     node verify-thinking.js
//     node verify-thinking.js http://127.0.0.1:7865 stepfun-ai/step-3.7-flash,deepseek-ai/deepseek-v4-flash x9981509

const BASE = (process.argv[2] || "http://127.0.0.1:7865").replace(/\/+$/, "");
const MODELS_ARG = process.argv[3];
const MODELS = (
    MODELS_ARG ||
    [
        "stepfun-ai/step-3.7-flash",
        "deepseek-ai/deepseek-v4-flash",
        "deepseek-ai/deepseek-v4-pro",
        "minimaxai/minimax-m3",
        "z-ai/glm-5.1",
        "qwen/qwen3.5-122b-a10b",
    ].join(",")
)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
const API_KEY = process.argv[4] || "x9981509";
const REQUEST_TIMEOUT_MS = 60000;

async function openAiProbe(model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model,
                stream: true,
                messages: [{ role: "user", content: "9.11 和 9.8 哪个大？请简单回答。" }],
            }),
            signal: controller.signal,
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let sawReasoning = false;
        let sawText = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const line = block.split("\n").find(l => l.startsWith("data: "));
                if (!line) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta || {};
                    if ((typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
                        (typeof delta.reasoning === "string" && delta.reasoning)) sawReasoning = true;
                    if (typeof delta.content === "string" && delta.content) sawText = true;
                } catch (e) { /* skip */ }
            }
        }
        return { ok: true, sawReasoning, sawText };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        clearTimeout(timer);
    }
}

async function anthropicProbe(model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE}/v1/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`,
                "x-api-key": API_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                thinking: { type: "enabled", budget_tokens: 2048 },
                messages: [{ role: "user", content: "9.11 和 9.8 哪个大？请简单回答。" }],
                stream: true,
            }),
            signal: controller.signal,
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let sawThinking = false;
        let sawText = false;
        let sawToolUse = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = block.split("\n").find(l => l.startsWith("data: "));
                if (!dataLine) continue;
                try {
                    const parsed = JSON.parse(dataLine.slice(6).trim());
                    const t = parsed.type;
                    if (t === "content_block_start" && parsed.content_block?.type === "thinking") sawThinking = true;
                    if (t === "content_block_delta" && parsed.delta?.type === "thinking_delta") sawThinking = true;
                    if (t === "content_block_delta" && parsed.delta?.type === "text_delta") sawText = true;
                    if (t === "content_block_start" && parsed.content_block?.type === "tool_use") sawToolUse = true;
                } catch (e) { /* skip */ }
            }
        }
        return { ok: true, sawThinking, sawText, sawToolUse };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        clearTimeout(timer);
    }
}

(async () => {
    console.log(`BASE=${BASE}  KEY=${API_KEY.slice(0, 3)}***`);
    console.log(`Models: ${MODELS.length}`);
    console.log("");
    for (const model of MODELS) {
        const openAi = await openAiProbe(model);
        const anthropic = await anthropicProbe(model);
        const openAiStatus = !openAi.ok ? `ERROR ${openAi.error}` : (openAi.sawReasoning ? "REASONING" : (openAi.sawText ? "text-only" : "empty"));
        const anthropicStatus = !anthropic.ok ? `ERROR ${anthropic.error}` : (anthropic.sawThinking ? "THINKING" : (anthropic.sawText ? "text-only" : "empty"));
        console.log(`[${model}]`);
        console.log(`  OpenAI    : ${openAiStatus}`);
        console.log(`  Anthropic : ${anthropicStatus}`);
    }
    console.log("");
    console.log("DONE");
})();
