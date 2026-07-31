// llm-sidecar.js
import { getContext } from '../../../st-context.js';
import { findConnectionProfile, getSettings } from './settings.js';

const MODULE = 'Expression Router';

let _secretKeyFailed = false;

const PROVIDER_MAP = {
    openai:      { format: 'openai',    endpoint: 'https://api.openai.com/v1/chat/completions',             secretKey: 'api_key_openai' },
    claude:      { format: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages',                  secretKey: 'api_key_claude' },
    openrouter:  { format: 'openai',    endpoint: 'https://openrouter.ai/api/v1/chat/completions',          secretKey: 'api_key_openrouter' },
    makersuite:  { format: 'google',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', secretKey: 'api_key_makersuite' },
    google:      { format: 'google',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', secretKey: 'api_key_makersuite' },
    deepseek:    { format: 'openai',    endpoint: 'https://api.deepseek.com/v1/chat/completions',           secretKey: 'api_key_deepseek' },
    mistralai:   { format: 'openai',    endpoint: 'https://api.mistral.ai/v1/chat/completions',             secretKey: 'api_key_mistralai' },
    custom:      { format: 'openai',    endpoint: null,                                                      secretKey: 'api_key_custom' },
    nanogpt:     { format: 'openai',    endpoint: 'https://nano-gpt.com/api/v1/chat/completions',           secretKey: 'api_key_nanogpt' },
    groq:        { format: 'openai',    endpoint: 'https://api.groq.com/openai/v1/chat/completions',        secretKey: 'api_key_groq' },
    chutes:      { format: 'openai',    endpoint: 'https://llm.chutes.ai/v1/chat/completions',              secretKey: 'api_key_chutes' },
    electronhub: { format: 'openai',    endpoint: 'https://api.electronhub.ai/v1/chat/completions',         secretKey: 'api_key_electronhub' },
    xai:         { format: 'openai',    endpoint: 'https://api.x.ai/v1/chat/completions',                   secretKey: 'api_key_xai' },
    zai:         { format: 'openai',    endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',          secretKey: 'api_key_zai' },
    zhipu:       { format: 'openai',    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',  secretKey: 'api_key_zai' },
};

function getProviderInfo(apiSource) {
    return PROVIDER_MAP[apiSource] || { format: 'openai', endpoint: null, secretKey: null };
}

async function fetchSecretKey(secretKey) {
    if (!secretKey || _secretKeyFailed) return null;

    try {
        const response = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ key: secretKey }),
        });

        if (!response.ok) {
            if (response.status === 403) {
                _secretKeyFailed = true;
                console.warn(`[${MODULE}] Secret key access DENIED (403). Set allowKeysExposure: true in config.yaml`);
            }
            return null;
        }

        const data = await response.json();
        return data.value || null;
    } catch (e) {
        console.error(`[${MODULE}] Error fetching secret key:`, e);
        return null;
    }
}

export function isSidecarKeyAvailable() {
    return !_secretKeyFailed;
}

function resolveProfileConfig() {
    const settings = getSettings();
    const profile = findConnectionProfile(settings.connectionProfile);
    if (!profile?.api || !profile?.model) return null;

    const info = getProviderInfo(profile.api);

    let endpoint =
        info.endpoint ||
        profile['api-url'] ||
        profile.api_url ||
        profile.url ||
        null;

    if (endpoint && typeof endpoint === 'string') {
        endpoint = endpoint.trim().replace(/\/+$/, '');

        // ST stores Custom base as .../v1 — direct fetch needs full path
        if (info.format === 'openai' && !endpoint.endsWith('/chat/completions')) {
            endpoint = endpoint + '/chat/completions';
        }
    }

    return {
        provider: profile.api,
        format: info.format,
        model: profile.model,
        endpoint,
        secretKey: info.secretKey,
    };
}

export function isSidecarConfigured() {
    if (_secretKeyFailed) return false;
    const settings = getSettings();
    if (!settings.connectionProfile) return false;
    // CMRS can work even if resolveProfileConfig is thin; still require a profile
    return true;
}

const THINK_RE = /<think[\s\S]*?<\/think>/gi;

/**
 * Main entry: try ST ConnectionManagerRequestService first (no CORS),
 * then fall back to direct browser fetch.
 */
export async function sidecarGenerate({ prompt, systemPrompt = '' }) {
    const settings = getSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) throw new Error('No Connection Profile selected.');

    // 1) Official ST path (server-side, no CORS)
    try {
        const ctx = getContext();
        const CMRS = ctx?.ConnectionManagerRequestService
            || window.ConnectionManagerRequestService
            || null;

        if (CMRS?.sendRequest) {
            const messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            messages.push({ role: 'user', content: prompt });

            const profile = findConnectionProfile(profileId);
            const isCustom = String(profile?.api || '').toLowerCase() === 'custom';

            const result = isCustom
                ? await CMRS.sendRequest(
                    profileId,
                    messages,
                    settings.maxTokens || 64,
                    {},
                    {
                        reasoning_effort: 'none',
                        disable_reasoning: true,
                    },
                )
                : await CMRS.sendRequest(
                    profileId,
                    messages,
                    settings.maxTokens || 64,
                    {},
                );

            const blocked = detectProviderBlock(result);

            if (blocked) {
                throw new Error(blocked);
            }

            if (settings.debugResponse) {
                console.log('[Expression Router] CMRS raw:', result);
            }

            const text = extractCmrsText(result);

            if (text) {
                return text.replace(THINK_RE, '').trim();
            }

            // content vazio (inclui reasoning-only) → tenta direct fetch
            console.warn('[Expression Router] CMRS returned empty content, trying direct fetch');
        } else {
            console.warn('[Expression Router] CMRS not available, using direct fetch');
        }
    } catch (e) {
        console.warn('[Expression Router] CMRS failed, falling back to direct fetch:', e);
    }

    // 2) Direct fetch (native providers / CORS-friendly)
    return await sidecarGenerateDirect({ prompt, systemPrompt });
}

