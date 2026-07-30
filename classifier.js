// classifier.js
import { getSettings, findConnectionProfile } from './settings.js';
import { getAvailableLabels, hasLabel, normalizeLabel } from './sprites.js';
import { setLastExpression } from './wrappers.js';
import { expandWrappers } from './wrappers.js';
import { sidecarGenerate, isSidecarConfigured } from './llm-sidecar.js';

export async function classifyExpression() {
    const settings = getSettings();
    if (!settings.enabled) return null;

    if (!isSidecarConfigured()) {
        console.warn('[Expression Router] No valid Connection Profile.');
        return null;
    }

    await getAvailableLabels();

    let prompt = await expandWrappers(settings.prompt || '');

    if (settings.debugPrompt) {
        console.log('[Expression Router] Prompt:\n', prompt);
    }

    let raw;
    try {
        raw = await sidecarGenerate({
            prompt,
            systemPrompt: 'Reply ONLY with one expression label from the list. No explanation.',
        });
    } catch (e) {
        console.error('[Expression Router] Generation error:', e);
        throw e;
    }

    if (settings.debugResponse) {
        console.log('[Expression Router] Raw response:', raw);
    }

    if (!raw) return null;

    const parsed = parseResponse(raw);
    if (!parsed) return null;

    if (hasLabel(parsed)) {
        setLastExpression(parsed);
        return parsed;
    }

    const normalized = normalizeLabel(parsed);
    if (normalized) {
        setLastExpression(normalized);
        return normalized;
    }

    console.warn('[Expression Router] Invalid expression (not in labels):', parsed);
    return null;
}

function parseResponse(text) {
    if (!text || typeof text !== 'string') return null;

    let cleaned = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .trim();

    // Try JSON { "expression": "..." }
    try {
        const json = JSON.parse(cleaned);
        if (json.expression) return String(json.expression).trim();
        if (json.label) return String(json.label).trim();
    } catch { /* not JSON */ }

    // First non-empty line, strip quotes
    const line = cleaned
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0);

    if (!line) return null;

    return line
        .replace(/^["'`]+/, '')
        .replace(/["'`]+$/, '')
        .trim();
}
