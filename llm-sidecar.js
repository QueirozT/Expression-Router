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

        // Custom / OpenAI-compatible: profile usually stores base (.../v1)
        // Direct fetch needs the full chat completions path.
        if (
            info.format === 'openai' &&
            !endpoint.endsWith('/chat/completions')
        ) {
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
    return !!resolveProfileConfig();
}

const THINK_RE = /<think[\s\S]*?<\/think>/gi;

export async function sidecarGenerate({ prompt, systemPrompt = '' }) {
    const config = resolveProfileConfig();
    if (!config) {
        throw new Error('No valid Connection Profile selected (needs API + model).');
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

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
    });

    if (!response.ok) {
        const err = await response.text().catch(() => '');
        throw new Error(`${provider} ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();

    const message = data.choices?.[0]?.message;
    if (!message) {
        // Surface useful debug for odd providers (Z.AI, etc.)
        const preview = JSON.stringify(data).slice(0, 300);
        throw new Error(`${provider} returned no message. Body: ${preview}`);
    }

    let content = message.content;

    // Some models return content as array of parts
    if (Array.isArray(content)) {
        content = content
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join('');
    }

    // Fallback: some Z.AI / reasoning models put text elsewhere
    if (!content || !String(content).trim()) {
        content =
            message.reasoning_content ||
            message.reasoning ||
            data.choices?.[0]?.text ||
            '';
    }

    if (!content || !String(content).trim()) {
        const preview = JSON.stringify(message).slice(0, 300);
        throw new Error(`${provider} empty content. Message: ${preview}`);
    }

    return String(content);
}