/**
 * Normalize CMRS / ST response shapes into a plain string.
 * Only real content — never fall back to reasoning/thinking dumps.
 */
function extractCmrsText(result) {
    if (result == null) return '';

    if (typeof result === 'string') return result;

    const candidates = [
        result.content,
        result.message?.content,
        result.choices?.[0]?.message?.content,
        result.choices?.[0]?.text,
        result.extracted?.content,
        result.text,
    ];

    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
        if (Array.isArray(c)) {
            const joined = c
                .map(part => (typeof part === 'string' ? part : part?.text || ''))
                .join('');
            if (joined.trim()) return joined;
        }
    }

    // Diagnóstico: modelo devolveu só reasoning (disable_reasoning ignorado)
    const reasoning =
        result.reasoning ||
        result.message?.reasoning ||
        result.message?.reasoning_content ||
        result.choices?.[0]?.message?.reasoning_content ||
        result.choices?.[0]?.message?.reasoning ||
        '';
    if (typeof reasoning === 'string' && reasoning.trim()) {
        console.warn(
            '[Expression Router] Model returned reasoning-only (content empty). ' +
            'Treating as blank response.',
        );
    }

    return '';
}

function detectProviderBlock(result) {
    if (!result || typeof result !== 'object') return null;

    const finish =
        result.finish_reason ||
        result.choices?.[0]?.finish_reason ||
        result.choices?.[0]?.native_finish_reason ||
        '';

    if (/content_filter|safety|blocked/i.test(String(finish))) {
        return `Blocked by provider filter (finish_reason: ${finish}).`;
    }

    const err =
        result.error?.message ||
        result.error ||
        result.blockReason ||
        result.promptFeedback?.blockReason ||
        '';

    if (err && /filter|safety|blocked|policy|refus/i.test(String(err))) {
        return `Blocked by provider: ${String(err).slice(0, 160)}`;
    }

    return null;
}

async function sidecarGenerateDirect({ prompt, systemPrompt = '' }) {
    const config = resolveProfileConfig();
    if (!config) {
        throw new Error('No valid Connection Profile (needs API + model).');
    }

    const settings = getSettings();
    const temperature = settings.temperature ?? 0.2;
    const maxTokens = settings.maxTokens || 32;

    const { provider, format, model, endpoint, secretKey } = config;

    if (!endpoint) {
        throw new Error(`No endpoint for provider "${provider}". Set Server URL in the Connection Profile.`);
    }

    const apiKey = await fetchSecretKey(secretKey);
    if (!apiKey) {
        throw new Error(
            `No API key for "${provider}". Add the key in ST API settings and enable allowKeysExposure in config.yaml.`,
        );
    }

    if (settings.debugPrompt) {
        console.log('[Expression Router] Direct fetch →', provider, endpoint, model);
    }

    let result;
    if (format === 'anthropic') {
        result = await callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else if (format === 'google') {
        result = await callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else {
        result = await callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider });
    }

    return typeof result === 'string' ? result.replace(THINK_RE, '').trim() : '';
}

async function callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemPrompt || '',
            messages: [{ role: 'user', content: prompt }],
            temperature,
        }),
    });

    if (!response.ok) {
        const err = await response.text().catch(() => '');
        throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const block = data.content?.find(b => b.type === 'text');
    return block?.text || '';
}

async function callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const url = `${endpoint}/${model}:generateContent`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
    });

    if (!response.ok) {
        const err = await response.text().catch(() => '');
        throw new Error(`Google ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider }) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'Expression Router';
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    // Disable reasoning / thinking when the provider supports it (Cerebras GLM, etc.)
    const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        reasoning_effort: 'none',
        disable_reasoning: true,
    };

    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new Error(
            `Fetch failed for ${provider} → ${endpoint}. ` +
            `If this is Custom, ST should use CMRS (server-side). (${err?.message || err})`,
        );
    }

    if (!response.ok) {
        const err = await response.text().catch(() => '');
        // Some APIs reject unknown fields — retry once without reasoning flags
        if (response.status === 400 && /reasoning|thinking|disable_reasoning/i.test(err)) {
            delete body.reasoning_effort;
            delete body.disable_reasoning;
            response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const err2 = await response.text().catch(() => '');
                throw new Error(`${provider} ${response.status}: ${err2.slice(0, 200)}`);
            }
        } else {
            throw new Error(`${provider} ${response.status}: ${err.slice(0, 200)}`);
        }
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message) {
        throw new Error(`${provider} returned no message. Body: ${JSON.stringify(data).slice(0, 300)}`);
    }

    let content = message.content;
    if (Array.isArray(content)) {
        content = content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    }

    if (!content || !String(content).trim()) {
        const reasoningOnly = message.reasoning_content || message.reasoning || '';
        if (reasoningOnly && String(reasoningOnly).trim()) {
            throw new Error(
                'Model returned an empty response (reasoning only, no content). ' +
                'Disable reasoning on this model/profile or pick a non-reasoning model.',
            );
        }
        throw new Error(
            `${provider} empty content. Message: ${JSON.stringify(message).slice(0, 300)}`,
        );
    }

    return String(content);
}
