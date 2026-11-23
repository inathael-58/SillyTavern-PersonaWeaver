// Persona Weaver — sending one request to the API the user picked.
// 'main' is SillyTavern's current connection; any other id is a Connection Manager profile.
// There is no silent fallback to another API: index.js asks the user before every call,
// and the request goes exactly where the user agreed to send it.

import { splitThinking } from './core.js';

const ctx = () => SillyTavern.getContext();

/** Connection Manager profiles this SillyTavern can send to (empty when the extension is off). */
export function profiles() {
    try { return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { return []; }
}

/** A saved source id, or 'main' when the profile it named no longer exists. */
export function resolveSource(id) {
    if (!id || id === 'main') return 'main';
    return profiles().some(p => p.id === id) ? id : 'main';
}

/** What the main connection is right now, e.g. "openai · gpt-4o", for the label. */
export function mainDetail() {
    try {
        const c = ctx();
        const api = c.mainApi ?? '';
        let model = '';
        if (api === 'openai') {
            model = c.getChatCompletionModel?.() ?? '';
            const src = c.chatCompletionSettings?.chat_completion_source;
            return [src || api, model].filter(Boolean).join(' · ');
        }
        const status = String(c.onlineStatus ?? '');
        if (status && status !== 'no_connection') model = status;
        return [api, model].filter(Boolean).join(' · ');
    } catch { return ''; }
}

/**
 * Whether Weaver can switch thinking off for this source. Only DeepSeek profiles: SillyTavern
 * (since its DeepSeek V4 support, April 2026) sends DeepSeek `thinking: disabled` when include_reasoning is false.
 * Other providers read include_reasoning differently (some only hide the reasoning), and the
 * main connection takes no per-request override, so they keep what their preset says.
 * DeepSeek's own reasoning_effort cannot help: on v4-pro "low" is raised to "high".
 */
export function canSkipThinking(src) {
    if (!src || src === 'main') return false;
    const p = profiles().find(x => x.id === src);
    return String(p?.api ?? '').toLowerCase() === 'deepseek';
}

/** Human label for a source id. */
export function sourceLabel(id, mainText = 'SillyTavern main API') {
    if (id === 'main') {
        const d = mainDetail();
        return d ? `${mainText} (${d})` : mainText;
    }
    const p = profiles().find(x => x.id === id);
    if (!p) return mainText;
    const detail = [p.api, p.model].filter(Boolean).join(' · ');
    return detail ? `${p.name} (${detail})` : p.name;
}

/** All choices for a <select>: [{ id, label }]. */
export function sourceOptions(mainText) {
    return [
        { id: 'main', label: sourceLabel('main', mainText) },
        ...profiles().map(p => ({ id: p.id, label: sourceLabel(p.id, mainText) })),
    ];
}

/** Thrown when a thinking model spent the whole answer budget on its reasoning. */
export class ThinkingOnly extends Error {
    constructor(message, maxTokens) {
        super(message);
        this.name = 'ThinkingOnly';
        this.maxTokens = maxTokens;
    }
}

/**
 * Send one request. Throws on timeout, empty answer or API error, and ThinkingOnly when the
 * model sent back reasoning but no answer.
 * @param {string} src 'main' or a profile id
 * @param {{systemPrompt:string, prompt:string}} p
 * @param {number} maxTokens
 * @param {number} timeoutMs
 * @param {{timeout:(n:number)=>string, empty:string, thinking:(n:number)=>string, noProfiles:string}} msg error texts in the UI language
 * @param {{noThinking?:boolean}} [opts] noThinking: ask a source canSkipThinking() to answer without thinking
 */
export async function send(src, p, maxTokens, timeoutMs, msg, opts = {}) {
    const c = ctx();
    const seconds = Math.round(timeoutMs / 1000);
    let out;
    let reasoning = '';
    if (src === 'main') {
        let timer;
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg.timeout(seconds))), timeoutMs); });
        try {
            out = await Promise.race([
                c.generateRaw({ prompt: p.prompt, systemPrompt: p.systemPrompt, responseLength: maxTokens, trimNames: false }),
                timeout,
            ]);
        } finally { clearTimeout(timer); }
    } else {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error(msg.noProfiles);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const messages = [
            { role: 'system', content: p.systemPrompt },
            { role: 'user', content: p.prompt },
        ];
        try {
            // The last argument overrides the preset for this request only (ST ignores it where unsupported).
            const override = opts.noThinking && canSkipThinking(src) ? { include_reasoning: false } : {};
            const res = await svc.sendRequest(src, messages, maxTokens, { stream: false, signal: ac.signal, extractData: true, includePreset: true }, override);
            out = typeof res === 'string' ? res : String(res?.content ?? '');
            reasoning = typeof res === 'string' ? '' : String(res?.reasoning ?? '');
        } catch (e) {
            if (ac.signal.aborted) throw new Error(msg.timeout(seconds));
            throw e;
        } finally { clearTimeout(timer); }
    }
    const { text, thinking } = splitThinking(out, reasoning);
    if (!text.trim()) {
        if (thinking) throw new ThinkingOnly(msg.thinking(maxTokens), maxTokens);
        throw new Error(msg.empty);
    }
    return text;
}
